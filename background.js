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
// Progress is published to chrome.storage.local.syncState for the popup.

importScripts('lib/dexie.min.js', 'db.js', 'api.js', 'pnl.js');

const ALARM_NAME = 'robux-pnl-autosync';
const RESUME_ALARM = 'robux-pnl-resume';
const AUTO_SYNC_MINUTES = 30;
const AUTO_MIN_GAP_MS = 2 * 60 * 1000;
const RATE_LIMIT_PAUSE_MINUTES = 5;

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
  if (msg?.type === 'RESET_DATA') {
    resetData(msg.userId).then(
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
async function runSync(mode) {
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

  const onRetry = ({ status, wait }) => {
    const secs = Math.ceil(wait / 1000);
    const message = status === 'quota'
      ? `Waiting ${secs}s for the Roblox request quota to refill`
      : `${status === 429 ? 'Rate limited (429)' : status ? `HTTP ${status}` : 'Network error'} – retrying in ${secs}s`;
    setState({ message });
  };

  // Start at the pace that worked last time instead of the 300 ms minimum.
  RobloxAPI.setPacing((await chrome.storage.local.get('apiPacing')).apiPacing);

  try {
    await setState({
      running: true, mode, phase: 'auth', error: null, errorCode: null, resumeAt: null,
      message: 'Checking Roblox login…', typeIndex: 0, typeCount: 0, typeProgress: 0, startedAt: Date.now()
    });

    const user = await RobloxAPI.getAuthenticatedUser({ onRetry });
    const { robux } = await RobloxAPI.getCurrency(user.id, { onRetry });
    const avatarUrl = await RobloxAPI.getAvatarUrl(user.id, { onRetry }).catch(() => null);

    await chrome.storage.local.set({
      account: { userId: user.id, name: user.name, displayName: user.displayName, avatarUrl, robux, balanceAt: Date.now() }
    });

    if (mode === 'deep') await DB.resetSyncMeta(user.id);

    const types = await activeTypes(user.id, onRetry);
    await setState({ typeCount: types.length });

    for (let i = 0; i < types.length; i++) {
      await setState({ phase: 'transactions', typeIndex: i, currentType: types[i] });
      await syncType(user.id, types[i], progress, onRetry, { index: i, total: types.length });
    }

    await setState({
      running: false, phase: 'done', lastSync: Date.now(), lastAdded: progress.added,
      typeIndex: types.length, typeProgress: 1, currentType: null,
      message: progress.added ? `${fmt(progress.added)} new transactions` : 'Up to date'
    });
  } catch (err) {
    if (err.code === 'RATE_LIMITED') {
      // Progress (incl. deep-scan cursors) is already saved – just come back later.
      const resumeAt = Date.now() + RATE_LIMIT_PAUSE_MINUTES * 60000;
      chrome.alarms.create(RESUME_ALARM, { when: resumeAt });
      const at = new Date(resumeAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      await setState({
        running: false, phase: 'paused', resumeAt, error: null, errorCode: err.code,
        message: `Roblox rate limit – paused, resuming automatically at ${at} (${fmt(progress.added)} new so far)`
      });
    } else {
      console.error('[Robux P&L] Sync failed', err);
      await setState({
        running: false, phase: 'error', error: err.message, errorCode: err.code || null,
        message: err.code === 'UNAUTHORIZED' ? 'Please log in on roblox.com' : `Error: ${err.message}`
      });
    }
  } finally {
    clearInterval(keepAlive);
    await chrome.storage.local.set({ apiPacing: RobloxAPI.getPacing() });
  }
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

async function syncType(userId, type, progress, onRetry, pos) {
  const meta = await DB.getSyncMeta(userId, type);
  if (meta.unsupported) return;

  const deep = !meta.deepDone;
  const label = PnL.TYPES[type].label;
  let cursor = deep ? meta.cursor : null;
  let pages = 0;

  for (;;) {
    let page;
    try {
      page = await RobloxAPI.getTransactionsPage(userId, type, cursor, { onRetry });
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
    let records = page.items.map((t) => DB.toRecord(userId, type, t)).filter(Boolean);
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
      fetched: progress.fetched,
      added: progress.added,
      typeProgress: (pos.index + (cursor ? 0.5 : 1)) / pos.total
    });

    if (reachedKnown || !cursor) break;
  }

  await DB.saveSyncMeta({ ...(await DB.getSyncMeta(userId, type)), lastSync: Date.now() });

  // Entries that arrived while a long deep scan was running sit above where it started.
  if (deep) await syncType(userId, type, progress, onRetry, pos);
}

async function resetData(userId) {
  if (activeSync) throw new Error('Not possible while a sync is running');
  if (userId) await DB.clearUser(userId);
  await setState({ phase: 'reset', lastSync: null, message: 'Local data deleted', error: null });
}
