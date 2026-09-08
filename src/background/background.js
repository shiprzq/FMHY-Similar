/**
 * Background logic — shared by every browser.
 *
 * This file assumes the core modules have already been loaded into the same
 * global scope. HOW they are loaded differs per browser, which is the ONLY
 * difference between the Chromium and Firefox builds:
 *
 *   Chromium : background/service-worker.js  importScripts() the deps, then this.
 *   Firefox  : manifest background.scripts   lists the deps, then this.
 *
 * Firefox MV3 uses a non-persistent event page rather than a service worker and
 * does not implement importScripts(), so the loader must stay separate.
 *
 * Either way this is an event-driven, non-persistent context: it can be torn
 * down at any time, so nothing durable is kept in module scope.
 */
'use strict';

const FMHYS = globalThis.FMHYS;
const DB = FMHYS.database;
const B = FMHYS.browser;

const ALARM_UPDATE = 'fmhys-db-update';
/** Never poll FMHY more often than this, even if settings say otherwise. */
const MIN_UPDATE_INTERVAL_MINUTES = 60 * 24; // once per day, at most

// ------------------------------------------------------------------ messaging

const handlers = {
  async ping() {
    return { ok: true, version: FMHYS.VERSION };
  },

  async 'db:meta'() {
    await DB.ensureReady();
    return { ok: true, meta: DB.meta() };
  },

  async 'db:resolve'(msg) {
    const entries = Array.isArray(msg.entries) ? msg.entries.slice(0, 4000) : [];
    const map = await DB.resolveMany(entries);
    return { ok: true, resources: map, meta: DB.meta() };
  },

  async 'db:similar'(msg) {
    const settings = await FMHYS.storage.getSettings();
    const results = await DB.findSimilar(msg.id, {
      limit: 5,
      minScore: settings.minSimilarity
    });
    return { ok: true, results, meta: DB.meta() };
  },

  async 'db:search'(msg) {
    const results = await DB.search(String(msg.query || ''), {
      limit: Math.min(Number(msg.limit) || 20, 50),
      category: msg.category || null
    });
    return { ok: true, results, meta: DB.meta() };
  },

  async 'db:get'(msg) {
    await DB.ensureReady();
    const idx = DB.state.index;
    if (!idx) return { ok: false, error: 'database-unavailable' };
    return { ok: true, resource: idx.findById(msg.id) || null };
  },

  async 'db:update'(msg) {
    const result = await DB.update({ mode: msg.mode || 'repo' });
    return { ok: result.ok, result, meta: DB.meta() };
  },

  async 'db:reset'() {
    const m = await DB.reset();
    return { ok: true, meta: m };
  },

  async 'db:import'(msg) {
    const result = await DB.importDataset(msg.dataset);
    return { ok: result.ok, result, meta: DB.meta() };
  },

  async 'db:log'() {
    return { ok: true, log: await FMHYS.storage.getUpdateLog() };
  },

  async 'fav:list'() {
    return { ok: true, favorites: await FMHYS.favorites.all() };
  },

  async 'fav:ids'() {
    return { ok: true, ids: await FMHYS.favorites.ids() };
  },

  async 'fav:toggle'(msg) {
    const resource = msg.resource;
    if (!resource || !resource.id) return { ok: false, error: 'bad-resource' };
    const favorited = await FMHYS.favorites.toggle(resource);
    return { ok: true, favorited, count: await FMHYS.favorites.count() };
  },

  async 'fav:remove'(msg) {
    await FMHYS.favorites.remove(msg.id);
    return { ok: true, count: await FMHYS.favorites.count() };
  },

  async 'fav:clear'() {
    await FMHYS.favorites.clear();
    return { ok: true, count: 0 };
  },

  async 'fav:count'() {
    return { ok: true, count: await FMHYS.favorites.count() };
  },

  async 'settings:get'() {
    return { ok: true, settings: await FMHYS.storage.getSettings() };
  },

  async 'settings:set'(msg) {
    const settings = await FMHYS.storage.setSettings(msg.patch);
    await syncAlarm(settings);
    return { ok: true, settings };
  },

  async 'settings:reset'() {
    const settings = await FMHYS.storage.resetSettings();
    await syncAlarm(settings);
    return { ok: true, settings };
  },

  async 'recent:list'() {
    return { ok: true, recent: await FMHYS.storage.getRecent() };
  },

  async 'recent:push'(msg) {
    const recent = await FMHYS.storage.pushRecent(msg.entry || {});
    return { ok: true, recent };
  },

  async 'recent:clear'() {
    await FMHYS.storage.clearRecent();
    return { ok: true, recent: [] };
  },

  async 'open:url'(msg) {
    const href = FMHYS.url.safeHref(msg.url);
    if (!href) return { ok: false, error: 'unsafe-url' };
    await B.tabs.create(href, msg.active !== false);
    return { ok: true };
  },

  async 'open:options'() {
    await B.openOptions();
    return { ok: true };
  }
};

B.runtime.onMessage((msg) => {
  if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'bad-message' };
  const handler = handlers[msg.type];
  if (!handler) return { ok: false, error: 'unknown-message:' + msg.type };
  return handler(msg).catch((err) => ({ ok: false, error: String(err && err.message || err) }));
});

// ------------------------------------------------------------------- lifecycle

B.runtime.onInstalled(async (details) => {
  try {
    await DB.ensureReady();
    const settings = await FMHYS.storage.getSettings();
    await syncAlarm(settings);
    if (details && details.reason === 'install') {
      await B.openOptions().catch(() => {});
    }
  } catch (e) { /* never block install */ }
});

async function syncAlarm(settings) {
  const alarms = B.api && B.api.alarms;
  if (!alarms) return;
  try {
    await alarms.clear(ALARM_UPDATE);
    if (settings.autoUpdateDatabase) {
      alarms.create(ALARM_UPDATE, {
        periodInMinutes: MIN_UPDATE_INTERVAL_MINUTES,
        delayInMinutes: 60
      });
    }
  } catch (e) { /* alarms unavailable */ }
}

if (B.api && B.api.alarms && B.api.alarms.onAlarm) {
  B.api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_UPDATE) return;
    const settings = await FMHYS.storage.getSettings();
    if (!settings.autoUpdateDatabase) return;
    await DB.update({ mode: 'repo' }).catch(() => {});
  });
}

// Warm the index as soon as the worker spins up so the first double-click on a
// page is already instant.
DB.ensureReady().catch(() => {});
