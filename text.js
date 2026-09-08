/**
 * Text utilities: slugify, tokenize, stopwords, stemming-lite, escaping.
 * Pure functions, no DOM access — safe in the service worker.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;

  const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'for', 'from',
    'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
    'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were',
    'will', 'with', 'you', 'your', 'via', 'also', 'any', 'all', 'more', 'most',
    'other', 'some', 'such', 'than', 'them', 'very', 'over', 'use', 'using',
    'used', 'get', 'gets', 'etc', 'e', 'g', 'ie'
  ]);

  /**
   * VitePress-compatible heading slug (used to build #anchors on fmhy.net).
   */
  function slugify(str) {
    return String(str)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      // strip emoji / symbols / private use
      .replace(/[\u2000-\u206f\u2190-\u2bff\ufe00-\ufe0f]/g, ' ')
      .replace(/[\ud800-\udbff][\udc00-\udfff]/g, ' ')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /** Very small suffix normaliser — cheap, deterministic, no dictionary. */
  function stem(word) {
    if (word.length <= 4) return word;
    if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
    if (word.endsWith('sses')) return word.slice(0, -2);
    if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
    if (word.endsWith('ers') && word.length > 6) return word.slice(0, -1);
    if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
    return word;
  }

  /** Lowercase word tokens with stopwords removed. */
  function tokenize(str) {
    if (!str) return [];
    const raw = String(str)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
      .split(' ');
    const out = [];
    for (const w of raw) {
      if (!w || w.length < 2) continue;
      if (STOPWORDS.has(w)) continue;
      out.push(w);
    }
    return out;
  }

  /** Tokenize + stem + dedupe. */
  function terms(str) {
    const seen = new Set();
    for (const t of tokenize(str)) seen.add(stem(t));
    return Array.from(seen);
  }

  /** Character trigrams, used for fuzzy matching. */
  function trigrams(str) {
    const s = '  ' + String(str).toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
    const out = new Set();
    for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
    return out;
  }

  /** Jaccard overlap of two Sets/Arrays, 0..1. */
  function jaccard(a, b) {
    const A = a instanceof Set ? a : new Set(a);
    const B = b instanceof Set ? b : new Set(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    const [small, large] = A.size < B.size ? [A, B] : [B, A];
    for (const v of small) if (large.has(v)) inter++;
    return inter / (A.size + B.size - inter);
  }

  /** Overlap coefficient — kinder than Jaccard for short tag lists. */
  function overlap(a, b) {
    const A = a instanceof Set ? a : new Set(a);
    const B = b instanceof Set ? b : new Set(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    const [small, large] = A.size < B.size ? [A, B] : [B, A];
    for (const v of small) if (large.has(v)) inter++;
    return inter / small.size;
  }

  /** Bounded Levenshtein distance (returns maxDist+1 when exceeded). */
  function levenshtein(a, b, maxDist) {
    const max = typeof maxDist === 'number' ? maxDist : 99;
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      let best = cur[0];
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  FMHYS.text = { STOPWORDS, slugify, stem, tokenize, terms, trigrams, jaccard, overlap, levenshtein };
})(typeof globalThis !== 'undefined' ? globalThis : self);
