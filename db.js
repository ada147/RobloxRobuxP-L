/* global Dexie */
// IndexedDB storage via Dexie. Loaded by both the service worker (importScripts)
// and the popup – they share the extension origin and therefore the same database.

const db = new Dexie('RobloxPnL');

db.version(1).stores({
  // key = idHash from the API (stable, unique) or a composite fallback.
  // created = epoch ms, so range queries on [userId+created] stay numeric.
  transactions: 'key, userId, type, created, [userId+created], [userId+type]',
  // Sync progress per user and transaction type:
  // { key: "<userId>:<type>", userId, type, deepDone, cursor, unsupported, lastSync }
  syncMeta: 'key, userId'
});

const DB = {
  /** Normalises a raw API transaction into the record we store. */
  toRecord(userId, type, t) {
    const created = Date.parse(t.created);
    if (!Number.isFinite(created)) return null;
    return {
      key: t.idHash || `${type}:${t.id}:${t.created}`,
      userId,
      type,                                   // the type we queried for (used for classification)
      apiType: t.transactionType || type,     // what the API itself reports
      created,
      isPending: Boolean(t.isPending),
      amount: Number(t.currency?.amount) || 0,
      currency: t.currency?.type || 'Robux',
      agentId: t.agent?.id ?? null,
      agentType: t.agent?.type || '',
      agentName: t.agent?.name || '',
      itemId: t.details?.id ?? null,
      itemType: t.details?.type || '',
      itemName: t.details?.name || '',
      placeName: t.details?.place?.name || ''
    };
  },

  getByKeys(keys) {
    return db.transactions.bulkGet(keys);
  },

  putTransactions(records) {
    return records.length ? db.transactions.bulkPut(records) : Promise.resolve();
  },

  /** All transactions of a user with from <= created <= to, oldest first. */
  getRange(userId, from, to) {
    return db.transactions
      .where('[userId+created]')
      .between([userId, from], [userId, to], true, true)
      .toArray();
  },

  getAll(userId) {
    return db.transactions
      .where('[userId+created]')
      .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
      .reverse()
      .toArray();
  },

  async getFirstTimestamp(userId) {
    const first = await db.transactions
      .where('[userId+created]')
      .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
      .first();
    return first ? first.created : null;
  },

  count(userId) {
    return db.transactions.where('userId').equals(userId).count();
  },

  async getSyncMeta(userId, type) {
    const key = `${userId}:${type}`;
    return (await db.syncMeta.get(key)) ||
      { key, userId, type, deepDone: false, cursor: null, unsupported: false, lastSync: null };
  },

  saveSyncMeta(meta) {
    return db.syncMeta.put(meta);
  },

  /** Forgets sync progress so the next run does a full deep scan again. */
  resetSyncMeta(userId) {
    return db.syncMeta.where('userId').equals(userId).delete();
  },

  clearUser(userId) {
    return db.transaction('rw', db.transactions, db.syncMeta, async () => {
      await db.transactions.where('userId').equals(userId).delete();
      await db.syncMeta.where('userId').equals(userId).delete();
    });
  }
};
