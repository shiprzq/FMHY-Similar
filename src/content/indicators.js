/**
 * Visual layer: the red resource indicator, the favorite button and the
 * accessible "Similar" affordance.
 *
 * Design constraints honoured here:
 *   - never modify the original link text, href or event handlers
 *   - the indicator is a CSS-drawn element, no canvas / no overlay painting
 *   - controls are appended AFTER the link inside the same <li>, so reflow is
 *     a few pixels, never a layout change
 *   - everything is keyboard reachable and screen-reader labelled
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;

  const NS = 'fmhys';
  const STAR_FILLED = '\u2605';
  const STAR_HOLLOW = '\u2606';

  /** Build the control cluster for one detected resource. */
  function decorate(entry, ctx) {
    const { settings, onToggleFavorite, onFindSimilar } = ctx;
    if (entry.decorated) return;
    entry.decorated = true;

    const a = entry.el;
    const wrap = document.createElement('span');
    wrap.className = `${NS}-ui ${NS}-cluster`;
    wrap.setAttribute('data-fmhys-id', entry.resource.id);

    // --- red indicator -------------------------------------------------
    if (settings.showIndicators) {
      const bar = document.createElement('span');
      bar.className = `${NS}-indicator`;
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label',
        `Indexed FMHY resource: ${entry.resource.name}. Alternatives available.`);
      bar.setAttribute('title', 'FMHY Similar: double-click for alternatives');
      bar.tabIndex = 0;
      wrap.appendChild(bar);
      entry.bar = bar;

      // The indicator itself is a Find Similar affordance.
      bar.addEventListener('dblclick', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        onFindSimilar(entry, bar);
      });
      bar.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onFindSimilar(entry, bar);
        }
      });
    }

    // --- favorite button -----------------------------------------------
    if (settings.showFavoriteButtons) {
      const fav = document.createElement('button');
      fav.type = 'button';
      fav.className = `${NS}-fav`;
      fav.dataset.state = entry.favorited ? 'on' : 'off';
      fav.setAttribute('aria-pressed', entry.favorited ? 'true' : 'false');
      setFavLabel(fav, entry.resource.name, entry.favorited);
      fav.textContent = entry.favorited ? STAR_FILLED : STAR_HOLLOW;
      fav.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        onToggleFavorite(entry, fav);
      });
      // Don't let a fast double tap on the star trigger Find Similar.
      fav.addEventListener('dblclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      wrap.appendChild(fav);
      entry.favBtn = fav;
    }

    // --- similar button (accessible alternative to double-click) --------
    const wantSimilar =
      settings.showSimilarButton === 'always' ||
      (settings.showSimilarButton === 'auto' && !settings.dblClickFindSimilar) ||
      (settings.showSimilarButton === 'auto' && isCoarsePointer());

    const sim = document.createElement('button');
    sim.type = 'button';
    sim.className = `${NS}-similar${wantSimilar ? '' : ' ' + NS + '-similar--quiet'}`;
    sim.setAttribute('aria-label', `Find resources similar to ${entry.resource.name}`);
    sim.setAttribute('title', 'Find similar resources');
    sim.appendChild(iconSimilar());
    const lbl = document.createElement('span');
    lbl.className = `${NS}-similar-text`;
    lbl.textContent = 'Similar';
    sim.appendChild(lbl);
    sim.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      onFindSimilar(entry, sim);
    });
    wrap.appendChild(sim);
    entry.simBtn = sim;

    // Insert immediately after the anchor, outside of it.
    if (a.parentNode) a.parentNode.insertBefore(wrap, a.nextSibling);
    entry.wrap = wrap;

    // Mark the anchor for styling/aria without touching its content.
    a.classList.add(`${NS}-linked`);
    a.setAttribute('data-fmhys', '1');

    // --- double-click on the resource area ------------------------------
    if (settings.dblClickFindSimilar && entry.li && !entry.li.dataset.fmhysDbl) {
      entry.li.dataset.fmhysDbl = '1';
      entry.li.addEventListener('dblclick', (ev) => {
        // Only react when the double-click landed on a decorated resource.
        const anchor = ev.target.closest ? ev.target.closest('a[data-fmhys="1"]') : null;
        const cluster = ev.target.closest ? ev.target.closest(`.${NS}-cluster`) : null;
        const target = anchor || (cluster && cluster.previousElementSibling);
        if (!target) return;
        const found = ctx.lookupByAnchor(target);
        if (!found) return;
        ev.preventDefault();
        ev.stopPropagation();
        // Clear the accidental text selection a double-click creates.
        const sel = root.getSelection && root.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
        onFindSimilar(found, cluster || target);
      });
    }
  }

  function setFavLabel(btn, name, on) {
    btn.setAttribute('aria-label', on ? `Remove ${name} from favorites` : `Add ${name} to favorites`);
    btn.setAttribute('title', on ? 'Remove from favorites' : 'Add to favorites');
  }

  function updateFavorite(entry, favorited) {
    entry.favorited = favorited;
    const btn = entry.favBtn;
    if (!btn) return;
    btn.dataset.state = favorited ? 'on' : 'off';
    btn.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    btn.textContent = favorited ? STAR_FILLED : STAR_HOLLOW;
    setFavLabel(btn, entry.resource.name, favorited);
    btn.classList.remove(`${NS}-pop`);
    // Restart the micro-animation.
    void btn.offsetWidth;
    btn.classList.add(`${NS}-pop`);
  }

  function iconSimilar() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'currentColor');
    // Two overlapping rounded squares = "alternatives".
    p.setAttribute('d', 'M2.6 2.2h6.1c.5 0 .9.4.9.9v1.3H4.4c-.7 0-1.2.5-1.2 1.2v4.7H2.6c-.5 0-.9-.4-.9-.9V3.1c0-.5.4-.9.9-.9zm4.7 3.6h6.1c.5 0 .9.4.9.9v6.1c0 .5-.4.9-.9.9H7.3a.9.9 0 0 1-.9-.9V6.7c0-.5.4-.9.9-.9z');
    svg.appendChild(p);
    return svg;
  }

  function isCoarsePointer() {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  }

  /** Remove all injected UI (used when the user disables the extension). */
  function teardown() {
    document.querySelectorAll(`.${NS}-cluster`).forEach((n) => n.remove());
    document.querySelectorAll(`a[data-fmhys="1"]`).forEach((a) => {
      a.classList.remove(`${NS}-linked`);
      a.removeAttribute('data-fmhys');
    });
    document.querySelectorAll('[data-fmhys-dbl]').forEach((n) => delete n.dataset.fmhysDbl);
  }

  FMHYS.indicators = { decorate, updateFavorite, teardown, isCoarsePointer, NS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
