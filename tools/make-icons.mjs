#!/usr/bin/env node
/**
 * Render the extension icons from the vector master, dependency-free.
 *
 *   assets/logo.svg          the single source of truth (edit this)
 *   src/icons/icon-*.png     rendered here; `npm run build` ships them
 *
 * Rather than shelling out to ImageMagick (whose SVG support depends on which
 * delegate happens to be installed) this reads the `<rect>` / `<linearGradient>`
 * elements of the master and rasterises them with a signed-distance
 * supersampling loop. Output is byte-identical on any machine and any CI, and
 * 16 px stays crisp because coverage is computed at 4x4 per pixel.
 *
 * Usage:
 *   node tools/make-icons.mjs                    # write src/icons/*
 *   node tools/make-icons.mjs --sizes 16,48      # subset
 *   node tools/make-icons.mjs --check            # CI drift check, no writes
 */

import zlib from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const argv = process.argv.slice(2);
const flagAfter = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const sizes = flagAfter('sizes', '16,32,48,128').split(',').map(Number).filter(Number.isFinite);
const checkOnly = argv.includes('--check');
const MASTER = path.join(ROOT, 'assets', 'logo.svg');
/** Features thinner than this (in px) are nudged up so they never vanish. */
const MIN_FEATURE = 1.6;

/* --------------------------------------------------------- svg master */

async function loadMaster() {
  const svg = await readFile(MASTER, 'utf8');
  const vb = (/viewBox="([^"]+)"/.exec(svg)?.[1] || '0 0 128 128').split(/\s+/).map(Number);
  const gradients = new Map();
  for (const m of svg.matchAll(/<linearGradient\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/linearGradient>/g)) {
    const attrs = m[0].slice(0, m[0].indexOf('>') + 1);
    const read = (name, def) => {
      const v = new RegExp(`\\b${name}="([^"]+)"`).exec(attrs);
      return v ? Number(v[1]) : def;
    };
    const stops = [...m[2].matchAll(/<stop\b[^>]*>/g)].map((s) => ({
      offset: Number(/offset="([^"]+)"/.exec(s[0])?.[1] ?? 0),
      color: /stop-color="([^"]+)"/.exec(s[0])?.[1] || '#000'
    }));
    gradients.set(m[1], { x1: read('x1', 0), y1: read('y1', 0), x2: read('x2', 0), y2: read('y2', 1), stops });
  }

  const layerRe = /<rect\b[^>]*\/?>/g;
  const layers = [];
  for (const m of svg.matchAll(layerRe)) {
    const tag = m[0];
    const attr = (name) => {
      const v = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
      return v ? v[1] : null;
    };
    if (attr('fill') === 'none' || attr('display') === 'none') continue;
    const box = {
      x: Number(attr('x') || 0), y: Number(attr('y') || 0),
      w: Number(attr('width') || 0), h: Number(attr('height') || 0)
    };
    const paint = attr('fill') || '#000';
    layers.push({
      ...box,
      r: Number(attr('rx') || 0),
      stroke: attr('stroke'),
      strokeW: Number(attr('stroke-width') || 0),
      gradient: /^url\(#(.+)\)$/.exec(paint)?.[1] || null,
      solid: paint.startsWith('#') ? paint : null
    });
  }
  if (!layers.length) throw new Error('assets/logo.svg: no <rect> layers found');
  return { size: vb[2], gradients, layers };
}

/* ------------------------------------------------------------- geometry */

const parseHex = (hex) => {
  const v = String(hex).replace('#', '');
  const s = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const lerp = (a, b, t) => a + (b - a) * t;

function sampleGradient(gradient, u, v) {
  // objectBoundingBox: t is the projection on the (x1,y1)->(x2,y2) axis.
  const gx = gradient.x2 - gradient.x1, gy = gradient.y2 - gradient.y1;
  const len2 = gx * gx + gy * gy || 1;
  const t = Math.min(1, Math.max(0, ((u - gradient.x1) * gx + (v - gradient.y1) * gy) / len2));
  const stops = gradient.stops;
  if (!stops.length) return [0, 0, 0];
  let i = 0;
  while (i < stops.length - 1 && t > stops[i + 1].offset) i++;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const span = (b.offset - a.offset) || 1;
  const f = Math.min(1, Math.max(0, (t - a.offset) / span));
  const ca = parseHex(a.color), cb = parseHex(b.color);
  return [lerp(ca[0], cb[0], f), lerp(ca[1], cb[1], f), lerp(ca[2], cb[2], f)];
}

/** Signed distance to a rounded rect (negative inside). */
function sd(px, py, s) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  const hx = Math.max(0, s.w / 2 - s.r), hy = Math.max(0, s.h / 2 - s.r);
  const dx = Math.abs(px - cx) - hx, dy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - s.r;
}

function colorAt(layer, u, v, gradients) {
  if (layer.gradient && gradients.has(layer.gradient)) return sampleGradient(gradients.get(layer.gradient), u, v);
  return parseHex(layer.solid || '#000');
}

function render(size, master) {
  const scale = size / master.size;
  const layers = master.layers.map((l) => {
    const w = Math.max(l.w * scale, Math.min(MIN_FEATURE, l.w * scale * 1.35));
    const h = Math.max(l.h * scale, Math.min(MIN_FEATURE, l.h * scale * 1.35));
    // keep the shape centred on its own box when it grows
    const cx = (l.x + l.w / 2) * scale, cy = (l.y + l.h / 2) * scale;
    return {
      x: cx - w / 2, y: cy - h / 2, w, h,
      r: Math.min(l.r * scale, w / 2, h / 2),
      stroke: l.stroke, strokeW: l.strokeW * scale,
      gradient: l.gradient, solid: l.solid
    };
  });

  const SS = 4;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS;
          const py_ = y + (sy + 0.5) / SS;
          let hit = null;
          // SVG paints in document order, so walk backwards: topmost wins.
          for (let li = layers.length - 1; li >= 0; li--) {
            const layer = layers[li];
            const d = sd(px_, py_, layer);
            if (d > 0.5) continue;
            const u = (px_ - layer.x) / layer.w;
            const v = (py_ - layer.y) / layer.h;
            let col = colorAt(layer, u, v, master.gradients);
            if (layer.stroke && layer.stroke.startsWith('#') && d > -layer.strokeW) {
              col = parseHex(layer.stroke);
            }
            hit = col;
            break; // first hit walking up the stack = topmost painted layer
          }
          if (!hit) continue;
          r += hit[0]; g += hit[1]; b += hit[2]; cov++;
        }
      }
      const i = (y * size + x) * 4;
      const alpha = cov / (SS * SS);
      if (alpha > 0) {
        px[i] = Math.round(r / cov);
        px[i + 1] = Math.round(g / cov);
        px[i + 2] = Math.round(b / cov);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/* ------------------------------------------------------------ png output */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------- main */

const master = await loadMaster();
const outDir = path.join(ROOT, 'src', 'icons');
await mkdir(outDir, { recursive: true });

let drift = false;
for (const size of sizes.sort((a, b) => a - b)) {
  const png = encodePNG(size, render(size, master));
  const file = path.join(outDir, `icon-${size}.png`);
  const before = await readFile(file).catch(() => null);
  const same = !!before && before.equals(png);
  if (checkOnly) {
    console.log(`${same ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} icon-${size}.png ${same ? 'matches assets/logo.svg' : 'is stale — run: npm run icons'}`);
    if (!same) drift = true;
    continue;
  }
  await writeFile(file, png);
  console.log(`\x1b[32m✓\x1b[0m src/icons/icon-${String(size).padEnd(3)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

if (checkOnly && drift) process.exit(1);
if (!checkOnly) console.log('\nIcons are generated from assets/logo.svg — never edit src/icons/*.png by hand.');
