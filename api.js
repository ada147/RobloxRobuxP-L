// Roblox web API client. Requests run with the user's roblox.com session cookie
// (credentials: 'include' + host_permissions).
//
// Pacing is tracked per host ("lane"), since Roblox limits each API separately.
// Roblox's limits are "N requests per time window", so instead of blindly
// backing off, each lane *learns* its budget:
//  - on a 429 we count how many requests went through in the last 60 s and
//    set the budget a bit below that; from then on requests are spread evenly
//    (60 s / budget) and never exceed the budget in any rolling 60 s window;
//  - the learned budget is persisted, so later syncs start at a safe pace;
//  - after a long run without 429 the budget is raised by one, but never
//    back to the rate that was limited;
//  - x-ratelimit-remaining / x-ratelimit-reset and Retry-After are honoured;
//  - if Roblox keeps limiting, a RATE_LIMITED error lets the caller pause.

const RobloxAPI = (() => {
  const MIN_DELAY_MS = 300;
  const WINDOW_MS = 60000;
  const MAX_RETRIES = 5;
  const PROBE_AFTER = 150;     // successes in a row before trying budget + 1
  const MIN_SAMPLE = 5;        // fewer requests in the window than this say nothing about the limit
  const PAGE_LIMIT = 100;      // allowed values: 10, 25, 50, 100

  class ApiError extends Error {
    constructor(message, status, code, body = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const backoff = (attempt) => Math.min(120000, 5000 * 2 ** attempt) + Math.random() * 1000;

  // Header values can look like "10" or "10, 100;w=60" – the first number is what counts.
  const headerNumber = (res, name) => {
    const raw = res.headers.get(name);
    return raw == null ? NaN : parseFloat(raw);
  };

  const lanes = new Map();

  function laneFor(url) {
    const host = new URL(url).hostname;
    if (!lanes.has(host)) {
      lanes.set(host, {
        host,
        budget: null,     // learned requests per WINDOW_MS (null = no limit seen yet)
        ceiling: null,    // budget at which we last got limited – never probe back up to it
        okStreak: 0,
        sent: [],         // timestamps of recent requests
        lastRequestAt: 0,
        notBefore: 0,
        queue: Promise.resolve()
      });
    }
    return lanes.get(host);
  }

  const spacing = (lane) => (lane.budget ? Math.max(MIN_DELAY_MS, WINDOW_MS / lane.budget) : MIN_DELAY_MS);

  function windowWait(lane, now) {
    lane.sent = lane.sent.filter((t) => t > now - WINDOW_MS);
    if (!lane.budget || lane.sent.length < lane.budget) return 0;
    return lane.sent[lane.sent.length - lane.budget] + WINDOW_MS - now;
  }

  // Requests within a lane are serialised through a promise chain so
  // concurrent callers still respect the pacing.
  function throttle(lane, onRetry) {
    const slot = lane.queue.then(async () => {
      const now = Date.now();
      const wait = Math.max(lane.lastRequestAt + spacing(lane) - now, lane.notBefore - now, windowWait(lane, now), 0);
      if (wait > 2000) onRetry?.({ status: 'quota', wait, attempt: 0 });
      if (wait > 0) await sleep(wait);
      lane.lastRequestAt = Date.now();
      lane.sent.push(lane.lastRequestAt);
    });
    lane.queue = slot.catch(() => {});
    return slot;
  }

  function readQuota(lane, res) {
    const remaining = headerNumber(res, 'x-ratelimit-remaining');
    const reset = headerNumber(res, 'x-ratelimit-reset');
    if (remaining <= 1 && reset > 0) lane.notBefore = Date.now() + reset * 1000 + 250;
  }

  function onRateLimited(lane, res) {
    const now = Date.now();
    lane.okStreak = 0;
    const inWindow = lane.sent.filter((t) => t > now - WINDOW_MS).length;
    if (inWindow >= MIN_SAMPLE) {
      // The request that just failed was one too many – stay comfortably below.
      const learned = Math.max(1, Math.floor((inWindow - 1) * 0.85));
      lane.budget = lane.budget ? Math.min(lane.budget - 1, learned) : learned;
    } else if (lane.budget) {
      lane.budget = Math.max(1, lane.budget - 1);
    }
    if (lane.budget) lane.ceiling = lane.budget + 1;

    const reset = headerNumber(res, 'x-ratelimit-reset');
    if (reset > 0) lane.notBefore = now + reset * 1000 + 250;
  }

  function onSuccess(lane) {
    if (!lane.budget || ++lane.okStreak < PROBE_AFTER) return;
    lane.okStreak = 0;
    if (!lane.ceiling || lane.budget + 1 < lane.ceiling) lane.budget++;
  }

  /** Learned pacing per host – persisted by the worker so the next run starts at a safe pace. */
  function getPacing() {
    return Object.fromEntries([...lanes.values()].map((l) => [l.host, { budget: l.budget, ceiling: l.ceiling }]));
  }

  function setPacing(pacing) {
    for (const [host, p] of Object.entries(pacing || {})) {
      if (!p || typeof p !== 'object') continue; // ignore the older numeric format
      const lane = laneFor(`https://${host}/`);
      if (Number.isFinite(p.budget) && p.budget > 0) lane.budget = p.budget;
      if (Number.isFinite(p.ceiling) && p.ceiling > 0) lane.ceiling = p.ceiling;
    }
  }

  async function getJson(url, { onRetry } = {}) {
    const lane = laneFor(url);
    for (let attempt = 0; ; attempt++) {
      await throttle(lane, onRetry);

      let res;
      try {
        res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw new ApiError(`Network error: ${err.message}`, 0, 'NETWORK');
        const wait = backoff(attempt);
        onRetry?.({ status: 0, wait, attempt });
        await sleep(wait);
        continue;
      }

      if (res.ok) {
        readQuota(lane, res);
        onSuccess(lane);
        return res.json();
      }

      if (res.status === 401) {
        throw new ApiError('Not logged in on roblox.com', res.status, 'UNAUTHORIZED');
      }
      if (res.status === 403) {
        // Logged in, but not allowed to see this resource (e.g. another group's finances).
        throw new ApiError('Access denied', res.status, 'FORBIDDEN');
      }

      if (res.status === 429 || res.status >= 500) {
        if (res.status === 429) onRateLimited(lane, res);
        if (attempt >= MAX_RETRIES) {
          throw new ApiError(
            `HTTP ${res.status} after ${MAX_RETRIES} retries`,
            res.status,
            res.status === 429 ? 'RATE_LIMITED' : 'RETRY_EXHAUSTED'
          );
        }
        // With a learned budget the throttle already waits until the window has
        // room again; the backoff only covers limits we couldn't measure.
        const retryAfter = headerNumber(res, 'Retry-After');
        const now = Date.now();
        const wait = Math.max(
          retryAfter > 0 ? retryAfter * 1000 + Math.random() * 1000 : 0,
          lane.notBefore - now,
          windowWait(lane, now),
          lane.budget && res.status === 429 && attempt === 0 ? 2000 : backoff(attempt)
        );
        onRetry?.({ status: res.status, wait, attempt });
        await sleep(wait);
        continue;
      }

      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      throw new ApiError(`HTTP ${res.status}`, res.status, 'HTTP', body);
    }
  }

  /** { id, name, displayName } of the logged-in user. */
  function getAuthenticatedUser(opts) {
    return getJson('https://users.roblox.com/v1/users/authenticated', opts);
  }

  /** { robux } – live balance. */
  function getCurrency(userId, opts) {
    return getJson(`https://economy.roblox.com/v1/users/${userId}/currency`, opts);
  }

  /** Flags like { HasSale: true, HasPurchase: false, … } – which types the account has at all. */
  function getTransactionTypes(userId, opts) {
    return getJson(`https://economy.roblox.com/v2/users/${userId}/transaction-types`, opts);
  }

  async function getAvatarUrl(userId, opts) {
    const json = await getJson(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
      opts
    );
    return json.data?.[0]?.imageUrl || null;
  }

  async function transactionsPage(base, transactionType, cursor, opts) {
    const url = new URL(`${base}/transactions`);
    url.searchParams.set('transactionType', transactionType);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);

    const json = await getJson(url.toString(), opts);
    return { items: json.data || [], nextCursor: json.nextPageCursor || null };
  }

  /** One page of a user's transactions, newest first. */
  function getTransactionsPage(userId, transactionType, cursor, opts) {
    return transactionsPage(`https://economy.roblox.com/v2/users/${userId}`, transactionType, cursor, opts);
  }

  // ---- groups

  /** [{ group: { id, name, owner }, role: { name, rank } }] – every group the user is in. */
  async function getUserGroups(userId, opts) {
    const json = await getJson(`https://groups.roblox.com/v1/users/${userId}/groups/roles`, opts);
    return json.data || [];
  }

  /** { robux } – group funds. 403 unless the user may view the group's finances. */
  function getGroupCurrency(groupId, opts) {
    return getJson(`https://economy.roblox.com/v1/groups/${groupId}/currency`, opts);
  }

  /** One page of a group's transactions, newest first. */
  function getGroupTransactionsPage(groupId, transactionType, cursor, opts) {
    return transactionsPage(`https://economy.roblox.com/v2/groups/${groupId}`, transactionType, cursor, opts);
  }

  /** Map groupId -> icon URL. */
  async function getGroupIcons(groupIds, opts) {
    if (!groupIds.length) return new Map();
    const json = await getJson(
      `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${groupIds.join(',')}&size=150x150&format=Png&isCircular=false`,
      opts
    );
    return new Map((json.data || []).map((d) => [d.targetId, d.imageUrl]));
  }

  return {
    ApiError, getAuthenticatedUser, getCurrency, getTransactionTypes, getAvatarUrl, getTransactionsPage,
    getUserGroups, getGroupCurrency, getGroupTransactionsPage, getGroupIcons,
    getPacing, setPacing
  };
})();
