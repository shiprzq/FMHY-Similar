/**
 * Storage layer.
 *
 * Areas:
 *   sync  -> settings, favorites   (small, roams with the profile, survives reinstall)
 *   local -> resource database, recently viewed, update log (large, device-local)
 *
 * The database is chunked across `local` keys so it can grow past any single
 * item-size limit and be written/read incrementally.
 *
 * Nothing here ever records a browsing history: only resources the user
 * explicitly interacts with (favorite / open) are stored, and "recently
 * viewed" is capped and can be cleared.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const B = FMHYS.browser;

  const KEYS = {
    settings: 'fmhys:settings',
    favorites: 'fmhys:favorites',
    recent: 'fmhys:recent',
    dbMeta: 'fmhys:db:meta',
    dbChunkPrefix: 'fmhys:db:chunk:',
    dbBackupMeta: 'fmhys:db:backup:meta',
    dbBackupChunkPrefix: 'fmhys:db:backup:chunk:',
    updateLog: 'fmhys:db:log'
  };

  const CHUNK_SIZE = 1000;      // packed rows per storage item
  const RECENT_LIMIT = 50;

  const DEFAULT_SETTINGS = {
    enabled: true,
    showIndicators: true,
    showFavoriteButtons: true,
    dblClickFindSimilar: true,
    showSimilarButton: 'auto',   // 'auto' | 'always' | 'never'
    maxAlternatives: 5,          // fixed at 5 by product requirement
    animations: true,
    theme: 'system',             // 'system' | 'light' | 'dark'
    compactUi: 'auto',           // 'auto' | 'compact' | 'comfortable'
    trackRecentlyViewed: true,
    autoUpdateDatabase: false,   // opt-in; off by default
    minSimilarity: 28
  };

  function clampSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return s;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!(k in raw)) continue;
      const def = DEFAULT_SETTINGS[k];
      const v = raw[k];
      if (typeof def === 'boolean' && typeof v === 'boolean') s[k] = v;
      else if (typeof def === 'number' && typeof v === 'number' && isFinite(v)) s[k] = v;
      else if (typeof def === 'string' && typeof v === 'string') s[k] = v;
    }
    s.maxAlternatives = 5; // hard requirement, not user-editable
    if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
    if (!['auto', 'always', 'never'].includes(s.showSimilarButton)) s.showSimilarButton = 'auto';
    if (!['auto', 'compact', 'comfortable'].includes(s.compactUi)) s.compactUi = 'auto';
    s.minSimilarity = Math.max(0, Math.min(90, Math.round(s.minSimilarity)));
    return s;
  }

  // ------------------------------------------------------------- settings

  async function getSettings() {
    const data = await B.storage.get('sync', KEYS.settings);
    return clampSettings(data[KEYS.settings]);
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = clampSettings(Object.assign({}, current, patch || {}));
    await B.storage.set('sync', { [KEYS.settings]: next });
    return next;
  }

  async function resetSettings() {
    await B.storage.set('sync', { [KEYS.settings]: Object.assign({}, DEFAULT_SETTINGS) });
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  // ------------------------------------------------------------ favorites

  async function getFavoritesMap() {
    const data = await B.storage.get('sync', KEYS.favorites);
    const map = data[KEYS.favorites];
    return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  }

  async function setFavoritesMap(map) {
    return B.storage.set('sync', { [KEYS.favorites]: map });
  }

  // ------------------------------------------------------- recently viewed

  async function getRecent() {
    const data = await B.storage.get('local', KEYS.recent);
    const list = data[KEYS.recent];
    return Array.isArray(list) ? list : [];
  }

  async function pushRecent(entry) {
    const settings = await getSettings();
    if (!settings.trackRecentlyViewed) return [];
    const list = await getRecent();
    const filtered = list.filter((e) => e && e.id !== entry.id);
    filtered.unshift({
      id: entry.id, name: entry.name, category: entry.category,
      fmhyUrl: entry.fmhyUrl, url: entry.url, at: Date.now()
    });
    const next = filtered.slice(0, RECENT_LIMIT);
    await B.storage.set('local', { [KEYS.recent]: next });
    return next;
  }

  async function clearRecent() {
    await B.storage.remove('local', KEYS.recent);
    return [];
  }

  // -------------------------------------------------------------- database

  /**
   * Read the active database, or null when none is installed/valid.
   *
   * Rows are stored in the packed (dictionary-encoded) form; the shared
   * dictionary lives in the meta item so a torn write is detectable.
   */
  async function loadDatabase(useBackup) {
    const metaKey = useBackup ? KEYS.dbBackupMeta : KEYS.dbMeta;
    const chunkPrefix = useBackup ? KEYS.dbBackupChunkPrefix : KEYS.dbChunkPrefix;

    const metaWrap = await B.storage.get('local', metaKey);
    const meta = metaWrap[metaKey];
    if (!meta || typeof meta !== 'object' || typeof meta.chunks !== 'number') return null;
    if (!Array.isArray(meta.dict)) return null;

    const keys = [];
    for (let i = 0; i < meta.chunks; i++) keys.push(chunkPrefix + i);
    const chunkData = await B.storage.get('local', keys);

    const rows = [];
    for (const k of keys) {
      const part = chunkData[k];
      if (!Array.isArray(part)) return null; // torn write -> treat as unavailable
      for (const row of part) rows.push(row);
    }
    if (rows.length !== meta.count) return null;

    const dataset = FMHYS.codec.unpack({
      format: FMHYS.codec.FORMAT,
      schemaVersion: meta.schemaVersion,
      version: meta.version,
      source: meta.source,
      generatedAt: meta.generatedAt,
      installedAt: meta.installedAt,
      dict: meta.dict,
      rows
    });
    return dataset;
  }

  /**
   * Write a dataset:
   *   1. snapshot the current DB as a backup
   *   2. write the new chunks
   *   3. write the new meta LAST (meta presence == commit point)
   *   4. drop stale chunks
   */
  async function saveDatabase(dataset) {
    const packed = FMHYS.codec.pack(dataset);
    const chunksArr = FMHYS.codec.chunkRows(packed.rows, CHUNK_SIZE);
    const chunks = Math.max(1, chunksArr.length);

    const prevWrap = await B.storage.get('local', KEYS.dbMeta);
    const prevMeta = prevWrap[KEYS.dbMeta];

    // 1. Snapshot the existing DB as backup.
    if (prevMeta && typeof prevMeta.chunks === 'number') {
      const oldKeys = [];
      for (let i = 0; i < prevMeta.chunks; i++) oldKeys.push(KEYS.dbChunkPrefix + i);
      const old = await B.storage.get('local', oldKeys);
      const backupItems = {};
      for (let i = 0; i < prevMeta.chunks; i++) {
        backupItems[KEYS.dbBackupChunkPrefix + i] = old[KEYS.dbChunkPrefix + i] || [];
      }
      backupItems[KEYS.dbBackupMeta] = prevMeta;
      const backedUp = await B.storage.set('local', backupItems);
      if (!backedUp) {
        // Not fatal, but we must not proceed without a rollback path if the
        // reason is a quota problem — the new write would fail too.
        await B.storage.remove('local', Object.keys(backupItems));
      }
    }

    // 2. Write new chunks.
    for (let i = 0; i < chunks; i++) {
      const ok = await B.storage.set('local', { [KEYS.dbChunkPrefix + i]: chunksArr[i] || [] });
      if (!ok) throw new Error('Failed writing database chunk ' + i + ' (storage quota exceeded?)');
    }

    // 3. Commit.
    const meta = {
      schemaVersion: packed.schemaVersion,
      version: packed.version,
      source: packed.source,
      generatedAt: packed.generatedAt,
      installedAt: new Date().toISOString(),
      count: packed.rows.length,
      chunks,
      dict: packed.dict
    };
    const committed = await B.storage.set('local', { [KEYS.dbMeta]: meta });
    if (!committed) throw new Error('Failed committing database metadata (storage quota exceeded?)');

    // 4. Remove chunks left over from a previously larger DB.
    if (prevMeta && prevMeta.chunks > chunks) {
      const stale = [];
      for (let i = chunks; i < prevMeta.chunks; i++) stale.push(KEYS.dbChunkPrefix + i);
      await B.storage.remove('local', stale);
    }

    // The meta we hand back must not carry the (large) dictionary around.
    return {
      schemaVersion: meta.schemaVersion, version: meta.version, source: meta.source,
      generatedAt: meta.generatedAt, installedAt: meta.installedAt,
      count: meta.count, chunks: meta.chunks
    };
  }

  async function getDatabaseMeta() {
    const wrap = await B.storage.get('local', KEYS.dbMeta);
    const m = wrap[KEYS.dbMeta];
    if (!m) return null;
    // Never leak the (large) string dictionary to UI callers.
    const { dict, ...rest } = m;
    return rest;
  }

  /** Restore the backup DB after a failed install. */
  async function restoreBackup() {
    const backup = await loadDatabase(true);
    if (!backup) return null;
    return saveDatabase(backup);
  }

  async function clearDatabase() {
    const meta = await getDatabaseMeta();
    const keys = [KEYS.dbMeta];
    if (meta && typeof meta.chunks === 'number') {
      for (let i = 0; i < meta.chunks; i++) keys.push(KEYS.dbChunkPrefix + i);
    }
    await B.storage.remove('local', keys);
  }

  async function getUpdateLog() {
    const wrap = await B.storage.get('local', KEYS.updateLog);
    const log = wrap[KEYS.updateLog];
    return Array.isArray(log) ? log : [];
  }

  async function pushUpdateLog(entry) {
    const log = await getUpdateLog();
    log.unshift(Object.assign({ at: new Date().toISOString() }, entry));
    const next = log.slice(0, 20);
    await B.storage.set('local', { [KEYS.updateLog]: next });
    return next;
  }

  FMHYS.storage = {
    KEYS, CHUNK_SIZE, DEFAULT_SETTINGS, clampSettings,
    getSettings, setSettings, resetSettings,
    getFavoritesMap, setFavoritesMap,
    getRecent, pushRecent, clearRecent,
    loadDatabase, saveDatabase, getDatabaseMeta, restoreBackup, clearDatabase,
    getUpdateLog, pushUpdateLog
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
