/**
 * Client-side search index.
 *
 * Structure (all built once, O(n) over the dataset):
 *   - inverted term index      term -> [docIdx, ...]      (exact + partial via prefix trie-lite)
 *   - prefix map               3-char prefix -> [term...]  (partial matching without scanning)
 *   - trigram map              trigram -> [docIdx, ...]    (fuzzy candidate generation)
 *   - field weights            name > tags > category > description
 *
 * Query cost is proportional to the number of *matching* postings, never to
 * the dataset size, so it stays fast at tens of thousands of resources.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;
  const T = FMHYS.text;

  const FIELD_WEIGHT = { name: 6, tags: 3, subcategory: 2.5, category: 2, features: 2, description: 1 };

  function pushPosting(map, key, value) {
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    if (arr[arr.length - 1] !== value) arr.push(value);
  }

  class SearchIndex {
    constructor(resources) {
      this.docs = resources || [];
      this.termIndex = new Map();   // term -> Int-ish array of doc indices
      this.termWeight = new Map();  // `${term}\u0000${docIdx}` -> weight
      this.prefix = new Map();      // 3-char prefix -> Set(term)
      this.trigram = new Map();     // trigram -> array of doc indices
      this.byCategory = new Map();  // category -> [docIdx]
      this.bySubcategory = new Map();
      this.byId = new Map();
      this.byUrl = new Map();
      this.byHost = new Map();
      this.docTerms = [];           // docIdx -> Set(term)  (reused by similarity)
      this._build();
    }

    get size() { return this.docs.length; }

    _build() {
      const docs = this.docs;
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        this.byId.set(d.id, i);
        this.byUrl.set(normUrl(d.url), i);
        for (const m of d.mirrors || []) this.byUrl.set(normUrl(m), i);
        const host = FMHYS.url.registrableDomain(d.url);
        if (host) pushPosting(this.byHost, host, i);
        pushPosting(this.byCategory, d.category, i);
        if (d.subcategory) pushPosting(this.bySubcategory, d.category + '\u0000' + d.subcategory, i);

        const weights = new Map();
        const add = (text, w) => {
          for (const term of T.terms(text)) {
            weights.set(term, (weights.get(term) || 0) + w);
          }
        };
        add(d.name, FIELD_WEIGHT.name);
        add((d.tags || []).join(' '), FIELD_WEIGHT.tags);
        add(d.subcategory || '', FIELD_WEIGHT.subcategory);
        add(d.category || '', FIELD_WEIGHT.category);
        add((d.features || []).join(' '), FIELD_WEIGHT.features);
        add(d.description || '', FIELD_WEIGHT.description);

        const termSet = new Set();
        for (const [term, w] of weights) {
          termSet.add(term);
          pushPosting(this.termIndex, term, i);
          this.termWeight.set(term + '\u0000' + i, w);
          const p = term.slice(0, 3);
          let s = this.prefix.get(p);
          if (!s) { s = new Set(); this.prefix.set(p, s); }
          s.add(term);
        }
        this.docTerms.push(termSet);

        // Trigrams over the name only — keeps the fuzzy map compact.
        for (const g of T.trigrams(d.name)) pushPosting(this.trigram, g, i);
      }
    }

    /** Terms in the index that start with `p` (partial matching). */
    _expandPrefix(p) {
      if (p.length < 3) {
        // Short prefixes: scan only the prefix buckets that begin with p.
        const out = [];
        for (const [key, set] of this.prefix) {
          if (key.startsWith(p)) for (const t of set) out.push(t);
          if (out.length > 400) break;
        }
        return out;
      }
      const bucket = this.prefix.get(p.slice(0, 3));
      if (!bucket) return [];
      const out = [];
      for (const t of bucket) if (t.startsWith(p)) out.push(t);
      return out;
    }

    /** Fuzzy candidates for a mistyped term, via trigram overlap + edit distance. */
    _fuzzyTerms(term) {
      if (term.length < 4) return [];
      const bucket = this.prefix.get(term.slice(0, 3));
      const candidates = new Set();
      if (bucket) for (const t of bucket) candidates.add(t);
      // also try dropping/altering the first char (common typo class)
      for (const [key, set] of this.prefix) {
        if (key.length === 3 && key.slice(1) === term.slice(1, 3)) {
          for (const t of set) candidates.add(t);
        }
        if (candidates.size > 600) break;
      }
      const maxDist = term.length > 7 ? 2 : 1;
      const out = [];
      for (const c of candidates) {
        if (c === term) continue;
        if (Math.abs(c.length - term.length) > maxDist) continue;
        const d = T.levenshtein(term, c, maxDist);
        if (d <= maxDist) out.push({ term: c, penalty: 1 / (1 + d) });
      }
      out.sort((a, b) => b.penalty - a.penalty);
      return out.slice(0, 8);
    }

    /**
     * @param {string} query
     * @param {object} [opts] { limit, category, fuzzy }
     * @returns {Array<{doc:object, score:number, index:number}>}
     */
    search(query, opts) {
      const o = opts || {};
      const limit = o.limit || 20;
      const qTerms = T.terms(query);
      if (qTerms.length === 0) return [];

      const scores = new Map();
      const bump = (docIdx, amount) => {
        scores.set(docIdx, (scores.get(docIdx) || 0) + amount);
      };

      for (const qt of qTerms) {
        // 1. exact term
        const exact = this.termIndex.get(qt);
        if (exact) {
          for (const i of exact) bump(i, (this.termWeight.get(qt + '\u0000' + i) || 1) * 2.0);
        }
        // 2. prefix / partial
        for (const t of this._expandPrefix(qt)) {
          if (t === qt) continue;
          const postings = this.termIndex.get(t);
          if (!postings) continue;
          const ratio = qt.length / t.length;
          for (const i of postings) {
            bump(i, (this.termWeight.get(t + '\u0000' + i) || 1) * 0.9 * ratio);
          }
        }
        // 3. fuzzy fallback, only when the term found little
        if (o.fuzzy !== false && (!exact || exact.length === 0)) {
          for (const f of this._fuzzyTerms(qt)) {
            const postings = this.termIndex.get(f.term);
            if (!postings) continue;
            for (const i of postings) {
              bump(i, (this.termWeight.get(f.term + '\u0000' + i) || 1) * 0.5 * f.penalty);
            }
          }
        }
      }

      const results = [];
      const catFilter = o.category || null;
      for (const [i, raw] of scores) {
        const doc = this.docs[i];
        if (!doc) continue;
        if (catFilter && doc.category !== catFilter) continue;
        // Coverage bonus: reward docs matching more of the query's terms.
        let covered = 0;
        const dt = this.docTerms[i];
        for (const qt of qTerms) if (dt.has(qt)) covered++;
        let score = raw * (1 + covered / qTerms.length);
        if (doc.starred) score *= 1.12;
        // Exact-name match wins outright.
        if (doc.name.toLowerCase() === query.trim().toLowerCase()) score += 1000;
        results.push({ doc, score, index: i });
      }
      results.sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name));
      return results.slice(0, limit);
    }

    /** Direct lookups used by the detector. */
    findByUrl(url) {
      const i = this.byUrl.get(normUrl(url));
      return typeof i === 'number' ? this.docs[i] : null;
    }
    findById(id) {
      const i = this.byId.get(id);
      return typeof i === 'number' ? this.docs[i] : null;
    }
    indexOfId(id) {
      const i = this.byId.get(id);
      return typeof i === 'number' ? i : -1;
    }
    categories() {
      return Array.from(this.byCategory.keys()).sort();
    }
  }

  /** Canonical URL key: scheme-insensitive, no www, no trailing slash, no hash. */
  function normUrl(raw) {
    const u = FMHYS.url.parse(raw);
    if (!u) return String(raw || '').toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '');
    return host + path + (u.search || '');
  }

  FMHYS.search = { SearchIndex, normUrl, FIELD_WEIGHT };
})(typeof globalThis !== 'undefined' ? globalThis : self);
