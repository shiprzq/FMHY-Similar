/**
 * Shared helpers for the repo's build/test tooling.
 *
 * The extension ships plain script files that attach to a global `FMHYS`
 * namespace, so the fastest faithful way to exercise them in Node is to run
 * the real files inside a `vm` context with a small DOM around them. No
 * transpiling, no module rewriting — the bytes that ship are the bytes tested.
 */

import { readFile, writeFile, mkdir, rm, stat, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Document, FakeEvent } from './dom.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, 'src');
export const PLATFORM = path.join(ROOT, 'platform');

export const readJSON = async (p) => JSON.parse(await readFile(p, 'utf8'));
export const writeJSON = async (p, value) => {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
export const readText = (p) => readFile(p, 'utf8');
export const exists = (p) => existsSync(p);
export const isFile = async (p) => !!(await stat(p).then((s) => s.isFile()).catch(() => false));

/** Files copied verbatim from src/ into every platform build. */
export const SHARED_DIRS = ['core', 'content', 'database', 'background', 'popup', 'options', 'icons'];

/** Files excluded from a given platform build, keyed by platform id. */
export const PLATFORM_EXCLUDES = {
  // Firefox MV3 does not support service_worker; background.scripts loads everything.
  firefox: new Set(['background/service-worker.js']),
  chromium: new Set()
};

/** Deep merge; object values merge key-by-key, arrays and scalars replace. */
export function merge(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return clone(overlay);
  const out = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : clone(value);
  }
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (isPlainObject(v) ? JSON.parse(JSON.stringify(v)) : v);

/** Every script/style/resource path a manifest references, plus the ones the HTML pages load. */
export function manifestAssetPaths(manifest) {
  const paths = new Set();
  for (const size of Object.keys(manifest.icons || {})) paths.add(manifest.icons[size]);
  for (const size of Object.keys(manifest.action?.default_icon || {})) paths.add(manifest.action.default_icon[size]);
  if (manifest.action?.default_popup) paths.add(manifest.action.default_popup);
  if (manifest.options_ui?.page) paths.add(manifest.options_ui.page);
  for (const key of ['service_worker']) if (manifest.background?.[key]) paths.add(manifest.background[key]);
  for (const file of manifest.background?.scripts || []) paths.add(file);
  for (const cs of manifest.content_scripts || []) {
    for (const js of cs.js || []) paths.add(js);
    for (const css of cs.css || []) paths.add(css);
  }
  for (const war of manifest.web_accessible_resources || []) for (const r of war.resources || []) paths.add(r);
  return [...paths];
}

/** <script src> / <link href> in an extension page, resolved relative to that page. */
export function htmlAssetPaths(html, htmlDir) {
  const out = [];
  const re = /<(?:script|link)\s+[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
    out.push(path.posix.normalize(path.posix.join(htmlDir, ref)));
  }
  return out;
}

/* ------------------------------------------------------------------ builds */

export async function assemblePlatform(platform, manifest, { clean = true } = {}) {
  const dest = path.join(PLATFORM, platform);
  const excludes = PLATFORM_EXCLUDES[platform] || new Set();
  if (clean) await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const { cp: cpAsync } = await import('node:fs/promises');
  for (const dir of SHARED_DIRS) {
    const from = path.join(SRC, dir);
    if (!existsSync(from)) continue;
    const to = path.join(dest, dir);
    await mkdir(to, { recursive: true });
    // Copy files individually, filtering excludes. Good enough for ~30 files
    // and keeps the process portable without a cp(1) dependency.
    for await (const entry of walk(from)) {
      const repoRel = dir + '/' + entry.rel; // path relative to src/
      if (excludes.has(repoRel)) continue;
      const toFile = path.join(to, entry.rel);
      await mkdir(path.dirname(toFile), { recursive: true });
      await cpAsync(entry.full, toFile);
    }
  }
  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return dest;
}

/**
 * Walk `dir` and yield file entries. `rel` is relative to `dir` (using POSIX
 * separators, which is what the excludes table stores).
 */
async function* walk(dir, prefix = '') {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walk(path.join(dir, entry.name), rel);
    } else if (entry.isFile()) {
      yield { rel, full: path.join(dir, rel) };
    }
  }
}

export async function buildManifests() {
  const base = await readJSON(path.join(SRC, 'manifest.base.json'));
  const out = {};
  for (const platform of ['chromium', 'firefox']) {
    const overlay = await readJSON(path.join(SRC, `manifest.${platform}.json`));
    out[platform] = merge(base, overlay);
  }
  return out;
}

/* ----------------------------------------------------------- module loader */

/**
 * Run the extension's real files in a sandbox and hand back `FMHYS`.
 *
 * @param {string[]} files  paths relative to src/
 * @param {object}   opts   { html, url, extra }
 */
export async function loadExtension(files, opts = {}) {
  const document = new Document();
  if (opts.html) { document.HTML = opts.html; document.title = opts.title ?? 'Video Tools'; }

  const listeners = new Map();
  const location = new URL(opts.url || 'https://fmhy.net/video-tools');
  const sandbox = {
    console,
    JSON, Math, Date, Intl, URL, URLSearchParams, TextEncoder, TextDecoder,
    Set, Map, WeakMap, WeakSet, Promise, Object, Array, String, Number, Boolean, Error, TypeError, RangeError, RegExp, Function, Symbol,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, structuredClone,
    setTimeout: (fn, ms, ...a) => setTimeout(fn, Math.min(ms || 0, 50), ...a),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    performance: { now: () => Date.now() },
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) },
    AbortController,
    AbortSignal,
    fetch: opts.fetch || (async () => { throw new Error('network-disabled-in-tests'); }),
    document,
    location,
    matchMedia: (query) => ({
      media: query,
      matches: /pointer:\s*coarse/.test(query) ? false : /dark/.test(query) ? (opts.dark ?? false) : false,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
    }),
    getSelection: () => ({ removeAllRanges() {}, toString: () => '' }),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    addEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) || []).concat(fn)); },
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) || []) fn.call(sandbox, event);
      return true;
    },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    ...(opts.extra || {})
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const file of files) {
    const src = await readFile(path.join(SRC, file), 'utf8');
    new vm.Script(src, { filename: `src/${file}` }).runInContext(context);
  }
  return { FMHYS: sandbox.FMHYS, sandbox, document, location, FakeEvent };
}

export const walkFiles = async (dir, prefix = '') => {
  const out = [];
  const entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walkFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
};
