/**
 * Extension dashboard.
 *
 * Everything the user sees is composed with createElement/textContent.
 * There is no innerHTML in this file: database and favorite content is
 * untrusted input.
 */
(function () {
  'use strict';
  const FMHYS = globalThis.FMHYS;
  const B = FMHYS.browser;
  const U = FMHYS.url;

  const $ = (id) => document.getElementById(id);

  const state = {
    settings: null,
    favorites: [],
    favoriteIds: new Set(),
    recent: [],
    searchResults: [],
    tab: 'favorites',
    dbMeta: null
  };

  // ------------------------------------------------------------- messaging

  async function send(type, payload) {
    try {
      const res = await B.runtime.sendMessage(Object.assign({ type }, payload || {}));
      return res || { ok: false, error: 'no-response' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // ------------------------------------------------------------------ utils

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function debounce(fn, ms) {
    let t = 0;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function applyTheme(theme) {
    const pref = theme || 'system';
    let resolved = pref;
    if (pref === 'system') {
      resolved = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = resolved;
  }

  function targetUrl(r) {
    return U.safeHref(r.fmhyUrl) || U.safeHref(r.url) || '';
  }

  async function openResource(r) {
    const href = targetUrl(r);
    if (!href) return;
    await send('recent:push', { entry: r });
    await send('open:url', { url: href });
    if (!document.body.classList.contains('standalone')) window.close();
  }

  // ------------------------------------------------------------------ cards

  /**
   * @param {object} r resource-shaped record
   * @param {object} opts { showRemove, showStar, showScore, onRemove, onStar }
   */
  function renderCard(r, opts) {
    const o = opts || {};
    const card = el('div', 'card');
    card.setAttribute('role', 'listitem');

    const body = el('div', 'card-body');

    // Styled entirely from CSS (.card-name); setting `style.all = 'unset'`
    // inline would beat the stylesheet and reset the typography.
    const nameBtn = el('button', 'card-name', r.name);
    nameBtn.type = 'button';
    nameBtn.setAttribute('aria-label', `Open ${r.name} on FMHY`);
    nameBtn.addEventListener('click', () => openResource(r));
    body.appendChild(nameBtn);

    if (r.description) body.appendChild(el('div', 'card-desc', r.description));

    const meta = el('div', 'card-meta');
    if (r.category) meta.appendChild(el('span', 'chip', r.category));
    if (r.subcategory && r.subcategory !== r.category) {
      meta.appendChild(el('span', 'chip', r.subcategory));
    }
    if (o.showScore && typeof o.score === 'number') {
      meta.appendChild(el('span', 'chip chip--score', String(o.score)));
    }
    if (r.platforms && r.platforms.length) {
      meta.appendChild(el('span', null, r.platforms.slice(0, 3).join(' / ')));
    }
    if (meta.childNodes.length) body.appendChild(meta);

    card.appendChild(body);

    const actions = el('div', 'card-actions');

    if (o.showStar !== false) {
      const fav = state.favoriteIds.has(r.id);
      const star = el('button', 'act-star', fav ? '\u2605' : '\u2606');
      star.type = 'button';
      star.dataset.state = fav ? 'on' : 'off';
      star.setAttribute('aria-pressed', fav ? 'true' : 'false');
      star.setAttribute('aria-label', fav
        ? `Remove ${r.name} from favorites` : `Add ${r.name} to favorites`);
      star.addEventListener('click', async () => {
        star.disabled = true;
        const res = await send('fav:toggle', { resource: r });
        star.disabled = false;
        if (!res.ok) return;
        await refreshFavorites();
        renderAll();
      });
      actions.appendChild(star);
    }

    const open = el('button', 'act act--open', 'Open');
    open.type = 'button';
    open.setAttribute('aria-label', `Open ${r.name} on FMHY`);
    open.addEventListener('click', () => openResource(r));
    actions.appendChild(open);

    if (o.showRemove) {
      const rm = el('button', 'act act--remove', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove ${r.name} from favorites`);
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        await send('fav:remove', { id: r.id });
        await refreshFavorites();
        renderAll();
      });
      actions.appendChild(rm);
    }

    card.appendChild(actions);
    return card;
  }

  function renderEmpty(container, title, text) {
    const box = el('div', 'empty');
    box.appendChild(el('p', 'empty-title', title));
    box.appendChild(el('p', 'empty-text', text));
    container.appendChild(box);
  }

  // -------------------------------------------------------------- favorites

  function visibleFavorites() {
    const q = $('fav-filter').value.trim().toLowerCase();
    const cat = $('fav-cat').value;
    const sort = $('fav-sort').value;

    let list = state.favorites.slice();
    if (cat) list = list.filter((f) => f.category === cat);
    if (q) {
      list = list.filter((f) =>
        (f.name || '').toLowerCase().includes(q) ||
        (f.description || '').toLowerCase().includes(q) ||
        (f.category || '').toLowerCase().includes(q) ||
        (f.tags || []).some((t) => String(t).toLowerCase().includes(q))
      );
    }
    const cmp = {
      'added-desc': (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
      'added-asc': (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
      'name-asc': (a, b) => a.name.localeCompare(b.name),
      'name-desc': (a, b) => b.name.localeCompare(a.name)
    }[sort] || ((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    list.sort(cmp);
    return list;
  }

  function renderFavorites() {
    const list = $('fav-list');
    list.textContent = '';

    if (state.favorites.length === 0) {
      renderEmpty(list, 'No favorites yet',
        'Open a page on fmhy.net and click the star next to any resource to save it here.');
      $('fav-foot').hidden = true;
      return;
    }

    const visible = visibleFavorites();
    if (visible.length === 0) {
      renderEmpty(list, 'Nothing matches', 'Try a different filter or category.');
    } else {
      for (const f of visible) {
        list.appendChild(renderCard(f, { showRemove: true, showStar: false }));
      }
    }
    $('fav-foot').hidden = false;
  }

  function syncCategoryOptions() {
    const sel = $('fav-cat');
    const prev = sel.value;
    const cats = Array.from(new Set(state.favorites.map((f) => f.category).filter(Boolean))).sort();
    sel.textContent = '';
    const all = el('option', null, 'All categories');
    all.value = '';
    sel.appendChild(all);
    for (const c of cats) {
      const o = el('option', null, c);
      o.value = c;
      sel.appendChild(o);
    }
    if (cats.includes(prev)) sel.value = prev;
  }

  // ----------------------------------------------------------------- recent

  function renderRecent() {
    const list = $('recent-list');
    list.textContent = '';
    if (state.recent.length === 0) {
      renderEmpty(list, 'Nothing here yet',
        'Resources you open from a Find Similar card appear here. Nothing else about your browsing is recorded.');
      $('recent-foot').hidden = true;
      return;
    }
    for (const r of state.recent) list.appendChild(renderCard(r, { showRemove: false }));
    $('recent-foot').hidden = false;
  }

  // ----------------------------------------------------------------- search

  const runSearch = debounce(async function () {
    const q = $('q').value.trim();
    $('q-clear').hidden = q.length === 0;
    if (!q) {
      state.searchResults = [];
      if (state.tab === 'search') switchTab('favorites');
      renderAll();
      return;
    }
    switchTab('search');
    const res = await send('db:search', { query: q, limit: 30 });
    state.searchResults = res.ok ? res.results : [];
    renderSearch(res.ok ? null : (res.error || 'search failed'));
  }, 140);

  function renderSearch(error) {
    const list = $('search-list');
    list.textContent = '';
    const q = $('q').value.trim();

    if (error) { renderEmpty(list, 'Search unavailable', String(error)); return; }
    if (!q) { renderEmpty(list, 'Search the FMHY database', 'Type a name, tag or category above.'); return; }
    if (state.searchResults.length === 0) {
      renderEmpty(list, 'No matches', `Nothing in the local database matches “${q}”.`);
      return;
    }
    for (const r of state.searchResults) {
      list.appendChild(renderCard(r.resource, { showScore: false }));
    }
  }

  // -------------------------------------------------------------------- tabs

  const TABS = ['favorites', 'recent', 'search'];

  function switchTab(name) {
    if (!TABS.includes(name)) name = 'favorites';
    state.tab = name;
    for (const t of TABS) {
      const btn = $('tab-' + t);
      const panel = $('panel-' + t);
      const on = t === name;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
  }

  function wireTabs() {
    for (const t of TABS) {
      $('tab-' + t).addEventListener('click', () => switchTab(t));
    }
    // Roving tabindex: arrow keys move between tabs (WAI-ARIA tabs pattern).
    const tablist = $('tab-favorites').parentElement;
    tablist.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      ev.preventDefault();
      const i = TABS.indexOf(state.tab);
      const next = ev.key === 'ArrowRight'
        ? (i + 1) % TABS.length
        : (i - 1 + TABS.length) % TABS.length;
      switchTab(TABS[next]);
      $('tab-' + TABS[next]).focus();
    });
  }

  // ------------------------------------------------------------------ status

  function renderStatus() {
    const dot = $('db-dot');
    const txt = $('db-status');
    const m = state.dbMeta;
    if (!m) { dot.dataset.state = 'warn'; txt.textContent = 'Database status unknown.'; return; }
    if (!m.available || !m.count) {
      dot.dataset.state = 'err';
      txt.textContent = m.error
        ? 'Database error: ' + m.error
        : 'No resource database installed — open Settings to update.';
      return;
    }
    dot.dataset.state = 'ok';
    const when = m.installedAt ? new Date(m.installedAt) : null;
    txt.textContent =
      `${m.count.toLocaleString()} resources \u00b7 v${m.version}` +
      (when && !isNaN(when) ? ` \u00b7 updated ${when.toLocaleDateString()}` : '');
  }

  function renderAll() {
    $('fav-count').textContent = String(state.favorites.length);
    syncCategoryOptions();
    renderFavorites();
    renderRecent();
    renderSearch(null);
    renderStatus();
  }

  // -------------------------------------------------------------------- data

  async function refreshFavorites() {
    const res = await send('fav:list');
    state.favorites = res.ok ? res.favorites : [];
    state.favoriteIds = new Set(state.favorites.map((f) => f.id));
  }

  async function init() {
    // Standalone (opened in a tab from the "View all favorites" link).
    if (location.hash) document.body.classList.add('standalone');

    const s = await send('settings:get');
    state.settings = (s.ok && s.settings) || FMHYS.storage.DEFAULT_SETTINGS;
    applyTheme(state.settings.theme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme(state.settings.theme);
    });

    await refreshFavorites();

    const [recentRes, metaRes] = await Promise.all([send('recent:list'), send('db:meta')]);
    state.recent = recentRes.ok ? recentRes.recent : [];
    state.dbMeta = metaRes.ok ? metaRes.meta : null;

    wireTabs();

    $('q').addEventListener('input', runSearch);
    $('q').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $('q').value = ''; runSearch(); }
    });
    $('q-clear').addEventListener('click', () => {
      $('q').value = '';
      $('q').focus();
      runSearch();
    });

    $('fav-filter').addEventListener('input', renderFavorites);
    $('fav-cat').addEventListener('change', renderFavorites);
    $('fav-sort').addEventListener('change', renderFavorites);

    $('fav-clear').addEventListener('click', () => {
      $('fav-confirm').hidden = false;
      $('fav-confirm-no').focus();
    });
    $('fav-confirm-no').addEventListener('click', () => {
      $('fav-confirm').hidden = true;
      $('fav-clear').focus();
    });
    $('fav-confirm-yes').addEventListener('click', async () => {
      await send('fav:clear');
      $('fav-confirm').hidden = true;
      await refreshFavorites();
      renderAll();
    });

    $('recent-clear').addEventListener('click', async () => {
      await send('recent:clear');
      state.recent = [];
      renderRecent();
    });

    $('btn-settings').addEventListener('click', async () => {
      await send('open:options');
      if (!document.body.classList.contains('standalone')) window.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== $('q')) {
        e.preventDefault();
        $('q').focus();
      }
    });

    const wanted = (location.hash || '').replace('#', '');
    switchTab(TABS.includes(wanted) ? wanted : 'favorites');
    renderAll();
  }

  init().catch((err) => {
    const list = document.getElementById('fav-list');
    if (list) {
      list.textContent = '';
      renderEmpty(list, 'Something went wrong', String(err && err.message || err));
    }
  });
})();
