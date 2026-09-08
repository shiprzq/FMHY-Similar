/**
 * Resource record schema + validation + normalisation.
 *
 * Canonical record:
 * {
 *   id:          "video-tools--imgburn--majorgeeks-com",   // stable, unique
 *   name:        "ImgBurn",
 *   url:         "https://www.majorgeeks.com/...",         // the resource itself
 *   fmhyUrl:     "https://fmhy.net/video-tools#disc-utilities",
 *   category:    "Video Tools",
 *   subcategory: "Disc Utilities",
 *   section:     "Disc Utilities",                          // heading text on page
 *   page:        "video-tools",
 *   description: "CD / DVD Burning",
 *   tags:        ["burning","dvd","disc"],
 *   platforms:   ["Windows"],
 *   features:    ["burning"],
 *   type:        "software",
 *   starred:     true,
 *   mirrors:     ["https://..."],
 *   updated:     "2026-09-05"
 * }
 *
 * ALL fields except id/name/url/fmhyUrl are optional. Validation is strict:
 * malformed entries are dropped rather than repaired into nonsense.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const U = FMHYS.url;

  const MAX = {
    name: 160, description: 400, category: 80, subcategory: 80, section: 120,
    page: 64, type: 32, tag: 40, platform: 32, feature: 48,
    tags: 24, platforms: 12, features: 16, mirrors: 12
  };

  const KNOWN_PLATFORMS = [
    'Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Web', 'Browser Extension',
    'Self-Hosted', 'CLI', 'Docker', 'Chrome OS'
  ];

  const KNOWN_TYPES = [
    'site', 'software', 'index', 'tool', 'guide', 'extension', 'app',
    'library', 'service', 'dataset', 'community'
  ];

  function str(v, max) {
    if (typeof v !== 'string') return '';
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max).trim() : s;
  }

  function strList(v, maxItems, maxLen, transform) {
    if (!Array.isArray(v)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of v) {
      let s = str(raw, maxLen);
      if (!s) continue;
      if (transform) s = transform(s);
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  /**
   * Validate + normalise one record.
   * @returns {{ok:true,value:object}|{ok:false,reason:string}}
   */
  function normalizeResource(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'not-an-object' };
    }

    const name = str(input.name, MAX.name);
    if (!name) return { ok: false, reason: 'missing-name' };

    const url = U.safeHref(input.url);
    if (!url) return { ok: false, reason: 'invalid-url' };

    const fmhyUrl = U.safeHref(input.fmhyUrl);
    if (!fmhyUrl) return { ok: false, reason: 'invalid-fmhyUrl' };
    if (!U.isFmhyUrl(fmhyUrl)) return { ok: false, reason: 'fmhyUrl-not-fmhy' };

    const category = str(input.category, MAX.category) || 'Uncategorized';
    const subcategory = str(input.subcategory, MAX.subcategory);
    const section = str(input.section, MAX.section) || subcategory || category;
    const page = str(input.page, MAX.page);
    const description = str(input.description, MAX.description);

    const tags = strList(input.tags, MAX.tags, MAX.tag, (s) => s.toLowerCase());
    const platforms = strList(input.platforms, MAX.platforms, MAX.platform);
    const features = strList(input.features, MAX.features, MAX.feature, (s) => s.toLowerCase());
    const mirrors = [];
    if (Array.isArray(input.mirrors)) {
      for (const m of input.mirrors.slice(0, MAX.mirrors)) {
        const h = U.safeHref(m);
        if (h && h !== url && !mirrors.includes(h)) mirrors.push(h);
      }
    }

    let type = str(input.type, MAX.type).toLowerCase();
    if (type && !KNOWN_TYPES.includes(type)) type = 'site';
    if (!type) type = 'site';

    const id = str(input.id, 200) || makeId({ page, category, name, url });

    const value = {
      id, name, url, fmhyUrl, category, subcategory, section, page,
      description, tags, platforms, features, type,
      starred: input.starred === true,
      mirrors
    };
    if (typeof input.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.updated)) {
      value.updated = input.updated;
    }
    return { ok: true, value };
  }

  function makeId(parts) {
    const T = FMHYS.text;
    const scope = T.slugify(parts.page || parts.category || 'x') || 'x';
    const nameSlug = T.slugify(parts.name) || 'r';
    const host = (U.hostOf(parts.url) || 'none').replace(/[^a-z0-9]+/g, '-');
    return `${scope}--${nameSlug}--${host}`.slice(0, 200);
  }

  /**
   * Deduplicate a normalised list.
   * Two records collide when they share an id, or share (lowercased name +
   * registrable domain). The richer record wins; mirrors get merged.
   */
  function dedupe(records) {
    const byKey = new Map();
    const order = [];

    const richness = (r) =>
      (r.description ? 3 : 0) + r.tags.length + r.features.length +
      r.platforms.length + (r.subcategory ? 1 : 0) + (r.starred ? 1 : 0);

    for (const r of records) {
      const keys = [
        'id:' + r.id,
        'nd:' + r.name.toLowerCase() + '|' + U.registrableDomain(r.url) + '|' + r.category.toLowerCase()
      ];
      let hit = null;
      for (const k of keys) {
        const existing = byKey.get(k);
        if (existing) { hit = existing; break; }
      }
      if (!hit) {
        const entry = { rec: r };
        for (const k of keys) byKey.set(k, entry);
        order.push(entry);
        continue;
      }
      // Merge into the richer record.
      const winner = richness(r) > richness(hit.rec) ? r : hit.rec;
      const loser = winner === r ? hit.rec : r;
      winner.mirrors = Array.from(new Set(winner.mirrors.concat(loser.mirrors, [loser.url])))
        .filter((u) => u !== winner.url)
        .slice(0, MAX.mirrors);
      if (!winner.description && loser.description) winner.description = loser.description;
      winner.tags = Array.from(new Set(winner.tags.concat(loser.tags))).slice(0, MAX.tags);
      winner.features = Array.from(new Set(winner.features.concat(loser.features))).slice(0, MAX.features);
      winner.platforms = Array.from(new Set(winner.platforms.concat(loser.platforms))).slice(0, MAX.platforms);
      winner.starred = winner.starred || loser.starred;
      hit.rec = winner;
      for (const k of keys) if (!byKey.has(k)) byKey.set(k, hit);
    }
    return order.map((e) => e.rec);
  }

  /**
   * Validate a whole dataset envelope.
   * @returns {{ok:boolean, errors:string[], dataset:object|null, stats:object}}
   */
  function validateDataset(raw) {
    const errors = [];
    const stats = { received: 0, rejected: 0, deduped: 0, accepted: 0, reasons: {} };

    if (!raw || typeof raw !== 'object') {
      return { ok: false, errors: ['Dataset is not an object.'], dataset: null, stats };
    }
    const list = Array.isArray(raw) ? raw : raw.resources;
    if (!Array.isArray(list)) {
      return { ok: false, errors: ['Dataset has no `resources` array.'], dataset: null, stats };
    }
    stats.received = list.length;

    const good = [];
    for (const item of list) {
      const res = normalizeResource(item);
      if (res.ok) good.push(res.value);
      else {
        stats.rejected++;
        stats.reasons[res.reason] = (stats.reasons[res.reason] || 0) + 1;
      }
    }

    const unique = dedupe(good);
    stats.deduped = good.length - unique.length;
    stats.accepted = unique.length;

    // Sanity floor: refuse to accept a dataset that is mostly garbage.
    if (unique.length === 0) errors.push('No valid resources after validation.');
    if (stats.received > 0 && stats.accepted / stats.received < 0.5) {
      errors.push(
        `Only ${stats.accepted}/${stats.received} entries were valid (<50%); refusing to install.`
      );
    }

    const meta = (raw && !Array.isArray(raw) && typeof raw.meta === 'object' && raw.meta) || {};
    const dataset = {
      schemaVersion: FMHYS.SCHEMA_VERSION,
      version: str(meta.version, 40) || new Date().toISOString().slice(0, 10),
      source: U.safeHref(meta.source) || str(meta.source, 200) || 'unknown',
      generatedAt: str(meta.generatedAt, 40) || new Date().toISOString(),
      resources: unique
    };

    return { ok: errors.length === 0, errors, dataset: errors.length ? null : dataset, stats };
  }

  FMHYS.schema = {
    normalizeResource, validateDataset, dedupe, makeId,
    KNOWN_PLATFORMS, KNOWN_TYPES, MAX
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
