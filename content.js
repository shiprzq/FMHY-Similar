/**
 * Content script orchestrator.
 *
 * Lifecycle:
 *   1. read settings; bail out entirely if disabled
 *   2. scan the article body once, batch-resolve links against the database
 *   3. decorate matched links (indicator + favorite + similar)
 *   4. watch for SPA navigation / lazily rendered content with a debounced,
 *      narrowly-scoped MutationObserver
 *
 * Failure policy: every step is wrapped so that a broken database, a missing
 * service worker or an unexpected DOM shape leaves FMHY exactly as it was.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const B = FMHYS.browser;
  const D = FMHYS.detector;
  const I = FMHYS.indicators;
  const P = FMHYS.similarPopup;

  const DEBOUNCE_MS = 220;
  const MAX_LINKS_PER_PASS = 1500;

  const ctxState = {
    settings: null,
    entries: new Map(),      // resource id -> entry
    byAnchor: new WeakMap(), // <a> -> entry
    seen: new WeakSet(),     // anchors already examined
    favoriteIds: new Set(),
    dbAvailable: false,
    dbMessage: '',
    observer: null,
    pending: null,
    lastPath: location.pathname,
    destroyed: false
  };

  // ------------------------------------------------------------- messaging

  async function send(type, payload) {
    try {
      const res = await B.runtime.sendMessage(Object.assign({ type }, payload || {}));
      return res || { ok: false, error: 'no-response' };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  // ------------------------------------------------------------------ boot

  async function boot() {
    const s = await send('settings:get');
    ctxState.settings = (s.ok && s.settings) || FMHYS.storage.DEFAULT_SETTINGS;
    if (!ctxState.settings.enabled) return;

    applyDocumentFlags();

    const favRes = await send('fav:ids');
    if (favRes.ok) ctxState.favoriteIds = new Set(favRes.ids);

    const metaRes = await send('db:meta');
    if (metaRes.ok && metaRes.meta) {
      ctxState.dbAvailable = metaRes.meta.available && metaRes.meta.count > 0;
      if (!ctxState.dbAvailable) {
        ctxState.dbMessage = metaRes.meta.error
          ? 'Local resource database unavailable: ' + metaRes.meta.error
          : 'The local resource database is empty. Open Settings \u2192 Database \u2192 Update database.';
      }
    } else {
      ctxState.dbAvailable = false;
      ctxState.dbMessage = 'FMHY Similar could not reach its background service.';
    }

    await runPass(document);
    startObserver();
    watchNavigation();
    watchStorage();
  }

  function applyDocumentFlags() {
    const de = document.documentElement;
    de.classList.add('fmhys-active');
    de.dataset.fmhysAnim = ctxState.settings.animations ? 'on' : 'off';
    de.dataset.fmhysTheme = ctxState.settings.theme;
    const compact = ctxState.settings.compactUi;
    de.dataset.fmhysDensity = compact === 'auto'
      ? (window.innerWidth < 720 ? 'compact' : 'comfortable')
      : compact;
  }

  // ----------------------------------------------------------------- passes

  /**
   * Detect + resolve + decorate within `scope`.
   * Only anchors never seen before are examined, so repeated passes are cheap.
   */
  async function runPass(scope) {
    if (ctxState.destroyed) return;
    let found;
    try {
      found = D.scan(scope, ctxState.seen);
    } catch (err) {
      return; // detection must never break the page
    }
    if (!found.length) return;

    const batch = found.slice(0, MAX_LINKS_PER_PASS);

    if (!ctxState.dbAvailable) {
      // Degrade gracefully: no indicators, no fake data. One quiet notice.
      showUnavailableNotice();
      return;
    }

    const entries = batch.map((c, i) => ({
      key: String(i),
      url: c.url,
      name: c.name,
      category: c.category
    }));

    const res = await send('db:resolve', { entries });
    if (!res.ok || !res.resources) {
      ctxState.dbAvailable = false;
      ctxState.dbMessage = 'Local resource database unavailable.';
      showUnavailableNotice();
      return;
    }

    for (let i = 0; i < batch.length; i++) {
      const resource = res.resources[String(i)];
      if (!resource) continue;
      const cand = batch[i];
      if (!cand.el.isConnected) continue;
      if (ctxState.byAnchor.has(cand.el)) continue;

      const entry = {
        el: cand.el,
        li: cand.li,
        resource,
        pageMeta: cand,
        favorited: ctxState.favoriteIds.has(resource.id),
        decorated: false
      };
      ctxState.byAnchor.set(cand.el, entry);
      if (!ctxState.entries.has(resource.id)) ctxState.entries.set(resource.id, []);
      ctxState.entries.get(resource.id).push(entry);

      try {
        I.decorate(entry, decorateCtx());
      } catch (err) { /* one bad node must not stop the rest */ }
    }
  }

  function decorateCtx() {
    return {
      settings: ctxState.settings,
      onToggleFavorite: handleToggleFavorite,
      onFindSimilar: handleFindSimilar,
      lookupByAnchor: (a) => ctxState.byAnchor.get(a) || null
    };
  }

  // --------------------------------------------------------------- handlers

  async function handleToggleFavorite(entry, btn) {
    if (btn) btn.disabled = true;
    const res = await send('fav:toggle', { resource: entry.resource });
    if (btn) btn.disabled = false;
    if (!res.ok) return;
    setFavoriteEverywhere(entry.resource.id, res.favorited);
  }

  function setFavoriteEverywhere(id, favorited) {
    if (favorited) ctxState.favoriteIds.add(id); else ctxState.favoriteIds.delete(id);
    const list = ctxState.entries.get(id) || [];
    for (const e of list) {
      try { I.updateFavorite(e, favorited); } catch (err) { /* ignore */ }
    }
  }

  async function handleFindSimilar(entry, anchorEl) {
    if (!ctxState.dbAvailable) {
      P.open({
        anchor: anchorEl, entry, settings: ctxState.settings,
        favoriteIds: ctxState.favoriteIds, status: 'unavailable',
        message: ctxState.dbMessage,
        onOpenOptions: () => send('open:options'),
        onViewFavorites: openFavorites
      });
      return;
    }

    // Show the shell immediately; the results arrive in the same frame budget
    // because the index is already built in the worker.
    P.open({
      anchor: anchorEl, entry, settings: ctxState.settings,
      favoriteIds: ctxState.favoriteIds, status: 'loading',
      onViewFavorites: openFavorites
    });

    const res = await send('db:similar', { id: entry.resource.id });
    if (!P.isOpen()) return;

    if (!res.ok) {
      P.open({
        anchor: anchorEl, entry, settings: ctxState.settings,
        favoriteIds: ctxState.favoriteIds, status: 'error',
        message: 'Could not compute alternatives right now.',
        onViewFavorites: openFavorites
      });
      return;
    }

    P.open({
      anchor: anchorEl,
      entry,
      settings: ctxState.settings,
      favoriteIds: ctxState.favoriteIds,
      status: 'ok',
      results: (res.results || []).slice(0, 5),
      onToggleFavorite: async (resource, btn) => {
        btn.disabled = true;
        const r = await send('fav:toggle', { resource });
        btn.disabled = false;
        if (!r.ok) return;
        P.setFavoriteState(btn, resource.name, r.favorited);
        setFavoriteEverywhere(resource.id, r.favorited);
      },
      onOpen: (resource) => {
        const href = FMHYS.url.safeHref(resource.fmhyUrl) || FMHYS.url.safeHref(resource.url);
        if (!href) return;
        if (ctxState.settings.trackRecentlyViewed) {
          send('recent:push', { entry: resource });
        }
        // Same-tab navigation to the FMHY page; never a new tab from the card.
        if (FMHYS.url.isFmhyUrl(href)) location.href = href;
        else send('open:url', { url: href });
      },
      onViewFavorites: openFavorites
    });

    if (ctxState.settings.trackRecentlyViewed) {
      send('recent:push', { entry: entry.resource });
    }
  }

  function openFavorites() {
    P.close();
    send('open:url', { url: B.runtime.getURL('popup/popup.html#favorites') });
  }

  // ------------------------------------------------------------- degradation

  let noticeShown = false;
  function showUnavailableNotice() {
    if (noticeShown) return;
    noticeShown = true;
    const root_ = D.contentRoot(document);
    if (!root_) return;
    const bar = document.createElement('div');
    bar.className = 'fmhys-ui fmhys-toast';
    bar.setAttribute('role', 'status');
    const txt = document.createElement('span');
    txt.textContent = ctxState.dbMessage ||
      'FMHY Similar: local resource database unavailable.';
    bar.appendChild(txt);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fmhys-toast-btn';
    btn.textContent = 'Settings';
    btn.addEventListener('click', () => send('open:options'));
    bar.appendChild(btn);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'fmhys-toast-close';
    dismiss.setAttribute('aria-label', 'Dismiss message');
    dismiss.textContent = '\u00d7';
    dismiss.addEventListener('click', () => bar.remove());
    bar.appendChild(dismiss);
    document.body.appendChild(bar);
    setTimeout(() => { if (bar.isConnected) bar.remove(); }, 12000);
  }

  // ----------------------------------------------------------- observation

  function startObserver() {
    const target = D.contentRoot(document) || document.body;
    if (!target || ctxState.observer) return;

    ctxState.observer = new MutationObserver((mutations) => {
      // Ignore mutations we caused ourselves.
      let relevant = null;
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList && (n.classList.contains('fmhys-ui') || n.closest('.fmhys-ui'))) continue;
          if (!n.querySelector && n.tagName !== 'A') continue;
          relevant = relevant || [];
          relevant.push(n);
        }
      }
      if (!relevant) return;
      schedulePass();
    });

    ctxState.observer.observe(target, { childList: true, subtree: true });
  }

  function schedulePass() {
    if (ctxState.pending) clearTimeout(ctxState.pending);
    ctxState.pending = setTimeout(() => {
      ctxState.pending = null;
      // Re-resolve the content root: VitePress replaces it on route change.
      const scope = D.contentRoot(document) || document;
      runPass(scope);
    }, DEBOUNCE_MS);
  }

  /** VitePress is an SPA: re-arm on route changes. */
  function watchNavigation() {
    const onNav = () => {
      if (location.pathname === ctxState.lastPath) return;
      ctxState.lastPath = location.pathname;
      P.close();
      ctxState.entries.clear();
      ctxState.seen = new WeakSet();
      ctxState.byAnchor = new WeakMap();
      noticeShown = false;
      if (ctxState.observer) { ctxState.observer.disconnect(); ctxState.observer = null; }
      setTimeout(() => { runPass(document); startObserver(); }, 60);
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', () => { /* anchors only, no rescan */ });

    // Patch history methods without breaking the site's own handlers.
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      if (typeof orig !== 'function' || orig.__fmhys) continue;
      const patched = function () {
        const r = orig.apply(this, arguments);
        setTimeout(onNav, 0);
        return r;
      };
      patched.__fmhys = true;
      try { history[m] = patched; } catch (e) { /* CSP-locked page */ }
    }
  }

  /** Keep stars in sync when favorites change in the popup or another tab. */
  function watchStorage() {
    B.storage.onChanged((changes, area) => {
      if (area !== 'sync') return;
      const favChange = changes[FMHYS.storage.KEYS.favorites];
      if (favChange) {
        const map = favChange.newValue || {};
        const next = new Set(Object.keys(map));
        for (const id of ctxState.entries.keys()) {
          const should = next.has(id);
          if (should !== ctxState.favoriteIds.has(id)) setFavoriteEverywhere(id, should);
        }
        ctxState.favoriteIds = next;
      }
      const setChange = changes[FMHYS.storage.KEYS.settings];
      if (setChange && setChange.newValue) {
        const next = FMHYS.storage.clampSettings(setChange.newValue);
        const needsRebuild =
          next.enabled !== ctxState.settings.enabled ||
          next.showIndicators !== ctxState.settings.showIndicators ||
          next.showFavoriteButtons !== ctxState.settings.showFavoriteButtons ||
          next.showSimilarButton !== ctxState.settings.showSimilarButton;
        ctxState.settings = next;
        applyDocumentFlags();
        if (needsRebuild) {
          P.close();
          I.teardown();
          ctxState.entries.clear();
          ctxState.seen = new WeakSet();
          ctxState.byAnchor = new WeakMap();
          if (next.enabled) runPass(document);
        }
      }
    });
  }

  // Start after the document body exists; `document_idle` usually guarantees it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch(() => {}); }, { once: true });
  } else {
    boot().catch(() => {});
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
