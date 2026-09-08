/**
 * Database manager — owns the resource dataset, its search index and the
 * similarity engine. Lives in the service worker; content scripts and UI
 * pages talk to it over runtime messaging so the index is built ONCE per
 * browser session rather than once per tab.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const S = FMHYS.storage;
  const B = FMHYS.browser;

  const state = {
    dataset: null,
    index: null,
    engine: null,
    status: 'idle',   // idle | loading | ready | empty | error
    error: null,
    loadPromise: null
  };

  /**
   * Bundled seed dataset shipped with the extension.
   * Accepts either the packed storage form or a plain {meta,resources} envelope,
   * so a hand-authored dataset can be dropped in during development.
   */
  async function loadSeed() {
    const url = B.runtime.getURL('database/resources.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Seed dataset missing (' + res.status + ')');
    const raw = await res.json();
    if (raw && raw.format === FMHYS.codec.FORMAT) {
      const unpacked = FMHYS.codec.unpack(raw);
      if (!unpacked) throw new Error('Bundled dataset is corrupt.');
      return { meta: {
        version: unpacked.version, source: unpacked.source, generatedAt: unpacked.generatedAt
      }, resources: unpacked.resources };
    }
    return raw;
  }

  function buildIndexes(dataset) {
    state.dataset = dataset;
    state.index = new FMHYS.search.SearchIndex(dataset.resources);
    state.engine = new FMHYS.similarity.SimilarityEngine(state.index);
    state.status = dataset.resources.length ? 'ready' : 'empty';
    state.error = null;
  }

  /**
   * Ensure the database is loaded and indexed.
   * Order: user-installed DB (storage.local) -> bundled seed -> empty.
   */
  function ensureReady() {
    if (state.status === 'ready' && state.index) return Promise.resolve(state);
    if (state.loadPromise) return state.loadPromise;

    state.status = 'loading';
    state.loadPromise = (async () => {
      try {
        let dataset = await S.loadDatabase(false);
        if (!dataset || !Array.isArray(dataset.resources) || dataset.resources.length === 0) {
          // Nothing installed (or torn) — try the backup, then the bundled seed.
          dataset = await S.loadDatabase(true);
        }
        if (!dataset || !dataset.resources || dataset.resources.length === 0) {
          const seedRaw = await loadSeed();
          const v = FMHYS.schema.validateDataset(seedRaw);
          if (!v.ok) throw new Error('Bundled dataset failed validation: ' + v.errors.join('; '));
          dataset = v.dataset;
          try { await S.saveDatabase(dataset); } catch (e) { /* index still usable in-memory */ }
        }
        buildIndexes(dataset);
      } catch (err) {
        state.status = 'error';
        state.error = String(err && err.message || err);
        state.dataset = null;
        state.index = null;
        state.engine = null;
      } finally {
        state.loadPromise = null;
      }
      return state;
    })();

    return state.loadPromise;
  }

  function meta() {
    if (!state.dataset) {
      return { available: false, status: state.status, error: state.error, count: 0 };
    }
    return {
      available: state.status === 'ready',
      status: state.status,
      error: state.error,
      schemaVersion: state.dataset.schemaVersion,
      version: state.dataset.version,
      source: state.dataset.source,
      generatedAt: state.dataset.generatedAt,
      installedAt: state.dataset.installedAt || null,
      count: state.dataset.resources.length,
      categories: state.index ? state.index.categories() : []
    };
  }

  // ------------------------------------------------------------- operations

  async function lookupByUrl(url) {
    await ensureReady();
    if (!state.index) return null;
    return state.index.findByUrl(url);
  }

  /**
   * Batch resolution — one message per page instead of one per link.
   *
   * Each entry is `{ key, url, name, category }`. We match by canonical URL
   * first (exact and reliable); when the page contains an entry newer than the
   * installed database we fall back to a tightly-constrained name search so the
   * link still gets an indicator instead of silently disappearing.
   *
   * @param {Array<object>|Array<string>} entries
   * @returns {Object<string, object>} key -> resource
   */
  async function resolveMany(entries) {
    await ensureReady();
    const out = {};
    if (!state.index) return out;

    for (const raw of entries) {
      const entry = typeof raw === 'string' ? { key: raw, url: raw } : raw;
      if (!entry || !entry.key) continue;

      let hit = entry.url ? state.index.findByUrl(entry.url) : null;

      if (!hit && entry.name && entry.name.length >= 3) {
        const results = state.index.search(entry.name, { limit: 3, fuzzy: false });
        const wantHost = FMHYS.url.registrableDomain(entry.url || '');
        for (const r of results) {
          const sameName = r.doc.name.toLowerCase() === entry.name.toLowerCase();
          const sameHost = wantHost && FMHYS.url.registrableDomain(r.doc.url) === wantHost;
          if (sameHost || (sameName && (!entry.category || r.doc.category === entry.category))) {
            hit = r.doc;
            break;
          }
        }
      }

      if (hit) out[entry.key] = hit;
    }
    return out;
  }

  async function findSimilar(resourceId, opts) {
    await ensureReady();
    if (!state.engine) return [];
    return state.engine.findSimilar(resourceId, opts);
  }

  async function search(query, opts) {
    await ensureReady();
    if (!state.index) return [];
    return state.index.search(query, opts).map((r) => ({ resource: r.doc, score: r.score }));
  }

  // ---------------------------------------------------------------- updating

  /**
   * Fetch + validate + install a fresh dataset.
   *
   * Safety contract:
   *  - Network failure  -> keep the existing DB, report the error.
   *  - Validation fail  -> keep the existing DB, report why.
   *  - Write failure    -> restore the backup snapshot.
   *
   * @param {object} [opts] { mode: 'repo'|'single', onProgress }
   */
  async function update(opts) {
    const o = opts || {};
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
    const started = Date.now();

    let raw;
    try {
      raw = await fetchDataset(o.mode || 'repo', onProgress);
    } catch (err) {
      const result = { ok: false, phase: 'download', error: String(err && err.message || err) };
      await S.pushUpdateLog(result);
      return result;
    }

    onProgress({ phase: 'validate' });
    const v = FMHYS.schema.validateDataset(raw);
    if (!v.ok) {
      const result = {
        ok: false, phase: 'validate',
        error: v.errors.join(' '),
        stats: v.stats
      };
      await S.pushUpdateLog(result);
      return result;
    }

    // Guard: never replace a healthy DB with a drastically smaller one.
    const currentMeta = await S.getDatabaseMeta();
    if (currentMeta && currentMeta.count > 200 && v.dataset.resources.length < currentMeta.count * 0.5) {
      const result = {
        ok: false, phase: 'sanity',
        error: `New dataset has ${v.dataset.resources.length} resources vs ${currentMeta.count} installed ` +
               `(>50% shrink). Kept the existing database.`,
        stats: v.stats
      };
      await S.pushUpdateLog(result);
      return result;
    }

    onProgress({ phase: 'install' });
    try {
      const installedMeta = await S.saveDatabase(v.dataset);
      v.dataset.installedAt = installedMeta.installedAt;
      buildIndexes(v.dataset);
      const result = {
        ok: true, phase: 'done',
        version: installedMeta.version,
        count: installedMeta.count,
        installedAt: installedMeta.installedAt,
        durationMs: Date.now() - started,
        stats: v.stats
      };
      await S.pushUpdateLog(result);
      return result;
    } catch (err) {
      await S.restoreBackup().catch(() => {});
      state.status = 'idle';
      await ensureReady();
      const result = { ok: false, phase: 'install', error: String(err && err.message || err) };
      await S.pushUpdateLog(result);
      return result;
    }
  }

  const FETCH_TIMEOUT = 25000;
  /** Politeness delay between page requests — we are a guest on their host. */
  const REQUEST_DELAY = 250;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        cache: 'no-cache',
        credentials: 'omit',
        redirect: 'follow'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      if (!text || text.length < 200) throw new Error(`Response too small from ${url}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Download the FMHY markdown and turn it into a dataset envelope.
   * `repo` mode: one request per wiki page from FMHY's own git mirror.
   * `single` mode: one request for the whole wiki.
   */
  async function fetchDataset(mode, onProgress) {
    const SRC = FMHYS.sources;
    const all = [];
    let source;

    if (mode === 'single') {
      source = SRC.SINGLE_PAGE;
      onProgress({ phase: 'download', current: 1, total: 1, label: 'single-page.md' });
      const md = await fetchText(source);
      // Build a category -> page map so anchors land on the right wiki page.
      const pageResolver = makeResolver(SRC.PAGES);
      const parsed = FMHYS.parser.parseMarkdown(md, { baseUrl: SRC.SITE, pageResolver });
      all.push(...parsed.resources);
    } else {
      source = SRC.REPO_RAW;
      const pages = SRC.PAGES;
      let failures = 0;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        onProgress({ phase: 'download', current: i + 1, total: pages.length, label: page.slug });
        try {
          const md = await fetchText(SRC.repoUrl(page));
          const parsed = FMHYS.parser.parseMarkdown(md, {
            baseUrl: SRC.SITE, page: page.slug
          });
          all.push(...parsed.resources);
        } catch (e) {
          failures++;
          if (failures > Math.max(3, pages.length / 3)) {
            throw new Error(`Too many page downloads failed (${failures}). Aborting update.`);
          }
        }
        if (i < pages.length - 1) await sleep(REQUEST_DELAY);
      }
      if (all.length === 0) throw new Error('No resources parsed from any page.');
    }

    return {
      meta: {
        version: new Date().toISOString().slice(0, 10),
        source,
        generatedAt: new Date().toISOString()
      },
      resources: all
    };
  }

  function makeResolver(pages) {
    // Map "Video Tools" -> "video-tools" etc. Falls back to a slug of the heading.
    const byTitle = new Map();
    for (const p of pages) {
      byTitle.set(p.title.toLowerCase(), p.slug);
      byTitle.set(p.slug.replace(/-/g, ' '), p.slug);
    }
    const cache = new Map();
    return function (categoryTitle) {
      const key = String(categoryTitle || '').toLowerCase();
      if (cache.has(key)) return cache.get(key);
      let slug = byTitle.get(key) || '';
      if (!slug) {
        const s = FMHYS.text.slugify(categoryTitle);
        for (const p of pages) {
          if (s === p.slug || s.startsWith(p.slug) || p.slug.startsWith(s)) { slug = p.slug; break; }
        }
      }
      cache.set(key, slug);
      return slug;
    };
  }

  /** Reset to the bundled seed dataset. */
  async function reset() {
    await S.clearDatabase();
    state.status = 'idle';
    state.dataset = null;
    state.index = null;
    state.engine = null;
    await ensureReady();
    await S.pushUpdateLog({ ok: true, phase: 'reset', count: state.dataset ? state.dataset.resources.length : 0 });
    return meta();
  }

  /** Install a dataset the user supplied by file (options page import). */
  async function importDataset(raw) {
    const v = FMHYS.schema.validateDataset(raw);
    if (!v.ok) {
      const result = { ok: false, phase: 'validate', error: v.errors.join(' '), stats: v.stats };
      await S.pushUpdateLog(Object.assign({ source: 'import' }, result));
      return result;
    }
    try {
      const installedMeta = await S.saveDatabase(v.dataset);
      v.dataset.installedAt = installedMeta.installedAt;
      buildIndexes(v.dataset);
      const result = { ok: true, phase: 'done', count: installedMeta.count, version: installedMeta.version, stats: v.stats };
      await S.pushUpdateLog(Object.assign({ source: 'import' }, result));
      return result;
    } catch (err) {
      await S.restoreBackup().catch(() => {});
      return { ok: false, phase: 'install', error: String(err && err.message || err) };
    }
  }

  FMHYS.database = {
    state, ensureReady, meta, lookupByUrl, resolveMany, findSimilar, search,
    update, reset, importDataset, fetchDataset
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
