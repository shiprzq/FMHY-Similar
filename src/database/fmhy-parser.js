/**
 * FMHY markdown -> structured resource records.
 *
 * Source of truth: the FMHY wiki's own published markdown, e.g.
 *   https://fmhy.net/single-page.md
 *   https://raw.githubusercontent.com/fmhy/edit/main/docs/<page>.md
 *
 * This is NOT a scraper: it parses ONE already-published, machine-readable
 * document that FMHY provides for exactly this purpose. It performs no
 * per-page crawling and no per-interaction network access.
 *
 * FMHY line grammar (observed):
 *   # ► Video Tools                 -> top-level category heading
 *   ## ▷ Disc Utilities             -> subcategory heading
 *   * ⭐ **[Name](url)** - Desc / [Mirror](url) / [GitHub](url)
 *   * [A](u1), [B](u2) or [C](u3) - Shared description
 *   * ↪️ **[Cross reference](url)** -> ignored (navigation, not a resource)
 *   * **Note** - ...                -> ignored
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const T = FMHYS.text;
  const U = FMHYS.url;

  // ---------------------------------------------------------------- constants

  /** Emoji markers FMHY uses at the start of list items. */
  const MARK_STAR = '\u2b50';          // ⭐ community favourite
  const MARK_GLOBE = '\ud83c\udf10';   // 🌐 index / directory
  const MARK_REDIRECT = '\u21aa';      // ↪️ cross-reference to another section

  /** Link labels that are metadata, not the resource itself. */
  const META_LABELS = new Set([
    'github', 'gitlab', 'codeberg', 'sourceforge', 'source', 'src', 'repo',
    'discord', 'telegram', 'subreddit', 'reddit', 'matrix', 'irc', 'forum',
    'x', 'twitter', 'mastodon', 'bluesky', 'youtube', 'wiki', 'docs', 'doc',
    'guide', 'guides', 'tutorial', 'note', 'notes', 'info', 'faq', 'about',
    'mirror', 'mirrors', 'backup', 'status', 'donate', 'blog', 'changelog',
    'app', 'apk', 'android', 'ios', 'windows', 'mac', 'macos', 'linux',
    'web', 'webui', 'gui', 'cli', 'extension', 'userscript', 'script',
    'demo', 'download', 'downloads', 'releases', 'setup', 'install',
    'list', 'lists', 'comparison', 'review', 'video', 'image', 'screenshot',
    'invite', 'chat', 'contact', 'support', 'roadmap', 'license', 'privacy'
  ]);

  /** Pure-numeric labels like [2] [3] are alternate mirrors of the previous link. */
  const NUMERIC_LABEL = /^\d{1,2}$/;

  /**
   * Labels that are metadata even as PLAIN TEXT in a description tail.
   *
   * Deliberately narrower than META_LABELS: platform words (Windows, Android,
   * Linux…) are genuine description content when they appear as prose
   * ("Torrent Client / Windows, macOS, Linux"), and must not be stripped.
   */
  const TEXT_META_LABELS = new Set([
    'github', 'gitlab', 'codeberg', 'sourceforge', 'bitbucket', 'source', 'repo',
    'discord', 'telegram', 'subreddit', 'reddit', 'matrix', 'irc', 'forum',
    'twitter', 'mastodon', 'bluesky', 'wiki', 'docs', 'note', 'notes',
    'mirror', 'mirrors', 'backup', 'status', 'donate', 'blog', 'changelog',
    'invite', 'chat', 'support', 'license', 'releases'
  ]);

  function isTextMetaLabel(text) {
    const l = stripEmoji(String(text)).toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
    if (!l) return true;
    if (NUMERIC_LABEL.test(l)) return true;
    const words = l.split(/\s+/);
    if (words.length > 2) return false;
    return words.every((w) => TEXT_META_LABELS.has(w) || NUMERIC_LABEL.test(w));
  }

  /** Platform detection from description text. */
  const PLATFORM_PATTERNS = [
    [/\bwindows\b|\bwin(?:10|11|32|64)\b|\.exe\b/i, 'Windows'],
    [/\bmac(?:os)?\b|\bosx\b|\bapple silicon\b/i, 'macOS'],
    [/\blinux\b|\bubuntu\b|\bdebian\b|\bappimage\b|\bflatpak\b|\bsnap\b/i, 'Linux'],
    [/\bandroid\b|\bapk\b/i, 'Android'],
    [/\bios\b|\biphone\b|\bipad\b|\bipa\b|\bsideload/i, 'iOS'],
    [/\bself[- ]?host/i, 'Self-Hosted'],
    [/\bdocker\b/i, 'Docker'],
    [/\bcli\b|\bcommand[- ]line\b|\bterminal\b/i, 'CLI'],
    [/\bextension\b|\baddon\b|\badd-on\b|\buserscript\b/i, 'Browser Extension']
  ];

  const HOST_PLATFORM = [
    [/^chromewebstore\.google\.com$|^chrome\.google\.com$/, 'Browser Extension'],
    [/^addons\.mozilla\.org$/, 'Browser Extension'],
    [/^microsoftedge\.microsoft\.com$/, 'Browser Extension'],
    [/^greasyfork\.org$|^openuserjs\.org$/, 'Browser Extension'],
    [/^play\.google\.com$|^f-droid\.org$|^apt\.izzysoft\.de$/, 'Android'],
    [/^apps\.apple\.com$/, 'iOS'],
    [/^apps\.microsoft\.com$/, 'Windows'],
    [/^hub\.docker\.com$/, 'Docker']
  ];

  const HOST_TYPE = [
    [/^github\.com$|^gitlab\.com$|^codeberg\.org$|^sourceforge\.net$|^bitbucket\.org$/, 'software'],
    [/^chromewebstore\.google\.com$|^addons\.mozilla\.org$|^greasyfork\.org$/, 'extension'],
    [/^play\.google\.com$|^f-droid\.org$|^apps\.apple\.com$/, 'app'],
    [/^rentry\.(co|org)$|^reddit\.com$|^www\.reddit\.com$/, 'guide'],
    [/^discord\.(gg|com)$|^t\.me$|^matrix\.to$/, 'community']
  ];

  /** Feature keywords worth indexing as discrete capabilities. */
  const FEATURE_WORDS = [
    'download', 'downloader', 'streaming', 'stream', 'torrent', 'editor',
    'editing', 'converter', 'convert', 'compress', 'compression', 'player',
    'recorder', 'recording', 'encoder', 'encoding', 'ripper', 'ripping',
    'search', 'index', 'directory', 'tracker', 'database', 'proxy', 'vpn',
    'adblock', 'blocker', 'backup', 'sync', 'hosting', 'host', 'upload',
    'viewer', 'reader', 'generator', 'emulator', 'manager', 'scraper',
    'subtitles', 'subtitle', 'transcode', 'transcoding', 'ocr', 'archive',
    'anonymous', 'privacy', 'encryption', 'open-source', 'free', 'no-signup',
    'burning', 'burn', 'sharing', 'share', 'streaming-server', 'remux', 'mux',
    'unblock', 'bypass', 'mirror', 'cloud', 'notes', 'chat', 'translate',
    'self-hosted', 'offline', 'batch', 'api', 'library', 'organizer',
    'annotation', 'collaboration', 'monitoring', 'automation'
  ];

  // ------------------------------------------------------------ small helpers

  /**
   * FMHY's markdown contains invisible formatting characters (word joiners,
   * zero-width spaces, BOMs) that break separator detection — e.g.
   * "Download \u2060/ [Discord](…)" would not match a " / " split.
   * Normalise them away before any structural parsing.
   */
  function normalizeInvisibles(s) {
    return String(s)
      .replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, '')
      .replace(/\u00a0/g, ' ');
  }

  function stripEmoji(s) {
    return s
      .replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')
      .replace(/[\u2190-\u2bff\ufe00-\ufe0f\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripMd(s) {
    return stripEmoji(
      String(s)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\s+/g, ' ')
    ).trim();
  }

  /**
   * Extract markdown links with their character offsets.
   * Handles nested-bracket-free labels, which is all FMHY uses.
   */
  function extractLinks(line) {
    const out = [];
    const re = /\[([^\]]+)\]\(\s*(<?)([^()\s>]+(?:\([^()]*\)[^()\s>]*)*)\2\s*(?:"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push({
        label: stripMd(m[1]),
        rawLabel: m[1],
        href: m[3].trim(),
        start: m.index,
        end: m.index + m[0].length
      });
    }
    return out;
  }

  function isMetaLabel(label) {
    const l = label.toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
    if (!l) return true;
    if (NUMERIC_LABEL.test(label.trim())) return true;
    if (META_LABELS.has(l)) return true;
    // "GitHub Repo", "Android App", "Mirror 2", "Windows Guide"
    const words = l.split(/\s+/);
    if (words.length <= 3 && words.every((w) => META_LABELS.has(w) || NUMERIC_LABEL.test(w))) return true;
    return false;
  }

  function detectPlatforms(text, url) {
    const found = new Set();
    for (const [re, name] of PLATFORM_PATTERNS) if (re.test(text)) found.add(name);
    const host = U.hostOf(url);
    for (const [re, name] of HOST_PLATFORM) if (re.test(host)) found.add(name);
    if (found.size === 0) {
      // A bare website with no platform hints is reachable from the browser.
      if (host) found.add('Web');
    }
    return Array.from(found);
  }

  function detectType(text, url, isIndex) {
    if (isIndex) return 'index';
    const host = U.hostOf(url);
    for (const [re, t] of HOST_TYPE) if (re.test(host)) return t;
    if (/\bguide\b|\btutorial\b|\bhow to\b/i.test(text)) return 'guide';
    if (/\bindex\b|\bdirectory\b|\bcollection\b|\blist of\b/i.test(text)) return 'index';
    if (/\bextension\b|\buserscript\b/i.test(text)) return 'extension';
    if (/\bapp\b/i.test(text)) return 'app';
    if (/\bsoftware\b|\bclient\b|\bopen[- ]source\b/i.test(text)) return 'software';
    return 'site';
  }

  function detectFeatures(text) {
    const lower = text.toLowerCase();
    const out = [];
    for (const f of FEATURE_WORDS) {
      if (lower.includes(f)) out.push(f);
      if (out.length >= 16) break;
    }
    return out;
  }

  function buildTags(ctx) {
    const set = new Set();
    for (const t of T.tokenize(ctx.category)) set.add(t);
    if (ctx.subcategory) for (const t of T.tokenize(ctx.subcategory)) set.add(t);
    for (const t of T.tokenize(ctx.description).slice(0, 10)) set.add(t);
    const brand = U.brandToken(ctx.url);
    if (brand && brand.length > 2) set.add(brand);
    if (ctx.starred) set.add('recommended');
    if (ctx.type && ctx.type !== 'site') set.add(ctx.type);
    for (const p of ctx.platforms) set.add(p.toLowerCase());
    return Array.from(set).slice(0, 24);
  }

  /**
   * Turn the trailing segment of a list item into a clean description.
   *
   * FMHY appends supplementary links after the prose, separated by " / ":
   *     "Torrent Client / Windows, macOS, Linux / [Tools](…) / [GitHub](…)"
   * Those link labels are metadata, not description, so they must go — but
   * plain-text slashes inside real prose ("CD / DVD Burning", "Windows, macOS,
   * Linux") must be preserved. So we split on " / " *before* flattening the
   * markdown and drop only the segments that are pure links.
   */
  function cleanDescription(tail) {
    const empty = { text: '', mirrors: [] };
    if (!tail) return empty;
    const raw = String(tail).trim();
    if (!raw) return empty;

    // Split on " / " that is not inside a markdown link.
    const links = extractLinks(raw);
    const inLink = (i) => links.some((l) => i >= l.start && i < l.end);
    const segments = [];
    let start = 0;
    for (let i = 0; i < raw.length - 2; i++) {
      if (raw[i] === ' ' && raw[i + 1] === '/' && raw[i + 2] === ' ' && !inLink(i)) {
        segments.push(raw.slice(start, i));
        start = i + 3;
        i += 2;
      }
    }
    segments.push(raw.slice(start));

    const kept = [];
    const mirrors = [];
    let inMetadataTail = false;

    for (const seg of segments) {
      const s = seg.trim();
      if (!s) continue;

      const segLinks = extractLinks(s);
      const withoutLinks = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '').replace(/[*_`~,\s]/g, '');
      const isPureLinks = segLinks.length > 0 && withoutLinks === '';
      // A bare metadata word ("Telegram", "GitHub", "Discord") with no link.
      const isBareMeta = segLinks.length === 0 && isTextMetaLabel(stripMd(s));

      if (isPureLinks || isBareMeta) {
        // Once metadata starts, everything after it is metadata too.
        if (kept.length > 0) inMetadataTail = true;
        for (const l of segLinks) mirrors.push(l.href);
        continue;
      }

      if (inMetadataTail) {
        // Trailing prose after metadata is still metadata context; harvest any
        // links but do not extend the description.
        for (const l of segLinks) mirrors.push(l.href);
        continue;
      }

      kept.push(stripMd(s));
      for (const l of segLinks) mirrors.push(l.href);
    }

    // Trim any bare metadata word left at the very end of the prose.
    while (kept.length > 1 && isTextMetaLabel(kept[kept.length - 1])) kept.pop();

    const text = kept.join(' / ')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s/,\u2013-]+$/, '')
      .trim();

    return { text, mirrors };
  }

  /** Split a `* ...` list item into the link cluster and the trailing description. */
  function splitItem(body) {
    // FMHY uses " - " as the separator between links and their description.
    // Find the first " - " that sits OUTSIDE a markdown link.
    const links = extractLinks(body);
    const inLink = (i) => links.some((l) => i >= l.start && i < l.end);
    for (let i = 0; i < body.length - 2; i++) {
      if (body[i] === ' ' && (body[i + 1] === '-' || body[i + 1] === '\u2013') && body[i + 2] === ' ') {
        if (!inLink(i)) return { head: body.slice(0, i), tail: body.slice(i + 3) };
      }
    }
    return { head: body, tail: '' };
  }

  /**
   * From the head segment, pick the primary resource links (as opposed to
   * mirrors and metadata links).
   *
   * FMHY groups alternatives with `,` / ` or `; metadata follows a ` / `.
   */
  function primaryLinks(head) {
    const links = extractLinks(head);
    if (links.length === 0) return [];
    const out = [];
    let lastPrimary = null;

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const between = i === 0 ? '' : head.slice(links[i - 1].end, link.start);
      const meta = isMetaLabel(link.label);
      // A ` / ` separator means "supplementary link for the previous resource".
      const isSupplementary = /\//.test(between) && !/(,|\bor\b)/i.test(between);

      if (meta || (isSupplementary && lastPrimary)) {
        if (lastPrimary) lastPrimary.mirrors.push(link.href);
        continue;
      }
      lastPrimary = { label: link.label, href: link.href, mirrors: [] };
      out.push(lastPrimary);
    }
    return out;
  }

  // ------------------------------------------------------------------- parser

  /**
   * @param {string} markdown  Raw FMHY markdown (single-page or one doc page).
   * @param {object} [opts]
   * @param {string} [opts.page]     Page slug, e.g. "video-tools". Used for fmhyUrl.
   * @param {string} [opts.baseUrl]  Defaults to https://fmhy.net/
   * @param {(cat:string)=>string} [opts.pageResolver] Map a category heading to a page slug.
   * @returns {{resources:object[], stats:object}}
   */
  function parseMarkdown(markdown, opts) {
    const options = opts || {};
    const baseUrl = options.baseUrl || 'https://fmhy.net/';
    const pageResolver = options.pageResolver || null;
    const defaultPage = options.page || '';

    const stats = { lines: 0, items: 0, skipped: 0, produced: 0 };
    const resources = [];

    let category = 'Uncategorized';
    let categoryAnchor = '';
    let subcategory = '';
    let subAnchor = '';
    let page = defaultPage;

    const lines = normalizeInvisibles(markdown).split(/\r?\n/);
    stats.lines = lines.length;

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line) continue;

      // ---- headings
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const level = h[1].length;
        const title = stripMd(h[2].replace(/^[\u25ba\u25b7\u25b8\u2023\u2022\s]+/, ''));
        if (!title) continue;
        if (level <= 1) {
          category = title;
          categoryAnchor = T.slugify(title);
          subcategory = '';
          subAnchor = '';
          if (pageResolver) page = pageResolver(title) || defaultPage;
        } else {
          subcategory = title;
          subAnchor = T.slugify(title);
        }
        continue;
      }

      // ---- list items only
      const li = /^\s*[*\-+]\s+(.*)$/.exec(line);
      if (!li) continue;
      let body = li[1].trim();
      if (!body) continue;
      stats.items++;

      // Skip separators / notes / cross-references.
      if (/^\*{0,2}(note|warning|info|tip|psa|reminder)\b/i.test(stripMd(body))) { stats.skipped++; continue; }
      if (body.includes(MARK_REDIRECT)) { stats.skipped++; continue; }
      if (!/\[[^\]]+\]\(/.test(body)) { stats.skipped++; continue; }

      const starred = body.includes(MARK_STAR);
      const isIndex = body.includes(MARK_GLOBE);

      const { head, tail } = splitItem(body);
      const desc = cleanDescription(tail);
      const description = desc.text;
      const primaries = primaryLinks(head);
      if (primaries.length === 0) { stats.skipped++; continue; }

      const anchor = subAnchor || categoryAnchor;
      const pagePath = page ? page.replace(/^\/+/, '') : '';
      const fmhyUrl = U.resolveFmhy(
        (pagePath ? '/' + pagePath : '/') + (anchor ? '#' + anchor : ''),
        baseUrl
      );

      for (const p of primaries) {
        const url = U.safeHref(U.resolveFmhy(p.href, baseUrl));
        if (!url) { stats.skipped++; continue; }
        // A resource whose "url" is an FMHY anchor is navigation, not a resource.
        if (U.isFmhyUrl(url) && !/^https?:\/\/[^/]+\/[^#]/.test(url)) { stats.skipped++; continue; }

        const name = p.label;
        if (!name || name.length > 120) { stats.skipped++; continue; }

        const searchText = [name, description, category, subcategory].join(' ');
        const platforms = detectPlatforms(searchText, url);
        const type = detectType(searchText, url, isIndex);
        const features = detectFeatures([name, description].join(' '));

        const rec = {
          name,
          url,
          fmhyUrl,
          category,
          subcategory,
          section: subcategory || category,
          page: pagePath,
          description,
          platforms,
          features,
          type,
          starred,
          // Supplementary links from the link cluster AND from the trailing
          // metadata ("… / [GitHub](…)") are recorded as mirrors, never lost.
          mirrors: p.mirrors.concat(primaries.length === 1 ? desc.mirrors : [])
            .map((m) => U.safeHref(U.resolveFmhy(m, baseUrl)))
            .filter(Boolean)
        };
        rec.tags = buildTags({
          category, subcategory, description, url, starred, type, platforms
        });
        resources.push(rec);
        stats.produced++;
      }
    }

    return { resources, stats };
  }

  FMHYS.parser = {
    parseMarkdown, extractLinks, primaryLinks, splitItem, stripMd, cleanDescription, isTextMetaLabel, normalizeInvisibles,
    isMetaLabel, detectPlatforms, detectType, detectFeatures
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
