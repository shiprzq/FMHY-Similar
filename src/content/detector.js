/**
 * Resource detector.
 *
 * Finds genuine resource links inside FMHY's rendered content and extracts
 * their metadata from the surrounding DOM. It never mutates the original
 * markup — it only reads it and records WeakMap-backed annotations.
 *
 * Detection rules (all must pass):
 *   - the link lives inside the article body (`.vp-doc` / `main`), not in
 *     the navigation, sidebar, header, footer, TOC, search modal or a button
 *   - it is an <a> inside an <li> of a content list
 *   - it points at an external http(s) destination (FMHY-internal anchors are
 *     navigation, not resources)
 *   - its label is not a metadata label ("GitHub", "2", "Discord", "Note"...)
 *   - the list item is not a cross-reference (↪️) or a Note/Warning callout
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const U = FMHYS.url;

  /** Containers whose links are chrome, never resources. */
  const EXCLUDED_ANCESTORS = [
    'nav', 'header', 'footer', 'aside', 'button', 'form',
    '.VPNav', '.VPNavBar', '.VPSidebar', '.VPLocalNav', '.VPFooter', '.VPDocFooter',
    '.VPDocAside', '.VPDocAsideOutline', '.VPLocalSearchBox', '.VPNavScreen',
    '.VPTeamMembers', '.VPCarbonAds', '.aside', '.outline', '.edit-link',
    '.pager-link', '.prev', '.next', '.header-anchor', '.feedback-widget',
    '.custom-block-title', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="search"]', '[role="dialog"]', '[aria-hidden="true"]',
    '.fmhys-popup', '.fmhys-ui'
  ].join(',');

  /** Where article content lives on fmhy.net (VitePress) and common mirrors. */
  const CONTENT_ROOTS = [
    '.vp-doc', '.VPDoc .content-container', 'main .content', 'main article', 'main', 'article'
  ];

  const META_LABELS = new Set([
    'github', 'gitlab', 'codeberg', 'sourceforge', 'bitbucket', 'source', 'repo',
    'discord', 'telegram', 'subreddit', 'reddit', 'matrix', 'irc', 'forum',
    'x', 'twitter', 'mastodon', 'bluesky', 'youtube', 'wiki', 'docs', 'doc',
    'guide', 'guides', 'tutorial', 'note', 'notes', 'info', 'faq',
    'mirror', 'mirrors', 'backup', 'status', 'donate', 'blog', 'changelog',
    'apk', 'android', 'ios', 'windows', 'mac', 'macos', 'linux', 'web',
    'extension', 'userscript', 'script', 'demo', 'download', 'downloads',
    'releases', 'install', 'invite', 'chat', 'support', 'license',
    'permalink', 'edit this page', 'view source'
  ]);

  const NUMERIC = /^\d{1,3}$/;

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function stripEmoji(s) {
    return s
      .replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')
      .replace(/[\u2190-\u2bff\ufe00-\ufe0f\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isMetaLabel(label) {
    const l = stripEmoji(label).toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
    if (!l) return true;
    if (NUMERIC.test(l)) return true;
    if (META_LABELS.has(l)) return true;
    const words = l.split(/\s+/);
    if (words.length <= 3 && words.every((w) => META_LABELS.has(w) || NUMERIC.test(w))) return true;
    return false;
  }

  function contentRoot(doc) {
    for (const sel of CONTENT_ROOTS) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Walk up from an <li> to find the nearest preceding heading, and the
   * heading above that, giving us (category, section).
   */
  function headingContext(li, rootEl) {
    let node = li.closest('ul, ol') || li;
    let h2 = '', h3 = '', h1 = '';
    let cur = node;
    while (cur && cur !== rootEl) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const tag = sib.tagName;
        if (tag === 'H4' || tag === 'H3') { if (!h3) h3 = headingText(sib); }
        else if (tag === 'H2') { if (!h2) h2 = headingText(sib); }
        else if (tag === 'H1') { if (!h1) h1 = headingText(sib); }
        if (h2 && h1) break;
        sib = sib.previousElementSibling;
      }
      if (h2 && h1) break;
      cur = cur.parentElement;
    }
    if (!h1) {
      const first = rootEl && rootEl.querySelector('h1');
      if (first) h1 = headingText(first);
    }
    return { h1, h2, h3 };
  }

  function headingText(h) {
    const clone = h.cloneNode(true);
    clone.querySelectorAll('a.header-anchor, button, .feedback-widget, [aria-hidden="true"]').forEach((n) => n.remove());
    return stripEmoji(textOf(clone).replace(/^[\u25ba\u25b7\u25b8\u2023\u2022\s]+/, ''));
  }

  /**
   * The trailing " - description" of a list item.
   *
   * We must NOT split the text on " / ", because real descriptions contain it
   * ("CD / DVD Burning"). Instead we delete the trailing metadata *anchors*
   * from a clone, which removes "/ GitHub / Discord" precisely while leaving
   * plain-text slashes intact.
   */
  function itemDescription(li, primaryEl) {
    const clone = li.cloneNode(true);
    clone.querySelectorAll('ul, ol, .fmhys-ui, .fmhys-cluster').forEach((n) => n.remove());

    // Drop every anchor: link labels are names/mirrors, never the description.
    clone.querySelectorAll('a').forEach((n) => n.remove());

    let text = stripEmoji(textOf(clone));
    if (!text) return '';

    // What remains is roughly: ", " + " / " separators + " - Description".
    const idx = text.indexOf(' - ');
    let desc = idx >= 0 ? text.slice(idx + 3) : '';

    if (!desc) {
      // Some items have no explicit separator; keep whatever prose is left.
      desc = text.replace(/^[\s,\-\u2013/]+/, '');
      // Pure separator residue ("/ /", ", or") is not a description.
      if (!/[\p{L}\p{N}]/u.test(desc)) desc = '';
    }

    // Clean separator residue left behind by the removed anchors.
    desc = desc
      .replace(/\s*\/\s*(?=\s*\/|$)/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s,/\u2013-]+$/, '')
      .trim();

    return desc.slice(0, 400);
  }

  /** Is this <a> a real resource link within the article body? */
  function isCandidate(a, rootEl) {
    if (!a || a.nodeType !== 1) return false;
    if (a.closest('.fmhys-ui, .fmhys-popup')) return false;
    if (!rootEl.contains(a)) return false;
    if (a.closest(EXCLUDED_ANCESTORS)) return false;

    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return false;

    const abs = U.resolveFmhy(href, location.href);
    if (!U.isSafe(abs)) return false;
    // Links back into FMHY are navigation between wiki sections.
    if (U.isFmhyUrl(abs)) return false;

    const li = a.closest('li');
    if (!li) return false;
    if (li.closest('.custom-block')) return false; // Note/Tip/Warning callouts

    // Cross-reference bullets (↪️) point at other wiki sections, not resources.
    const liText = li.textContent || '';
    if (liText.indexOf('\u21aa') !== -1) return false;

    const label = stripEmoji(textOf(a));
    if (!label || label.length > 120) return false;
    if (isMetaLabel(label)) return false;

    return true;
  }

  /**
   * Scan a subtree and return newly-found candidates.
   * @param {Element} scope
   * @param {WeakSet} seen  links already processed
   */
  function scan(scope, seen) {
    const rootEl = contentRoot(document);
    if (!rootEl) return [];
    const within = scope && rootEl.contains(scope) ? scope : rootEl;
    const anchors = within.querySelectorAll('a[href]');
    const out = [];

    for (const a of anchors) {
      if (seen.has(a)) continue;
      if (!isCandidate(a, rootEl)) { seen.add(a); continue; }
      seen.add(a);

      const li = a.closest('li');
      const { h1, h2, h3 } = headingContext(li, rootEl);
      const category = h1 || document.title.replace(/\s*[•|].*$/, '').trim() || 'FMHY';
      const section = h3 || h2 || category;
      const subcategory = (h3 && h2) ? h3 : (h2 && h2 !== category ? h2 : '');

      out.push({
        el: a,
        li,
        url: U.safeHref(U.resolveFmhy(a.getAttribute('href'), location.href)),
        name: stripEmoji(textOf(a)),
        category,
        section,
        subcategory,
        description: itemDescription(li, a),
        starred: !!li.querySelector('.starred, .i-twemoji-star') || (li.textContent || '').indexOf('\u2b50') !== -1,
        pageUrl: location.origin + location.pathname
      });
    }
    return out;
  }

  FMHYS.detector = {
    scan, isCandidate, contentRoot, headingContext, itemDescription,
    isMetaLabel, stripEmoji, EXCLUDED_ANCESTORS
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
