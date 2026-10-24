// Roblox web API client. Requests run with the user's roblox.com session cookie
// (credentials: 'include' + host_permissions).
//
// Pacing is tracked per host ("lane"), since Roblox limits each API separately:
//  - requests in a lane are spaced at least MIN_DELAY_MS apart;
//  - x-ratelimit-remaining / x-ratelimit-reset headers are honoured up front,
//    so we wait for the quota to refill instead of running into a 429;
//  - every 429 doubles the lane's spacing, a run of successes lowers it again;
//  - 429 / 5xx / network errors are retried with exponential backoff; if Roblox
//    keeps limiting, a RATE_LIMITED error lets the caller pause and resume later.

const RobloxAPI = (() => {
  const MIN_DELAY_MS = 300;
  const MAX_DELAY_MS = 15000;
  const MAX_RETRIES = 5;
  const BACKOFF_BASE_MS = 5000;
  const BACKOFF_MAX_MS = 120000;
  const PAGE_LIMIT = 100; // allowed values: 10, 25, 50, 100

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
  const backoff = (attempt) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt) + Math.random() * 1000;

  // Header values can look like "10" or "10, 100;w=60" – the first number is what counts.
  const headerNumber = (res, name) => {
    const raw = res.headers.get(name);
    return raw == null ? NaN : parseFloat(raw);
  };

  const lanes = new Map();

  function laneFor(url) {
    const host = new URL(url).hostname;
    if (!lanes.has(host)) {
      lanes.set(host, { host, delayMs: MIN_DELAY_MS, okStreak: 0, lastRequestAt: 0, notBefore: 0, queue: Promise.resolve() });
    }
    return lanes.get(host);
  }

  // Requests within a lane are serialised through a promise chain so
  // concurrent callers still respect the spacing.
  function throttle(lane, onRetry) {
    const slot = lane.queue.then(async () => {
      const wait = Math.max(lane.lastRequestAt + lane.delayMs, lane.notBefore) - Date.now();
      if (wait > 2000) onRetry?.({ status: 'quota', wait, attempt: 0 });
      if (wait > 0) await sleep(wait);
      lane.lastRequestAt = Date.now();
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
    lane.okStreak = 0;
    lane.delayMs = Math.min(MAX_DELAY_MS, lane.delayMs * 2);
    const reset = headerNumber(res, 'x-ratelimit-reset');
    if (reset > 0) lane.notBefore = Date.now() + reset * 1000 + 250;
  }

  function onSuccess(lane) {
    if (++lane.okStreak >= 20 && lane.delayMs > MIN_DELAY_MS) {
      lane.okStreak = 0;
      lane.delayMs = Math.max(MIN_DELAY_MS, Math.round(lane.delayMs * 0.8));
    }
  }

  /** Learned spacing per host – persisted by the worker so the next run starts at a safe pace. */
  function getPacing() {
    return Object.fromEntries([...lanes.values()].map((l) => [l.host, l.delayMs]));
  }

  function setPacing(pacing) {
    for (const [host, ms] of Object.entries(pacing || {})) {
      if (Number.isFinite(ms)) laneFor(`https://${host}/`).delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, ms));
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

      if (res.status === 401 || res.status === 403) {
        throw new ApiError('Not logged in on roblox.com', res.status, 'UNAUTHORIZED');
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
        const retryAfter = headerNumber(res, 'Retry-After');
        const wait = Math.max(
          retryAfter > 0 ? retryAfter * 1000 + Math.random() * 1000 : backoff(attempt),
          lane.notBefore - Date.now()
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
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=48x48&format=Png&isCircular=false`,
      opts
    );
    return json.data?.[0]?.imageUrl || null;
  }

  /** One page of transactions, newest first. */
  async function getTransactionsPage(userId, transactionType, cursor, opts) {
    const url = new URL(`https://economy.roblox.com/v2/users/${userId}/transactions`);
    url.searchParams.set('transactionType', transactionType);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);

    const json = await getJson(url.toString(), opts);
    return { items: json.data || [], nextCursor: json.nextPageCursor || null };
  }

  return {
    ApiError, getAuthenticatedUser, getCurrency, getTransactionTypes, getAvatarUrl, getTransactionsPage,
    getPacing, setPacing
  };
})();
