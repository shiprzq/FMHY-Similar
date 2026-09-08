/**
 * Cross-browser WebExtension shim.
 *
 * Chromium exposes callback-based `chrome.*` (with promises on MV3);
 * Firefox exposes promise-based `browser.*`. This module normalises to a
 * promise API so no other file touches `chrome` directly — which is what makes
 * the Firefox port a manifest change rather than a rewrite.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;

  const api = (typeof root.browser !== 'undefined' && root.browser && root.browser.runtime)
    ? root.browser
    : (typeof root.chrome !== 'undefined' ? root.chrome : null);

  const isFirefox = typeof root.browser !== 'undefined' && !!root.browser.runtime && !root.chrome?.app;
  const available = !!(api && api.runtime && api.runtime.id);

  /** Wrap a possibly-callback API into a promise. */
  function call(fn, thisArg, args) {
    return new Promise((resolve, reject) => {
      let maybe;
      try {
        maybe = fn.apply(thisArg, args.concat([(result) => {
          const err = api.runtime && api.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(result);
        }]));
      } catch (e) {
        // Firefox-style promise APIs reject the extra callback arg.
        try {
          maybe = fn.apply(thisArg, args);
        } catch (e2) { reject(e2); return; }
      }
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    });
  }

  const storage = {
    async get(area, keys) {
      if (!available) return {};
      const s = api.storage[area];
      try { return (await call(s.get, s, [keys])) || {}; } catch (e) { return {}; }
    },
    async set(area, items) {
      if (!available) return false;
      const s = api.storage[area];
      try { await call(s.set, s, [items]); return true; } catch (e) { return false; }
    },
    async remove(area, keys) {
      if (!available) return false;
      const s = api.storage[area];
      try { await call(s.remove, s, [keys]); return true; } catch (e) { return false; }
    },
    onChanged(handler) {
      if (!available || !api.storage.onChanged) return () => {};
      api.storage.onChanged.addListener(handler);
      return () => api.storage.onChanged.removeListener(handler);
    }
  };

  const runtime = {
    id: available ? api.runtime.id : null,
    getURL(path) { return available ? api.runtime.getURL(path) : path; },
    getManifest() { return available ? api.runtime.getManifest() : { version: '0.0.0' }; },
    async sendMessage(message) {
      if (!available) throw new Error('extension-unavailable');
      return call(api.runtime.sendMessage, api.runtime, [message]);
    },
    onMessage(handler) {
      if (!available) return () => {};
      const wrapped = (msg, sender, sendResponse) => {
        let result;
        try { result = handler(msg, sender); } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
          return true;
        }
        if (result && typeof result.then === 'function') {
          result.then(
            (v) => sendResponse(v),
            (e) => sendResponse({ ok: false, error: String(e && e.message || e) })
          );
          return true; // async
        }
        sendResponse(result);
        return false;
      };
      api.runtime.onMessage.addListener(wrapped);
      return () => api.runtime.onMessage.removeListener(wrapped);
    },
    onInstalled(handler) {
      if (available && api.runtime.onInstalled) api.runtime.onInstalled.addListener(handler);
    }
  };

  const tabs = {
    async create(url, active) {
      if (!available || !api.tabs) { root.open(url, '_blank', 'noopener'); return; }
      try { await call(api.tabs.create, api.tabs, [{ url, active: active !== false }]); }
      catch (e) { root.open(url, '_blank', 'noopener'); }
    }
  };

  const openOptions = async () => {
    if (available && api.runtime.openOptionsPage) {
      try { await call(api.runtime.openOptionsPage, api.runtime, []); return; } catch (e) { /* fall through */ }
    }
    await tabs.create(runtime.getURL('options/options.html'), true);
  };

  FMHYS.browser = { api, available, isFirefox, storage, runtime, tabs, openOptions };
})(typeof globalThis !== 'undefined' ? globalThis : self);
