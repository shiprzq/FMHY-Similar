#!/usr/bin/env node
/**
 * Test harness — exercises the extension's real modules under Node.
 *
 * Runs without npm dependencies or a real browser. The DOM shim in tools/dom.mjs
 * is good enough for the parser, schema, codec, search index, similarity engine
 * and detector to execute the same code paths that ship to users. Browser-only
 * code (popup/options rendering, service-worker lifecycle, animation timing) is
 * smoke-tested for load-order and selector hygiene.
 *
 * Usage: node tools/test.mjs
 */

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { loadExtension, manifestAssetPaths, SRC } from './lib.mjs';

let passed = 0, failed = 0;
const failures = [];

const assert = {
  ok(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); },
  equal(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg || 'equal'}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  },
  gt(a, b, msg) { if (!(a > b)) throw new Error(`${msg || 'greater than'}: ${a} > ${b}`); }
};

/* ------------------------------------------------------------- loaders */

const CORE = [
  'core/namespace.js',
  'core/browser.js',
  'core/text.js',
  'core/url-validator.js',
  'database/schema.js',
  'database/codec.js',
  'core/storage.js',
  'core/favorites.js',
  'core/search.js',
  'core/similarity.js'
];

class FakeArea {
  constructor() { this._data = new Map(); }
  get(keys) {
    return new Promise((resolve) => {
      if (keys == null) return resolve(Object.fromEntries(this._data));
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (this._data.has(k)) out[k] = this._data.get(k);
      }
      resolve(out);
    });
  }
  set(items) {
    return new Promise((resolve) => {
      for (const [k, v] of Object.entries(items || {})) this._data.set(k, v);
      resolve();
    });
  }
  remove(keys) {
    return new Promise((resolve) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) this._data.delete(k);
      resolve();
    });
  }
}

const chromeStub = () => ({
  runtime: { id: 'test', lastError: null, getManifest: () => ({ version: '0.0.0-test' }), onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
  storage: {
    local: new FakeArea(),
    sync: new FakeArea(),
    onChanged: { addListener() {}, removeListener() {} }
  },
  i18n: { getMessage: (k) => k },
  alarms: { create() {}, clear() {}, get() {}, onAlarm: { addListener() {}, removeListener() {} } },
  tabs: { create: async () => {} }
});

const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
async function runTests() {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; }
    catch (e) {
      failed++;
      failures.push({ name, error: e });
      console.log(`\x1b[31m✗\x1b[0m ${name}\n    ${e && e.stack ? String(e.stack).split('\n')[0] : e}`);
    }
  }
}

async function loadCore() {
  return loadExtension(CORE, { extra: { chrome: chromeStub(), browser: undefined } });
}

console.log('Loading core modules…');
const { FMHYS } = await loadCore();

/* ================================================================== tests */

// ------------------------ namespacing & API surface
t('namespace exposes VERSION', () => assert.ok(FMHYS.VERSION, 'VERSION missing'));
t('cross-browser shim exposes storage', () => assert.ok(FMHYS.browser && FMHYS.browser.storage));
t('url validator rejects javascript:', () => assert.equal(FMHYS.url.isSafe('javascript:alert(1)'), false));
t('url validator accepts https', () => assert.equal(FMHYS.url.isSafe('https://fmhy.net'), true));
t('url validator rejects credentials in URL', () => {
  assert.equal(FMHYS.url.safeHref('https://user:pass@evil.com/x'), '');
  assert.equal(FMHYS.url.isSafe('https://user:pass@evil.com/x'), false);
});

// ------------------------ text / tokenizer
t('slugify is stable (tokenizer prerequisite)', () => {
  assert.equal(FMHYS.text.slugify('Free · MP3 · Tools!'), 'free-mp3-tools');
});
t('tokenizer lowercases and drops stopwords', () => {
  const toks = FMHYS.text.terms('The best torrent client is qBittorrent');
  assert.ok(toks.includes('torrent'));
  assert.ok(toks.includes('qbittorrent'));
  assert.ok(!toks.includes('the'));
});
t('trigram index supports fuzzy matching', () => {
  const tri = FMHYS.text.trigrams('qbittorrent');
  assert.ok(tri.size > 3);
});

// ------------------------ schema
t('schema.normalizeResource fills sane defaults', () => {
  const { ok, value: rec, reason } = FMHYS.schema.normalizeResource({
    name: 'CoolApp', url: 'https://cool.example/', fmhyUrl: 'https://fmhy.net/tools#cool'
  });
  assert.ok(ok, 'normalize failed: ' + reason);
  assert.equal(rec.name, 'CoolApp');
  assert.equal(rec.url, 'https://cool.example/');
  assert.equal(rec.category, 'Uncategorized');
  assert.ok(rec.id && rec.id.length > 0);
});
t('schema.validateDataset drops invalid URLs', () => {
  // Give it enough valid records to clear the 50% floor.
  const good = [];
  for (let i = 0; i < 10; i++) {
    good.push({ id: 'ok' + i, name: 'OK ' + i, url: `https://ok${i}.example/`, fmhyUrl: 'https://fmhy.net/t#x' });
  }
  const result = FMHYS.schema.validateDataset({
    meta: { version: 'unit-test' },
    resources: [
      ...good,
      { id: 'bad', name: 'Bad', url: 'javascript:x', fmhyUrl: 'https://fmhy.net/t#x' }
    ]
  });
  assert.ok(result.ok, 'expected ok: ' + result.errors.join('; ') + ' reasons=' + JSON.stringify(result.stats.reasons));
  assert.equal(result.dataset.resources.length, good.length);
});
t('schema dedupe merges mirrors', () => {
  const a = FMHYS.schema.normalizeResource({ id: 'a', name: 'A', url: 'https://a.example/', fmhyUrl: 'https://fmhy.net/t#x', mirrors: ['https://m.example/'] });
  const b = FMHYS.schema.normalizeResource({ id: 'a', name: 'A', url: 'https://a.example/', fmhyUrl: 'https://fmhy.net/t#x', description: 'An app' });
  assert.ok(a.ok && b.ok);
  const [rec] = FMHYS.schema.dedupe([a.value, b.value]);
  assert.equal(rec.description, 'An app');
  assert.ok(Array.isArray(rec.mirrors) && rec.mirrors.length >= 1);
});

// ------------------------ codec round-trip
t('codec pack/unpack round-trip is lossless', () => {
  function codecRec(raw) {
    return FMHYS.schema.normalizeResource({ page: 'tools', section: raw.category, fmhyUrl: `https://fmhy.net/tools#${FMHYS.text.slugify(raw.category)}`, ...raw }).value;
  }
  const records = [
    codecRec({ id: 'a', name: 'Alpha', url: 'https://a.example/', tags: ['free', 'open-source'], category: 'Tools', platforms: ['Windows'] }),
    codecRec({ id: 'b', name: 'Beta', url: 'https://b.example/', tags: ['free'], category: 'Tools', description: 'A free tool', platforms: ['Linux', 'macOS'] }),
    codecRec({ id: 'c', name: 'Gamma', url: 'https://c.example/', tags: [], category: 'Privacy', platforms: ['Linux', 'macOS'] })
  ];
  const packed = FMHYS.codec.pack({
    schemaVersion: FMHYS.SCHEMA_VERSION,
    version: 'test', source: 'in-memory', generatedAt: new Date(0).toISOString(),
    resources: records
  });
  assert.ok(packed.dict && packed.dict.length >= 6);
  assert.ok(Array.isArray(packed.rows), 'packed.rows must be an array of interned tuples');
  const unpacked = FMHYS.codec.unpack(packed);
  assert.ok(unpacked, 'unpack returned null');
  assert.equal(unpacked.resources.length, records.length);
  assert.equal(unpacked.resources[1].name, 'Beta');
  assert.equal(unpacked.resources[1].description, 'A free tool');
  assert.equal(unpacked.resources[2].platforms.join(','), 'Linux,macOS');
});

// ------------------------ search
t('search index finds exact and prefix matches', () => {
  const { SearchIndex } = FMHYS.search;
  function mkrec(raw) { return FMHYS.schema.normalizeResource({ fmhyUrl: 'https://fmhy.net/t#x', ...raw }).value; }
  const recs = [
    mkrec({ id: '1', name: 'qBittorrent', url: 'https://qb.example/', description: 'torrent client', tags: ['torrent'], category: 'Torrenting' }),
    mkrec({ id: '2', name: 'Transmission', url: 'https://tr.example/', description: 'bittorrent app', tags: ['torrent'], category: 'Torrenting' }),
    mkrec({ id: '3', name: 'Kdenlive', url: 'https://kd.example/', description: 'video editor', tags: ['video', 'editor'], category: 'Video Tools' })
  ];
  const idx = new SearchIndex(recs);
  const hits = idx.search('qbittorrent', { limit: 5 });
  assert.ok(hits.length >= 1, 'expected at least one hit for qbittorrent');
  assert.equal(hits[0].doc.id, '1');
  const torr = idx.search('torrent', { limit: 5 });
  assert.equal(torr.length, 2);
});

// ------------------------ similarity
t('similarity ranks same-category items higher', () => {
  const { SearchIndex } = FMHYS.search;
  const { SimilarityEngine } = FMHYS.similarity;
  function mkrec(raw) { return FMHYS.schema.normalizeResource({ fmhyUrl: 'https://fmhy.net/t#x', ...raw }).value; }
  const recs = [
    mkrec({ id: 'a', name: 'qBittorrent', url: 'https://qb.example/', tags: ['torrent'], category: 'Torrenting', description: 'torrent client', platforms: ['Windows','macOS','Linux'] }),
    mkrec({ id: 'b', name: 'Transmission', url: 'https://tr.example/', tags: ['torrent'], category: 'Torrenting', description: 'bittorrent client', platforms: ['macOS','Linux'] }),
    mkrec({ id: 'c', name: 'BiglyBT', url: 'https://bb.example/', tags: ['torrent'], category: 'Torrenting', description: 'bittorrent client with swarm merging' }),
    mkrec({ id: 'd', name: 'Jellyfin', url: 'https://jf.example/', tags: ['media', 'video'], category: 'Streaming', description: 'media server', platforms: ['Linux'] })
  ];
  const idx = new SearchIndex(recs);
  const engine = new SimilarityEngine(idx);
  const top = engine.findSimilar('a', { limit: 5, minScore: 5 });
  assert.ok(top.length >= 1, 'expected at least one similar item; got 0');
  const names = top.map((r) => r.resource.id);
  // Same-category torrents must rank ahead of Jellyfin (which won't even clear
  // the minScore threshold if there are true peers in the same subcategory).
  assert.ok(names.includes('b') || names.includes('c'),
    'expected at least one torrent peer in results: ' + names.join(','));
  assert.ok(!names.includes('a'), 'must not return the seed itself');
  // Transmission/BiglyBT scores must be nonzero and well above Jellyfin.
  const scoreOf = (id) => (top.find((s) => s.resource.id === id)?.score || 0);
  assert.ok(scoreOf('b') > scoreOf('d') + 5 || scoreOf('d') === 0,
    'peers should outscore unrelated media server');
});

// ------------------------ detector (real DOM shim)
t('detector finds resource links and skips nav/footer', async () => {
  const html = `
    <html><body>
    <nav><a href="https://twitter.example/nav">Nav</a></nav>
    <main class="vp-doc">
      <h1>Video Tools</h1>
      <h2>Disc Utilities</h2>
      <ul>
        <li><a href="https://imgburn.example/">ImgBurn</a> — CD / DVD Burning</li>
        <li><a href="https://nero.example/">Nero</a></li>
        <li><a href="/video-tools#back">↪️ Video Players</a></li>
      </ul>
    </main>
    </body></html>`;
  const { FMHYS: f2, document: doc } = await loadExtension([
    'core/namespace.js',
    'core/browser.js',
    'core/text.js',
    'core/url-validator.js',
    'content/detector.js'
  ], { html, url: 'https://fmhy.net/video-tools', extra: { chrome: chromeStub() } });
  const seen = new WeakSet();
  const found = f2.detector.scan(doc.documentElement, seen);
  const names = found.map((e) => e.name);
  assert.ok(names.includes('ImgBurn'), 'expected ImgBurn; got ' + names.join(','));
  assert.ok(names.includes('Nero'), 'expected Nero');
  assert.ok(!names.includes('Nav'), 'nav link must be rejected');
  const imgburn = found.find((e) => e.name === 'ImgBurn');
  assert.ok(imgburn.description && /CD.*DVD/i.test(imgburn.description), 'description parsed: ' + imgburn.description);
});

// ------------------------ content script boot order + selector hygiene
t('no content script or UI file touches chrome.* directly', () => {
  const ban = /(^|[^A-Za-z0-9_"'.])chrome\.[A-Za-z]/;
  for (const file of ['content/detector.js','content/indicators.js','content/similar-popup.js','content/content.js',
                      'popup/popup.js','options/options.js','core/favorites.js','core/search.js','core/similarity.js',
                      'core/text.js','core/storage.js','core/url-validator.js']) {
    const src = readFileSync(path.join(SRC, file), 'utf8');
    assert.ok(!ban.test(src), `${file} references chrome.* directly`);
  }
});
t('content styles are fully namespaced under .fmhys-', () => {
  const src = readFileSync(path.join(SRC, 'content/styles.css'), 'utf8');
  // strip comments and @-rules to find every bare selector
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleRe = /([^{}@]+)\{[^{}]*\}/g;
  let m;
  while ((m = ruleRe.exec(stripped))) {
    const selector = m[1].trim();
    if (!selector) continue;
    // split on commas, skip keyframe percentages and @keyframes
    for (const sel of selector.split(',')) {
      const s = sel.trim();
      if (!s || /^\s*(from|to|[\d.]+%)/.test(s)) continue;
      // Each *compound* selector in the chain must reference either a
      // .fmhys-* element (our UI) or a browser/host primitive that the spec
      // guarantees to contain our injected nodes (`li` is where FMHY places
      // resources, so `li:hover > .fmhys-cluster > .fmhys-similar--quiet` is
      // valid: the only elements we style under li are our own .fmhys-* ones).
      const compounds = s.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
      let touchedFmhys = false;
      for (const part of compounds) {
        const head = part.replace(/:+(?:hover|focus-within|focus-visible|focus|active|first-child|last-child|not\([^)]*\))/g, '');
        const tag = head.match(/^[a-zA-Z][\w-]*/)?.[0];
        const cls = head.match(/\.[\w-]+/g) || [];
        const id = head.match(/#[\w-]+/);
        const isHost = tag === 'li' && cls.length === 0 && !id;
        const isPage = /^(html|body)$/.test(tag);
        const isOurs = cls.some((c) => c.startsWith('.fmhys'));
        if (isOurs) { touchedFmhys = true; continue; }
        if (isHost || isPage || /^:root$/.test(head) || head === '*') continue;
        // Reject anything that would restyle arbitrary FMHY markup.
        if (tag && !isHost && !isPage) {
          // Tag selectors are only allowed as descendants of a .fmhys-* root.
          if (!touchedFmhys && !isHost) {
            throw new Error(`styles.css selector not namespaced: "${s}" (at "${part}")`);
          }
        } else if (cls.length || id) {
          throw new Error(`styles.css selector not namespaced: "${s}" (at "${part}")`);
        }
      }
      if (!touchedFmhys) {
        throw new Error(`styles.css selector never references .fmhys-*: "${s}"`);
      }
    }
  }
});
t('no inline event handlers in HTML', () => {
  for (const f of ['popup/popup.html','options/options.html']) {
    const src = readFileSync(path.join(SRC, f), 'utf8');
    const re = /\b(?:onclick|onchange|oninput|onkeydown|onkeyup|onkeypress|onsubmit|onload|onerror|onmouseover)\s*=/i;
    assert.ok(!re.test(src), `${f} contains inline event handlers`);
  }
});

// Load merged manifests once (synchronous merge of JSON on disk).
function loadManifestSync() {
  function merge(base, overlay) {
    const out = JSON.parse(JSON.stringify(base));
    for (const [k, v] of Object.entries(overlay)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = merge(out[k], v);
      } else {
        out[k] = JSON.parse(JSON.stringify(v));
      }
    }
    return out;
  }
  const base = JSON.parse(readFileSync(path.join(SRC, 'manifest.base.json'), 'utf8'));
  const cr = JSON.parse(readFileSync(path.join(SRC, 'manifest.chromium.json'), 'utf8'));
  const ff = JSON.parse(readFileSync(path.join(SRC, 'manifest.firefox.json'), 'utf8'));
  return { chromium: merge(base, cr), firefox: merge(base, ff) };
}
const MANIFESTS = loadManifestSync();

t('CSP is strict (no unsafe-inline/unsafe-eval, no remote scripts)', () => {
  const csp = MANIFESTS.chromium.content_security_policy.extension_pages;
  assert.ok(!csp.includes('unsafe-inline'), 'CSP must not include unsafe-inline');
  assert.ok(!csp.includes('unsafe-eval'), 'CSP must not include unsafe-eval');
  assert.ok(csp.includes("object-src 'none'"), 'CSP must block plugins');
});

// ------------------------ manifest integrity for both platforms
t('every manifest-referenced asset exists for both platforms', () => {
  for (const [platform, mf] of Object.entries(MANIFESTS)) {
    for (const ref of manifestAssetPaths(mf)) {
      assert.ok(existsSync(path.join(SRC, ref)), `${platform}: missing src/${ref}`);
    }
  }
});
t('chromium manifest uses service_worker, firefox uses background.scripts', () => {
  const m = MANIFESTS;
  assert.ok(m.chromium.background.service_worker, 'chromium must use service_worker');
  assert.ok(!m.chromium.background.scripts, 'chromium should not use background.scripts');
  assert.ok(Array.isArray(m.firefox.background.scripts), 'firefox must use background.scripts');
  assert.ok(!m.firefox.background.service_worker, 'firefox should not use service_worker');
});

// ------------------------ icons
t('icons render cleanly from assets/logo.svg (header check)', () => {
  // PNG signature + IHDR width/height sanity. Real pixel-vs-master check is
  // `node tools/make-icons.mjs --check`, which we run in CI.
  const { readFileSync } = require('node:fs');
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const size of [16, 32, 48, 128]) {
    const buf = readFileSync(path.join(SRC, 'icons', `icon-${size}.png`));
    assert.ok(buf.slice(0, 8).equals(PNG_SIG), `icon-${size}.png not a valid PNG`);
    assert.gt(buf.length, 100, `icon-${size}.png is suspiciously small`);
    assert.equal(buf.readUInt32BE(16), size, `icon-${size}.png IHDR width mismatch`);
    assert.equal(buf.readUInt32BE(20), size, `icon-${size}.png IHDR height mismatch`);
  }
});

// ------------------------ summary
await runTests();
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.error && f.error.message}`);
  process.exit(1);
}
console.log('\x1b[32mAll tests passed.\x1b[0m');
