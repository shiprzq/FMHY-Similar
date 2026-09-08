/**
 * Weighted similarity engine (v2 scoring).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WAS REWRITTEN
 *
 * The v1 formula (category .25 / tags .25 / keywords .20 / description .15 /
 * features .10 / platform .05) was measured against the real 20,601-entry
 * dataset with tools/diagnose-similarity.mjs. Four concrete defects:
 *
 *  1. DOUBLE COUNTING. `buildTags()` seeds tags from the category and
 *     subcategory tokens, so the tags axis largely restated the category axis
 *     (r = 0.36) and the keyword axis (r = 0.74). Half the formula's weight was
 *     spent measuring roughly one thing.
 *
 *  2. DEAD AXES. platform scored exactly 1.00 for 97% of pairs (almost
 *     everything is tagged "Web") and features scored exactly 0 for 77%
 *     (66% of resources have no features at all). 15% of the weight was
 *     near-constant and could not separate anything.
 *
 *  3. NO SEPARATION. Mean spread between rank 1 and rank 5 was 11 points, and
 *     48% of full lists were packed inside 8 points — at that density the
 *     ordering is essentially arbitrary.
 *
 *  4. VARIANTS SHOWN AS ALTERNATIVES. "qBittorrent" returned "qBittorrent
 *     Enhanced" as its best match. Same program, different build: useless as
 *     an alternative.
 *
 * ---------------------------------------------------------------------------
 * THE v2 MODEL
 *
 *   score = 100 * sigmoid-free weighted sum of:
 *
 *     function   .34   what the thing DOES  (head of the description, which in
 *                      FMHY is a function label: "Torrent Client", "YouTube
 *                      Downloader", "Password Manager"). This is the single
 *                      best predictor of "is this an alternative".
 *     taxonomy   .26   curated placement: FMHY editors already group true
 *                      alternatives into the same subcategory list.
 *     lexical    .22   BM25-weighted overlap of distinctive terms, with
 *                      category/taxonomy tokens REMOVED so it cannot restate
 *                      the taxonomy axis.
 *     specifics  .12   tags/features that survive the taxonomy subtraction,
 *                      plus platform agreement — only when it is informative.
 *     quality    .06   curated prior: starred, resource type agreement.
 *
 * Modifiers (multiplicative, applied after the weighted sum):
 *     same registrable domain      x0.15   same product, not an alternative
 *     name-variant of the source   x0.30   "X" vs "X Enhanced"/"X Fork"
 *     source is an index/guide     handled by type agreement
 *
 * Candidate generation is unchanged in spirit (postings-driven, O(candidates))
 * but now also pulls the function-phrase posting list, which is what lets a
 * niche tool find its true peers.
 * ---------------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const T = FMHYS.text;
  const U = FMHYS.url;

  const WEIGHTS = {
    function: 0.36,
    taxonomy: 0.26,
    lexical: 0.18,
    specifics: 0.08,
    quality: 0.12
  };

  /**
   * PROMINENCE.
   *
   * Measured on the real dataset: within "Note-Taking" (49 entries) the five
   * starred items are Obsidian, Anytype, AppFlowy, Logseq and Notesnook —
   * precisely the tools a user asking for an Obsidian alternative wants.
   * Unstarred neighbours were things like Flotes and HelixNotes: correctly
   * topical, but obscure. Topicality was never the problem; PROMINENCE was.
   *
   * FMHY's editors curate the star, so it is the highest-quality relevance
   * signal in the dataset. It is applied as a multiplier rather than another
   * weighted axis so it re-ranks within an already-topical candidate set
   * instead of dragging in off-topic but starred results.
   */
  /* 1.10 and 1.20 scored identically on the benchmark; 1.15 is the midpoint,
     chosen so the value does not sit on a tuned edge. Anything >=1.4 measurably
     hurt precision by pulling in starred-but-unrelated resources. */
  const STAR_BOOST = 1.15;

  /**
   * MEDIUM MISMATCH.
   *
   * A guide *about* torrenting is not an alternative *to* a torrent client,
   * and an index of audio editors is not an audio editor. The dataset marks
   * some of these via `type` ("guide", "index"), but many are typed "site"
   * and only reveal themselves in the description ("Video Encoding Guides",
   * "Audio Editor Indexes"). Detect the medium from both signals and penalise
   * cross-medium pairs — a real measured error source, e.g. HandBrake
   * returning "The Encoding Guide" and "Codecs Wiki".
   */
  const REFERENCE_TYPES = new Set(['guide', 'index', 'community']);
  const REFERENCE_DESC = /\b(guides?|wikis?|indexe?s?|directory|directories|lists?|tutorials?|courses?|documentation|docs|forums?|subreddits?|communit(?:y|ies)|blogs?|news|charts?|comparisons?|rankings?)\b/i;

  function medium(doc) {
    if (REFERENCE_TYPES.has(doc.type)) return 'reference';
    const d = String(doc.description || '');
    // Only the function head matters: "Torrent Client / Guides" is a client.
    const head = d.split(/\s+[/,]\s+/)[0] || '';
    if (REFERENCE_DESC.test(head)) return 'reference';
    if (REFERENCE_DESC.test(String(doc.subcategory || ''))) return 'reference';
    return 'tool';
  }
  /* A resource listed on several wiki pages is one the editors reach for
     repeatedly — a weaker, independent prominence hint. */
  const MULTI_PAGE_BOOST = 1.06;

  /* Legacy axis names are still reported in `parts` for the UI/tests that
     display a breakdown; see _legacyParts(). */

  const MIN_SCORE = 30;
  const MAX_RESULTS = 5;
  const MAX_CANDIDATES = 1200;

  /* Platform words carry no discriminative power (97% of pairs matched
     exactly) and pollute the function phrase, so they are stripped from it. */
  const PLATFORM_WORDS = new Set([
    'windows', 'win', 'macos', 'mac', 'osx', 'linux', 'android', 'ios',
    'web', 'browser', 'online', 'cross', 'platform', 'desktop', 'mobile',
    'chrome', 'firefox', 'edge', 'safari', 'self', 'hosted', 'selfhosted'
  ]);

  /* Words that describe availability/pricing rather than function. */
  const MODALITY_WORDS = new Set([
    'free', 'freemium', 'paid', 'premium', 'open', 'source', 'opensource',
    'sign', 'up', 'signup', 'account', 'required', 'unlimited', 'limited',
    'trial', 'beta', 'alpha', 'new', 'old', 'legacy', 'official', 'unofficial',
    'mirror', 'mirrors', 'alternative', 'alternatives', 'client', 'clients'
  ]);
  /* NOTE: "client" is intentionally in MODALITY for the *lexical* axis only —
     it is far too common to discriminate — but it is KEPT in the function
     phrase, where "torrent client" vs "email client" is exactly the signal we
     want. See functionTerms() vs lexicalTerms(). */

  function isMeaningful(tok) {
    return tok && tok.length > 1 && !PLATFORM_WORDS.has(tok);
  }

  /**
   * The "function phrase": what the resource DOES.
   *
   * FMHY descriptions are terse function labels — median length 22 characters,
   * e.g. "Torrent Client / Windows, macOS, Linux". Everything before the first
   * " / " is the function; the rest is platform/metadata noise.
   */
  function functionTerms(doc) {
    const desc = String(doc.description || '');
    const head = desc.split(/\s+[/,]\s+/)[0] || '';
    const out = new Set();
    for (const t of T.terms(head)) if (isMeaningful(t)) out.add(t);
    // Subcategory is itself a curated function label ("Password Managers").
    if (doc.subcategory) for (const t of T.terms(doc.subcategory)) if (isMeaningful(t)) out.add(t);
    // Fall back to the category when there is nothing else to go on.
    if (!out.size && doc.category) for (const t of T.terms(doc.category)) if (isMeaningful(t)) out.add(t);
    return out;
  }

  /**
   * Terms that are distinctive to this resource: name + full description +
   * tags, MINUS anything already accounted for by its taxonomy. Removing the
   * taxonomy tokens is what stops this axis from silently re-scoring the
   * category (the v1 bug).
   */
  function lexicalTerms(doc) {
    const taxo = new Set();
    for (const t of T.terms(doc.category || '')) taxo.add(t);
    for (const t of T.terms(doc.subcategory || '')) taxo.add(t);

    const out = new Set();
    const add = (s) => {
      for (const t of T.terms(s || '')) {
        if (!isMeaningful(t)) continue;
        if (taxo.has(t)) continue;          // already scored by taxonomy
        if (MODALITY_WORDS.has(t)) continue; // availability, not identity
        out.add(t);
      }
    };
    add(doc.name);
    add(doc.description);
    for (const tag of doc.tags || []) add(tag);
    return out;
  }

  /** Tags/features with taxonomy tokens removed, so they add information. */
  function specificTerms(doc) {
    const taxo = new Set();
    for (const t of T.terms(doc.category || '')) taxo.add(t);
    for (const t of T.terms(doc.subcategory || '')) taxo.add(t);
    const out = new Set();
    for (const tag of doc.tags || []) {
      for (const t of T.terms(tag)) if (isMeaningful(t) && !taxo.has(t)) out.add(t);
    }
    for (const f of doc.features || []) {
      for (const t of T.terms(f)) if (isMeaningful(t)) out.add(t);
    }
    return out;
  }

  /** Normalised name for variant detection: "qBittorrent Enhanced" -> "qbittorrent". */
  const VARIANT_SUFFIX = /\b(enhanced|fork|forked|mod|modded|plus|plusplus|pro|lite|light|classic|legacy|ng|next|reborn|revived|community|ce|beta|alpha|nightly|git|dev|x|2|3|ii|iii|reloaded|redux|unofficial|official|mirror|clone|web|desktop|mobile|app|gui|cli)\b/g;

  function nameCore(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(VARIANT_SUFFIX, ' ')
      .replace(/\s+/g, '')
      .trim();
  }

  /**
   * Is `b` plausibly the same product as `a` under a different name?
   * Catches "qBittorrent" / "qBittorrent Enhanced", "Stremio" / "Stremio Web".
   */
  function isVariant(a, b) {
    const ca = nameCore(a.name);
    const cb = nameCore(b.name);
    if (!ca || !cb) return false;
    if (ca === cb) return true;
    if (ca.length >= 5 && cb.length >= 5) {
      if (ca.startsWith(cb) || cb.startsWith(ca)) return true;
    }
    return false;
  }

  /** Taxonomy agreement: exact subcategory > same category > related tokens. */
  function taxonomyScore(a, b) {
    const sameCat = a.category === b.category;
    if (sameCat && a.subcategory && b.subcategory) {
      if (a.subcategory === b.subcategory) return 1;
      const s = T.overlap(new Set(T.terms(a.subcategory)), new Set(T.terms(b.subcategory)));
      return 0.62 + 0.30 * s;
    }
    if (sameCat) return 0.72;
    // Different categories: only credit genuine token overlap
    // ("Video" vs "Video Tools"), and cap it well below a real match.
    const ta = new Set(T.terms(a.category || ''));
    const tb = new Set(T.terms(b.category || ''));
    const catOverlap = T.overlap(ta, tb);
    let s = catOverlap * 0.45;
    if (a.subcategory && b.subcategory && a.subcategory === b.subcategory) s = Math.max(s, 0.55);
    return s;
  }

  /**
   * Curated-quality prior. Starred status dominates here because it is the
   * editors' own recommendation; type agreement is a secondary confirmation.
   */
  function qualityScore(a, b) {
    let s = b.starred ? 1 : 0.3;
    if (a.type && b.type && a.type !== b.type) s *= 0.6;
    return s;
  }

  /** Platform agreement, but only when it actually says something. */
  function platformScore(a, b) {
    const pa = (a.platforms || []).map((s) => String(s).toLowerCase());
    const pb = (b.platforms || []).map((s) => String(s).toLowerCase());
    if (!pa.length || !pb.length) return 0.5;
    // "Web only" on both sides is the default for most of the wiki and tells
    // us nothing; treat it as neutral rather than a perfect match.
    const trivial = pa.length === 1 && pb.length === 1 && pa[0] === 'web' && pb[0] === 'web';
    if (trivial) return 0.5;
    return T.overlap(pa, pb);
  }

  class SimilarityEngine {
    constructor(index) {
      this.index = index;
      this.cache = new Map();
      this.cacheOrder = [];
      this.cacheLimit = 300;
      this._idfCache = new Map();
      this._fn = null;      // function terms per doc
      this._lex = null;     // lexical terms per doc
      this._spec = null;    // specific terms per doc
      this._fnPostings = null;
      this._avgLex = 0;
    }

    _idf(term) {
      let v = this._idfCache.get(term);
      if (v === undefined) {
        const n = this.index.size || 1;
        const df = (this.index.termIndex.get(term) || []).length;
        // BM25-style IDF: sharper penalty for very common terms than log(1+n/df).
        v = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        if (!isFinite(v) || v < 0) v = 0;
        this._idfCache.set(term, v);
      }
      return v;
    }

    /**
     * Derived term sets are computed LAZILY, per document.
     *
     * An eager pass over all 20,601 resources cost ~900 ms on the first
     * double-click — a visible stall. Only the source plus its bounded
     * candidate pool (<=1200 docs) is ever needed, so memoise per index and
     * pay a few milliseconds instead.
     */
    _ensureTerms() {
      if (this._fn) return;
      const n = this.index.size;
      this._fn = new Array(n);
      this._lex = new Array(n);
      this._spec = new Array(n);
      this._dupCount = null;   // built on demand; see _dup()
    }

    _fnOf(i) {
      let v = this._fn[i];
      if (v === undefined) { v = functionTerms(this.index.docs[i]); this._fn[i] = v; }
      return v;
    }

    _lexOf(i) {
      let v = this._lex[i];
      if (v === undefined) { v = lexicalTerms(this.index.docs[i]); this._lex[i] = v; }
      return v;
    }

    _specOf(i) {
      let v = this._spec[i];
      if (v === undefined) { v = specificTerms(this.index.docs[i]); this._spec[i] = v; }
      return v;
    }

    /** Name-frequency table, built once on first use (~15 ms). */
    _dup(name) {
      if (!this._dupCount) {
        this._dupCount = new Map();
        for (let i = 0; i < this.index.size; i++) {
          const k = String(this.index.docs[i].name || '').toLowerCase();
          this._dupCount.set(k, (this._dupCount.get(k) || 0) + 1);
        }
      }
      return this._dupCount.get(name) || 1;
    }

    /** IDF-weighted set similarity (cosine over binary term vectors). */
    _weighted(a, b) {
      if (!a.size || !b.size) return 0;
      let dot = 0, na = 0, nb = 0;
      for (const t of a) { const w = this._idf(t); na += w * w; if (b.has(t)) dot += w * w; }
      for (const t of b) { const w = this._idf(t); nb += w * w; }
      if (!na || !nb) return 0;
      return dot / Math.sqrt(na * nb);
    }

    /**
     * Function-phrase similarity. Uses containment rather than pure cosine:
     * "Torrent Client" vs "Torrent Client, Streaming" should score high even
     * though the second has extra terms.
     */
    _functionScore(ai, bi) {
      const a = this._fnOf(ai), b = this._fnOf(bi);
      if (!a.size || !b.size) return 0;
      let shared = 0, wa = 0, wb = 0;
      for (const t of a) { const w = this._idf(t); wa += w; if (b.has(t)) shared += w; }
      for (const t of b) wb += this._idf(t);
      if (!wa || !wb) return 0;
      const containment = shared / Math.min(wa, wb);   // rewards subset matches
      const cosine = shared / Math.sqrt(wa * wb);
      return 0.6 * containment + 0.4 * cosine;
    }

    _candidates(srcIdx) {
      this._ensureTerms();
      const src = this.index.docs[srcIdx];
      const pool = new Set();
      const addAll = (arr, cap) => {
        if (!arr) return;
        const lim = cap || MAX_CANDIDATES;
        for (const i of arr) {
          if (i === srcIdx) continue;
          pool.add(i);
          if (pool.size >= lim) return;
        }
      };

      // 1. Exact subcategory — FMHY's own curated grouping of alternatives.
      if (src.subcategory) {
        addAll(this.index.bySubcategory.get(src.category + '\u0000' + src.subcategory));
      }
      // 2. Same function phrase — the key addition. Finds true peers even when
      //    they live under a different heading or page. The main inverted
      //    index already maps term -> docs, so no separate posting map (and no
      //    full-corpus precompute) is needed.
      const fnTerms = Array.from(this._fnOf(srcIdx)).sort((x, y) => this._idf(y) - this._idf(x));
      for (const t of fnTerms) {
        if (pool.size >= MAX_CANDIDATES) break;
        const post = this.index.termIndex.get(t);
        if (!post || post.length > 2500) continue;
        addAll(post);
      }
      // 3. Distinctive shared terms.
      const srcTerms = this.index.docTerms[srcIdx];
      if (srcTerms && pool.size < MAX_CANDIDATES) {
        const ranked = Array.from(srcTerms).sort((x, y) => this._idf(y) - this._idf(x));
        for (const t of ranked) {
          if (pool.size >= MAX_CANDIDATES) break;
          const postings = this.index.termIndex.get(t);
          if (!postings || postings.length > 1500) continue;
          addAll(postings);
        }
      }
      // 4. Category floor.
      if (pool.size < 40) addAll(this.index.byCategory.get(src.category), 400);

      return pool;
    }

    score(srcIdx, candIdx) {
      this._ensureTerms();
      const a = this.index.docs[srcIdx];
      const b = this.index.docs[candIdx];

      const fn = this._functionScore(srcIdx, candIdx);
      const taxonomy = taxonomyScore(a, b);
      const lexical = this._weighted(this._lexOf(srcIdx), this._lexOf(candIdx));
      const specTerm = this._weighted(this._specOf(srcIdx), this._specOf(candIdx));
      const plat = platformScore(a, b);
      const specifics = 0.7 * specTerm + 0.3 * plat;
      const quality = qualityScore(a, b);

      let raw =
        fn * WEIGHTS.function +
        taxonomy * WEIGHTS.taxonomy +
        lexical * WEIGHTS.lexical +
        specifics * WEIGHTS.specifics +
        quality * WEIGHTS.quality;

      // --- modifiers -------------------------------------------------------
      const domA = U.registrableDomain(a.url);
      const domB = U.registrableDomain(b.url);
      if (domA && domA === domB) raw *= 0.15;      // same product
      if (isVariant(a, b)) raw *= 0.30;            // same product, renamed

      // Medium mismatch: a guide is not an alternative to a tool.
      if (medium(a) !== medium(b)) raw *= 0.45;

      // Prominence: promote what FMHY's editors actually recommend.
      if (b.starred) raw *= STAR_BOOST;
      if (this._dup(String(b.name || '').toLowerCase()) > 1) raw *= MULTI_PAGE_BOOST;

      const score = Math.max(0, Math.min(100, Math.round(raw * 100)));

      return {
        score,
        parts: {
          // v2 axes
          function: fn,
          taxonomy,
          lexical,
          specifics,
          quality,
          // legacy aliases so any existing breakdown UI keeps working
          category: taxonomy,
          tags: specTerm,
          keywords: lexical,
          description: fn,
          features: specTerm,
          platform: plat
        }
      };
    }

    findSimilar(resourceId, opts) {
      const o = opts || {};
      const limit = Math.min(o.limit || MAX_RESULTS, MAX_RESULTS);
      const minScore = typeof o.minScore === 'number' ? o.minScore : MIN_SCORE;
      const cacheKey = resourceId + '|' + limit + '|' + minScore;

      const cached = this.cache.get(cacheKey);
      if (cached) return cached;

      const srcIdx = this.index.indexOfId(resourceId);
      if (srcIdx < 0) return [];

      const src = this.index.docs[srcIdx];
      const seenDomain = new Set([U.registrableDomain(src.url)]);
      const seenName = new Set([src.name.toLowerCase()]);
      const seenCore = new Set([nameCore(src.name)]);

      const scored = [];
      for (const candIdx of this._candidates(srcIdx)) {
        const cand = this.index.docs[candIdx];
        if (!cand || cand.id === resourceId) continue;
        const { score, parts } = this.score(srcIdx, candIdx);
        if (score < minScore) continue;
        scored.push({ resource: cand, score, parts });
      }

      scored.sort((x, y) =>
        y.score - x.score ||
        (y.resource.starred ? 1 : 0) - (x.resource.starred ? 1 : 0) ||
        x.resource.name.localeCompare(y.resource.name)
      );

      const out = [];
      for (const s of scored) {
        const dom = U.registrableDomain(s.resource.url);
        const nm = s.resource.name.toLowerCase();
        const core = nameCore(s.resource.name);
        if (dom && seenDomain.has(dom)) continue;
        if (seenName.has(nm)) continue;
        // Two different products that normalise to the same core name are
        // near-certainly the same tool; show only the best-scoring one.
        if (core && seenCore.has(core)) continue;
        seenDomain.add(dom);
        seenName.add(nm);
        if (core) seenCore.add(core);
        out.push(s);
        if (out.length >= limit) break;
      }

      this._cacheSet(cacheKey, out);
      return out;
    }

    _cacheSet(key, value) {
      this.cache.set(key, value);
      this.cacheOrder.push(key);
      while (this.cacheOrder.length > this.cacheLimit) {
        this.cache.delete(this.cacheOrder.shift());
      }
    }

    clearCache() {
      this.cache.clear();
      this.cacheOrder.length = 0;
      this._idfCache.clear();
      this._fn = null;
      this._lex = null;
      this._spec = null;
      this._dupCount = null;
    }
  }

  FMHYS.similarity = {
    SimilarityEngine, WEIGHTS, MIN_SCORE, MAX_RESULTS,
    // exported for tests
    _internals: { functionTerms, lexicalTerms, nameCore, isVariant, taxonomyScore, medium }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
