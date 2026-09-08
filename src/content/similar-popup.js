/**
 * The "Similar Resources" card.
 *
 * Rendered into a single reusable element appended to <body>. Every string is
 * inserted with textContent — no innerHTML anywhere in this file — because all
 * database content is treated as untrusted input.
 *
 * Behaviour: viewport-aware positioning, focus trap, Escape to close, click
 * outside to close, arrow-key navigation, reduced-motion aware.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const U = FMHYS.url;
  const NS = 'fmhys';

  let el = null;         // popup root
  let state = null;      // { entry, results, ctx }
  let lastFocus = null;
  let outsideHandler = null;
  let keyHandler = null;
  let repositionHandler = null;

  const MAX_RESULTS = 5;

  function el_(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function ensureRoot() {
    if (el && el.isConnected) return el;
    el = el_('div', `${NS}-ui ${NS}-popup`);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'false');
    el.setAttribute('aria-label', 'Similar FMHY resources');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  /**
   * @param {object} opts
   *   anchor       Element to position next to
   *   entry        { resource } the source resource
   *   results      [{ resource, score }]
   *   settings
   *   favoriteIds  Set of favorited ids
   *   status       'ok' | 'empty' | 'unavailable' | 'loading' | 'error'
   *   message      optional text for non-ok states
   *   onToggleFavorite(resource, buttonEl)
   *   onOpen(resource)
   *   onViewFavorites()
   */
  function open(opts) {
    const node = ensureRoot();
    state = opts;
    lastFocus = document.activeElement;

    node.dataset.anim = opts.settings && opts.settings.animations ? 'on' : 'off';
    node.dataset.theme = resolveTheme(opts.settings);
    render(node, opts);

    node.hidden = false;
    node.classList.remove(`${NS}-popup--in`);
    position(node, opts.anchor);
    // Trigger the entry transition on the next frame.
    requestAnimationFrame(() => node.classList.add(`${NS}-popup--in`));

    attachHandlers(node);

    // Prefer the first alternative so arrow-key navigation starts in the list;
    // fall back to the close button when there are no results.
    // (querySelector with a selector list returns DOM order, not list order,
    // which would land on the close button — so query explicitly, in priority.)
    const first = node.querySelector('[data-autofocus]')
      || node.querySelector('.' + NS + '-item-main')
      || node.querySelector('.' + NS + '-close');
    if (first) first.focus({ preventScroll: true });
  }

  function close() {
    if (!el || el.hidden) return;
    el.classList.remove(`${NS}-popup--in`);
    detachHandlers();
    const finish = () => { if (el) { el.hidden = true; el.textContent = ''; } };
    if (el.dataset.anim === 'on' && !prefersReducedMotion()) setTimeout(finish, 130);
    else finish();
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
      lastFocus.focus({ preventScroll: true });
    }
    lastFocus = null;
    state = null;
  }

  function isOpen() { return !!(el && !el.hidden); }

  function prefersReducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function resolveTheme(settings) {
    const pref = (settings && settings.theme) || 'system';
    if (pref === 'light' || pref === 'dark') return pref;
    // Follow the page first (FMHY toggles `.dark` on <html>), then the OS.
    const de = document.documentElement;
    if (de.classList.contains('dark')) return 'dark';
    if (de.classList.contains('light')) return 'light';
    if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  // ------------------------------------------------------------------ render

  function render(node, opts) {
    node.textContent = '';

    // ---- header
    const header = el_('div', `${NS}-popup-head`);
    const title = el_('h2', `${NS}-popup-title`, 'Similar Resources');
    title.id = `${NS}-popup-title`;
    node.setAttribute('aria-labelledby', title.id);
    header.appendChild(title);

    const close_ = el_('button', `${NS}-close`);
    close_.type = 'button';
    close_.setAttribute('aria-label', 'Close similar resources');
    close_.textContent = '\u00d7';
    close_.addEventListener('click', (e) => { e.preventDefault(); close(); });
    header.appendChild(close_);
    node.appendChild(header);

    // ---- source line
    if (opts.entry && opts.entry.resource) {
      const based = el_('p', `${NS}-based`);
      based.appendChild(el_('span', `${NS}-based-label`, 'Based on'));
      based.appendChild(el_('span', `${NS}-based-name`, opts.entry.resource.name));
      node.appendChild(based);
    }

    const body = el_('div', `${NS}-popup-body`);
    body.setAttribute('role', 'list');
    node.appendChild(body);

    if (opts.status === 'loading') {
      body.appendChild(renderNotice('Searching the local database\u2026', 'loading'));
    } else if (opts.status === 'unavailable') {
      body.appendChild(renderNotice(
        opts.message || 'The local resource database is unavailable. Open Settings to update it.',
        'warn'
      ));
      const btn = el_('button', `${NS}-linkbtn`, 'Open settings');
      btn.type = 'button';
      btn.addEventListener('click', () => { opts.onOpenOptions && opts.onOpenOptions(); close(); });
      body.appendChild(btn);
    } else if (opts.status === 'error') {
      body.appendChild(renderNotice(opts.message || 'Something went wrong.', 'warn'));
    } else if (!opts.results || opts.results.length === 0) {
      body.appendChild(renderNotice('No strong alternatives found.', 'empty'));
    } else {
      const list = opts.results.slice(0, MAX_RESULTS);
      list.forEach((r, i) => body.appendChild(renderItem(r, i, opts)));
    }

    // ---- footer
    const footer = el_('div', `${NS}-popup-foot`);
    const viewAll = el_('button', `${NS}-footbtn`, 'View all favorites');
    viewAll.type = 'button';
    viewAll.addEventListener('click', (e) => {
      e.preventDefault();
      opts.onViewFavorites && opts.onViewFavorites();
    });
    footer.appendChild(viewAll);
    node.appendChild(footer);
  }

  function renderNotice(text, kind) {
    const n = el_('div', `${NS}-notice ${NS}-notice--${kind}`, text);
    n.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
    return n;
  }

  function renderItem(result, i, opts) {
    const r = result.resource;
    const href = U.safeHref(r.fmhyUrl) || U.safeHref(r.url);

    const item = el_('div', `${NS}-item`);
    item.setAttribute('role', 'listitem');

    // favorite toggle
    const favorited = opts.favoriteIds.has(r.id);
    const fav = el_('button', `${NS}-item-fav`);
    fav.type = 'button';
    fav.dataset.state = favorited ? 'on' : 'off';
    fav.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    fav.setAttribute('aria-label', favorited
      ? `Remove ${r.name} from favorites`
      : `Add ${r.name} to favorites`);
    fav.textContent = favorited ? '\u2605' : '\u2606';
    fav.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      opts.onToggleFavorite && opts.onToggleFavorite(r, fav);
    });
    item.appendChild(fav);

    // main clickable link
    const link = document.createElement('a');
    link.className = `${NS}-item-main`;
    if (href) {
      link.href = href;
      link.rel = 'noopener noreferrer';
    } else {
      link.setAttribute('role', 'link');
      link.setAttribute('aria-disabled', 'true');
    }
    if (i === 0) link.setAttribute('data-autofocus', '1');

    const row = el_('span', `${NS}-item-row`);
    row.appendChild(el_('span', `${NS}-item-name`, r.name));
    const arrow = el_('span', `${NS}-item-arrow`, '\u2192');
    arrow.setAttribute('aria-hidden', 'true');
    row.appendChild(arrow);
    link.appendChild(row);

    if (r.description) {
      link.appendChild(el_('span', `${NS}-item-desc`, r.description));
    }

    const metaRow = el_('span', `${NS}-item-meta`);
    const bits = [];
    if (r.category) bits.push(r.category);
    if (r.subcategory && r.subcategory !== r.category) bits.push(r.subcategory);
    if (r.platforms && r.platforms.length) bits.push(r.platforms.slice(0, 3).join('/'));
    bits.forEach((b, idx) => {
      if (idx) {
        const sep = el_('span', `${NS}-dot`, '\u2022');
        sep.setAttribute('aria-hidden', 'true');
        metaRow.appendChild(sep);
      }
      metaRow.appendChild(el_('span', `${NS}-item-metabit`, b));
    });
    if (bits.length) link.appendChild(metaRow);

    if (r.tags && r.tags.length) {
      const tags = el_('span', `${NS}-tags`);
      for (const t of r.tags.slice(0, 4)) tags.appendChild(el_('span', `${NS}-tag`, t));
      link.appendChild(tags);
    }

    const score = el_('span', `${NS}-score`);
    score.textContent = String(result.score);
    score.setAttribute('aria-label', `Similarity ${result.score} out of 100`);
    score.title = `Similarity score: ${result.score}/100`;
    item.appendChild(score);

    link.addEventListener('click', (e) => {
      if (!href) { e.preventDefault(); return; }
      e.preventDefault();
      opts.onOpen && opts.onOpen(r, e);
      close();
    });

    item.insertBefore(link, score);
    return item;
  }

  // -------------------------------------------------------------- positioning

  const GAP = 8;
  const MARGIN = 10;

  function position(node, anchor) {
    node.style.maxHeight = '';
    node.style.left = '0px';
    node.style.top = '0px';

    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Narrow layouts: dock to the bottom as a sheet.
    if (vw < 480) {
      node.dataset.mode = 'sheet';
      node.style.left = '';
      node.style.top = '';
      return;
    }
    node.dataset.mode = 'popover';

    const rect = node.getBoundingClientRect();
    const w = rect.width || 340;
    const h = rect.height || 260;

    let ax = vw / 2, ay = vh / 2, ah = 0;
    if (anchor && anchor.getBoundingClientRect) {
      const ar = anchor.getBoundingClientRect();
      ax = ar.left;
      ay = ar.bottom;
      ah = ar.height;
    }

    // Horizontal: prefer left-aligned with the anchor; flip/clamp near edges.
    let left = ax;
    if (left + w + MARGIN > vw) left = vw - w - MARGIN;
    if (left < MARGIN) left = MARGIN;

    // Vertical: below the anchor, flip above when there is not enough room.
    let top = ay + GAP;
    const spaceBelow = vh - ay - GAP - MARGIN;
    const spaceAbove = ay - ah - GAP - MARGIN;
    if (h > spaceBelow && spaceAbove > spaceBelow) {
      top = ay - ah - GAP - h;
      node.dataset.side = 'top';
      if (h > spaceAbove) {
        node.style.maxHeight = Math.max(160, spaceAbove) + 'px';
        top = MARGIN;
      }
    } else {
      node.dataset.side = 'bottom';
      if (h > spaceBelow) node.style.maxHeight = Math.max(160, spaceBelow) + 'px';
    }
    if (top < MARGIN) top = MARGIN;

    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
  }

  function reposition() {
    if (!isOpen() || !state) return;
    position(el, state.anchor);
  }

  // ----------------------------------------------------------------- handlers

  function focusables(node) {
    return Array.from(node.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  function attachHandlers(node) {
    detachHandlers();

    outsideHandler = (ev) => {
      if (!isOpen()) return;
      if (node.contains(ev.target)) return;
      close();
    };
    // `capture:true` + pointerdown so we close before the page reacts.
    document.addEventListener('pointerdown', outsideHandler, true);

    keyHandler = (ev) => {
      if (!isOpen()) return;
      if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation();
        close();
        return;
      }
      if (ev.key === 'Tab') {
        const items = focusables(node);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault(); last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault(); first.focus();
        }
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        const links = Array.from(node.querySelectorAll(`.${NS}-item-main`));
        if (links.length === 0) return;
        ev.preventDefault();
        const active = document.activeElement;
        const current = (active && active.closest) ? active.closest(`.${NS}-item-main`) : null;
        const idx = current ? links.indexOf(current) : -1;
        const next = ev.key === 'ArrowDown'
          ? (idx < 0 ? 0 : Math.min(idx + 1, links.length - 1))
          : (idx < 0 ? links.length - 1 : Math.max(idx - 1, 0));
        links[next].focus();
      }
    };
    document.addEventListener('keydown', keyHandler, true);

    let raf = 0;
    repositionHandler = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; reposition(); });
    };
    window.addEventListener('scroll', repositionHandler, true);
    window.addEventListener('resize', repositionHandler);
  }

  function detachHandlers() {
    if (outsideHandler) document.removeEventListener('pointerdown', outsideHandler, true);
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    if (repositionHandler) {
      window.removeEventListener('scroll', repositionHandler, true);
      window.removeEventListener('resize', repositionHandler);
    }
    outsideHandler = keyHandler = repositionHandler = null;
  }

  /** Update a favorite star inside the open popup. */
  function setFavoriteState(btn, resourceName, favorited) {
    btn.dataset.state = favorited ? 'on' : 'off';
    btn.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    btn.setAttribute('aria-label', favorited
      ? `Remove ${resourceName} from favorites`
      : `Add ${resourceName} to favorites`);
    btn.textContent = favorited ? '\u2605' : '\u2606';
  }

  FMHYS.similarPopup = { open, close, isOpen, reposition, setFavoriteState, MAX_RESULTS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
