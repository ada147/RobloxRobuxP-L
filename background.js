/* global importScripts, DB, RobloxAPI, PnL */
// Service worker: syncs Roblox transactions into IndexedDB.
//
// Per transaction type:
//  - Deep scan (first run): pages through the full history via nextPageCursor.
//    The cursor is persisted after every page, so a scan that gets interrupted
//    (worker shut down, browser closed, rate limit) resumes where it stopped.
//  - Incremental (afterwards): pages from the newest entry until it reaches a
//    transaction that is already stored and settled (not pending).
// Types the account has never used are skipped (one transaction-types request),
// which keeps the number of rate-limited transaction requests low.
// Groups the user owns are synced the same way, each under its own owner id.
// Progress is published to chrome.storage.local.syncState for the popup.

importScripts('lib/dexie.min.js', 'db.js', 'api.js', 'pnl.js');

const ALARM_NAME = 'robux-pnl-autosync';
const RESUME_ALARM = 'robux-pnl-resume';
const AUTO_SYNC_MINUTES = 30;
const AUTO_MIN_GAP_MS = 10 * 60 * 1000;
const RATE_LIMIT_PAUSE_MINUTES = 5;
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR'; // ECB reference rates, no key
const FX_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let activeSync = null;
let state = null;

async function loadState() {
  if (!state) state = (await chrome.storage.local.get('syncState')).syncState || {};
  return state;
}

async function setState(patch) {
  await loadState();
  state = { ...state, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ syncState: state });
}

const fmt = (n) => n.toLocaleString('en-US');

// A freshly started worker can't have a sync in flight, so a "running" flag
// in storage is left over from a worker that was shut down mid-sync.
loadState().then((s) => {
  if (s.running && !activeSync) {
    setState({ running: false, phase: 'interrupted', message: 'Sync interrupted – will continue with the next sync' });
  }
});

function scheduleAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: AUTO_SYNC_MINUTES, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { scheduleAlarm(); runSync('auto'); });
chrome.runtime.onStartup.addListener(() => { scheduleAlarm(); runSync('auto'); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runSync('auto');
  if (alarm.name === RESUME_ALARM) runSync('incremental');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SYNC') {
    runSync(msg.mode || 'incremental');
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?view=tab') });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'QUICK_PNL') {
    quickPnl().then(sendResponse, () => sendResponse(null));
    return true; // async response
  }
  if (msg?.type === 'RESET_DATA') {
    resetData(msg.ownerId).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true; // async response
  }
});

/**
 * mode: 'auto'        – skipped if the last sync was very recent or we're backing off
 *       'incremental' – fetch new entries (and resume unfinished deep scans)
 *       'deep'        – forget sync progress and re-scan the whole history
 */
async function refreshFx() {
  const { fx } = await chrome.storage.local.get('fx');
  if (fx && Date.now() - fx.updatedAt < FX_MAX_AGE_MS) return;
  try {
    const res = await fetch(FX_URL);
    const json = await res.json();
    const rate = Number(json?.rates?.EUR);
    if (rate > 0) await chrome.storage.local.set({ fx: { usdToEur: rate, date: json.date, updatedAt: Date.now() } });
  } catch (err) {
    console.warn('[Robux P&L] Exchange rate update failed', err);
  }
}

async function runSync(mode) {
  refreshFx();
  if (activeSync) return activeSync;
  if (mode === 'auto') {
    const s = await loadState();
    if (s.lastSync && Date.now() - s.lastSync < AUTO_MIN_GAP_MS) return;
    // Don't knock on Roblox's door again while we're backing off from a rate limit.
    if (s.phase === 'paused' && s.resumeAt > Date.now()) return;
  }
  chrome.alarms.clear(RESUME_ALARM);
  activeSync = doSync(mode).finally(() => { activeSync = null; });
  return activeSync;
}

async function doSync(mode) {
  // Extension API calls reset the worker's idle timer; keep it alive during long scans.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const progress = { fetched: 0, added: 0 };

  // The popup counts down to waitUntil itself; message is the static fallback.
  const onRetry = ({ status, wait }) => {
    const waitReason = status === 'quota' ? 'quota'
      : status === 429 ? 'Rate limited (429)' : status ? `HTTP ${status}` : 'Network error';
    const message = waitReason === 'quota'
      ? 'Waiting for the Roblox request quota to refill'
      : `${waitReason} – retrying shortly`;
    setState({ message, waitUntil: Date.now() + wait, waitReason });
  };

  // Start at the pace that worked last time instead of the 300 ms minimum.
  RobloxAPI.setPacing((await chrome.storage.local.get('apiPacing')).apiPacing);

  try {
    await setState({
      running: true, mode, phase: 'auth', error: null, errorCode: null, resumeAt: null, waitUntil: null,
      message: 'Checking Roblox login…', typeIndex: 0, typeCount: 0, typeProgress: 0, startedAt: Date.now()
    });

    const user = await RobloxAPI.getAuthenticatedUser({ onRetry });
    const { robux } = await RobloxAPI.getCurrency(user.id, { onRetry });
    const avatarUrl = await RobloxAPI.getAvatarUrl(user.id, { onRetry }).catch(() => null);

    await chrome.storage.local.set({
      account: { userId: user.id, name: user.name, displayName: user.displayName, avatarUrl, robux, balanceAt: Date.now() }
    });

    const groups = await loadOwnedGroups(user, onRetry);

    // One work list across the user and every group the user owns.
    const accounts = [{
      ownerId: user.id,
      prefix: '',
      types: await activeTypes(user.id, onRetry),
      fetchPage: (type, cursor, opts) => RobloxAPI.getTransactionsPage(user.id, type, cursor, opts)
    }];
    for (const g of groups.filter((x) => x.access)) {
      accounts.push({
        ownerId: DB.ownerOfGroup(g.groupId),
        prefix: `${g.name} · `,
        types: PnL.GROUP_TYPES,
        fetchPage: (type, cursor, opts) => RobloxAPI.getGroupTransactionsPage(g.groupId, type, cursor, opts),
        group: g
      });
    }
    const total = accounts.reduce((n, a) => n + a.types.length, 0);
    await setState({ typeCount: total });

    let step = 0;
    for (const acct of accounts) {
      if (mode === 'deep') await DB.resetSyncMeta(acct.ownerId);
      try {
        for (const type of acct.types) {
          await setState({ phase: 'transactions', typeIndex: step, currentType: type });
          await syncType(acct, type, progress, onRetry, { index: step++, total });
        }
      } catch (err) {
        if (!acct.group || err.code !== 'FORBIDDEN') throw err;
        // Lost access to this group's finances – keep its old data, skip it.
        acct.group.access = false;
        await chrome.storage.local.set({ groups });
      }
    }

    await setState({
      running: false, phase: 'done', lastSync: Date.now(), lastAdded: progress.added, waitUntil: null,
      typeIndex: total, typeProgress: 1, currentType: null,
      message: progress.added ? `${fmt(progress.added)} new transaction${progress.added === 1 ? '' : 's'}` : 'Up to date'
    });
  } catch (err) {
    if (err.code === 'RATE_LIMITED') {
      // Progress (incl. deep-scan cursors) is already saved – just come back later.
      const resumeAt = Date.now() + RATE_LIMIT_PAUSE_MINUTES * 60000;
      chrome.alarms.create(RESUME_ALARM, { when: resumeAt });
      const at = new Date(resumeAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      await setState({
        running: false, phase: 'paused', resumeAt, waitUntil: null, error: null, errorCode: err.code,
        message: `Roblox rate limit – paused, resuming automatically at ${at} (${fmt(progress.added)} new so far)`
      });
    } else {
      console.error('[Robux P&L] Sync failed', err);
      await setState({
        running: false, phase: 'error', waitUntil: null, error: err.message, errorCode: err.code || null,
        message: err.code === 'UNAUTHORIZED' ? 'Please log in on roblox.com' : `Error: ${err.message}`
      });
    }
  } finally {
    clearInterval(keepAlive);
    await chrome.storage.local.set({ apiPacing: RobloxAPI.getPacing() });
  }
}

/**
 * Groups the user owns (rank 255), with funds and icon, saved to storage for the
 * account switcher. access=false when Roblox refuses to show the group's finances.
 * If the group list can't be loaded, the previously stored list is kept.
 */
async function loadOwnedGroups(user, onRetry) {
  const previous = (await chrome.storage.local.get('groups')).groups || [];
  let memberships;
  try {
    memberships = await RobloxAPI.getUserGroups(user.id, { onRetry });
  } catch (err) {
    if (err.code === 'RATE_LIMITED') throw err;
    console.warn('[Robux P&L] Could not load groups', err);
    return previous;
  }

  const owned = memberships.filter((m) => m.role?.rank === 255 || m.group?.owner?.userId === user.id);
  const icons = await RobloxAPI.getGroupIcons(owned.map((m) => m.group.id), { onRetry }).catch(() => new Map());

  const groups = [];
  for (const m of owned) {
    const g = {
      groupId: m.group.id, name: m.group.name, role: m.role?.name || 'Owner',
      iconUrl: icons.get(m.group.id) || null, robux: null, balanceAt: null, access: true
    };
    try {
      g.robux = (await RobloxAPI.getGroupCurrency(g.groupId, { onRetry })).robux;
      g.balanceAt = Date.now();
    } catch (err) {
      if (err.code !== 'FORBIDDEN') throw err;
      g.access = false;
    }
    groups.push(g);
  }
  await chrome.storage.local.set({ groups });
  return groups;
}

/**
 * One request tells us which transaction types the account has at all
 * (HasSale, HasPurchase, …). Types flagged false are skipped; types the
 * response doesn't mention are still queried. Falls back to all types.
 */
async function activeTypes(userId, onRetry) {
  const all = Object.keys(PnL.TYPES);
  let flags;
  try {
    flags = await RobloxAPI.getTransactionTypes(userId, { onRetry });
  } catch (err) {
    if (err.code === 'RATE_LIMITED' || err.code === 'UNAUTHORIZED') throw err;
    return all;
  }
  const has = new Map();
  for (const [key, value] of Object.entries(flags || {})) {
    const m = /^has(.+)$/i.exec(key);
    if (m && typeof value === 'boolean') has.set(m[1].toLowerCase(), value);
  }
  return all.filter((type) => has.get(type.toLowerCase()) !== false);
}

/** acct: { ownerId, prefix, fetchPage(type, cursor, opts) } – the user or one of their groups. */
async function syncType(acct, type, progress, onRetry, pos) {
  const { ownerId } = acct;
  const meta = await DB.getSyncMeta(ownerId, type);
  if (meta.unsupported) return;

  const deep = !meta.deepDone;
  const label = acct.prefix + PnL.defOf({ type, scope: ownerId < 0 ? 'group' : 'user' }).label;
  let cursor = deep ? meta.cursor : null;
  let pages = 0;

  for (;;) {
    let page;
    try {
      page = await acct.fetchPage(type, cursor, { onRetry });
    } catch (err) {
      if (err.status === 400 && !cursor) {
        // This account/API doesn't accept the type – remember and skip it.
        await DB.saveSyncMeta({ ...meta, unsupported: true, deepDone: true, cursor: null });
        return;
      }
      if (err.status === 400 && cursor && deep) {
        // Saved cursor expired; restart this type's deep scan from the top.
        cursor = null;
        continue;
      }
      throw err;
    }

    pages++;
    let records = page.items.map((t) => DB.toRecord(ownerId, type, t)).filter(Boolean);
    const existing = await DB.getByKeys(records.map((r) => r.key));
    let reachedKnown = false;

    if (!deep) {
      // Everything before the first stored, settled entry is new or was pending last time.
      const stopAt = existing.findIndex((e) => e && !e.isPending);
      if (stopAt !== -1) {
        records = records.slice(0, stopAt);
        reachedKnown = true;
      }
    }

    await DB.putTransactions(records);
    progress.added += records.filter((_, i) => !existing[i]).length;
    progress.fetched += records.length;
    cursor = page.nextCursor;

    if (deep) await DB.saveSyncMeta({ ...meta, cursor, deepDone: !cursor });

    await setState({
      message: `${deep ? 'Deep scan' : 'Sync'} · ${label} · page ${pages} · ${fmt(progress.fetched)} loaded`,
      waitUntil: null,
      fetched: progress.fetched,
      added: progress.added,
      typeProgress: (pos.index + (cursor ? 0.5 : 1)) / pos.total
    });

    if (reachedKnown || !cursor) break;
  }

  await DB.saveSyncMeta({ ...(await DB.getSyncMeta(ownerId, type)), lastSync: Date.now() });

  // Entries that arrived while a long deep scan was running sit above where it started.
  if (deep) await syncType(acct, type, progress, onRetry, pos);
}

/** Net P&L of the user's last 24 hours – for the tooltip on the roblox.com navbar button. */
async function quickPnl() {
  const { account, settings } = await chrome.storage.local.get(['account', 'settings']);
  if (!account) return null;
  const now = Date.now();
  const m = PnL.summarize(await DB.getRange(account.userId, now - 864e5, now), settings);
  return { netPnl: m.netPnl, count: m.count };
}

/** ownerId: the user's id or -groupId (see db.js). */
async function resetData(ownerId) {
  if (activeSync) throw new Error('Not possible while a sync is running');
  if (ownerId) await DB.clearUser(ownerId);
  await setState({ phase: 'reset', lastSync: null, message: 'Local data deleted', error: null });
}
