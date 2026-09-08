/**
 * Favorites store.
 *
 * Persisted in `storage.sync` (falls back to local when sync is unavailable),
 * keyed by resource id. Survives browser restarts and extension reloads.
 * No account, ever.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const S = FMHYS.storage;
  const B = FMHYS.browser;

  const listeners = new Set();
  let cache = null;
  let loading = null;

  function snapshotEntry(resource) {
    return {
      id: resource.id,
      name: String(resource.name || '').slice(0, 160),
      url: FMHYS.url.safeHref(resource.url),
      fmhyUrl: FMHYS.url.safeHref(resource.fmhyUrl),
      category: String(resource.category || '').slice(0, 80),
      subcategory: String(resource.subcategory || '').slice(0, 80),
      description: String(resource.description || '').slice(0, 400),
      tags: Array.isArray(resource.tags) ? resource.tags.slice(0, 12) : [],
      platforms: Array.isArray(resource.platforms) ? resource.platforms.slice(0, 8) : [],
      addedAt: Date.now()
    };
  }

  async function load(force) {
    if (cache && !force) return cache;
    if (loading && !force) return loading;
    loading = S.getFavoritesMap().then((map) => { cache = map; loading = null; return map; });
    return loading;
  }

  async function all() {
    const map = await load();
    return Object.values(map).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  async function ids() {
    const map = await load();
    return Object.keys(map);
  }

  async function has(id) {
    const map = await load();
    return Object.prototype.hasOwnProperty.call(map, id);
  }

  async function add(resource) {
    if (!resource || !resource.id) return false;
    const map = Object.assign({}, await load());
    if (map[resource.id]) return true;
    map[resource.id] = snapshotEntry(resource);
    cache = map;
    const ok = await S.setFavoritesMap(map);
    emit({ type: 'add', id: resource.id, favorited: true });
    return ok;
  }

  async function remove(id) {
    const map = Object.assign({}, await load());
    if (!map[id]) return true;
    delete map[id];
    cache = map;
    const ok = await S.setFavoritesMap(map);
    emit({ type: 'remove', id, favorited: false });
    return ok;
  }

  /** @returns {Promise<boolean>} the new favorited state. */
  async function toggle(resource) {
    if (!resource || !resource.id) return false;
    const isFav = await has(resource.id);
    if (isFav) { await remove(resource.id); return false; }
    await add(resource);
    return true;
  }

  async function clear() {
    cache = {};
    const ok = await S.setFavoritesMap({});
    emit({ type: 'clear' });
    return ok;
  }

  async function count() {
    const map = await load();
    return Object.keys(map).length;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit(evt) {
    for (const fn of listeners) { try { fn(evt); } catch (e) { /* isolate */ } }
  }

  // Keep every surface (page, popup, options) in sync.
  B.storage.onChanged((changes, area) => {
    if (area !== 'sync' || !changes[S.KEYS.favorites]) return;
    const next = changes[S.KEYS.favorites].newValue;
    cache = (next && typeof next === 'object') ? next : {};
    emit({ type: 'sync' });
  });

  FMHYS.favorites = { all, ids, has, add, remove, toggle, clear, count, onChange, load, snapshotEntry };
})(typeof globalThis !== 'undefined' ? globalThis : self);
