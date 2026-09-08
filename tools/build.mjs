#!/usr/bin/env node
/**
 * Assemble the per-browser extension builds.
 *
 *   src/manifest.base.json + src/manifest.<platform>.json  ->  platform/<platform>/manifest.json
 *   src/{core,content,database,background,popup,options,icons}  ->  platform/<platform>/…
 *
 * The shared code is byte-identical across platforms by construction: the only
 * difference between a Chromium and a Firefox build is the manifest, which is
 * exactly the design intent of the extension.
 *
 * Usage: node tools/build.mjs [--platform chromium|firefox] [--dry-run]
 */

import path from 'node:path';
import { assemblePlatform, buildManifests, exists, manifestAssetPaths, PLATFORM, readJSON, SRC } from './lib.mjs';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const only = flagValue('platform');
const dryRun = argv.includes('--dry-run');

const PLATFORMS = only ? [only] : ['chromium', 'firefox'];

function fail(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exitCode = 1;
}

const manifests = await buildManifests();

for (const platform of PLATFORMS) {
  const manifest = manifests[platform];
  if (!manifest) { fail(`unknown platform: ${platform}`); continue; }

  // Fail fast: every path the manifest references must exist under src/.
  for (const ref of manifestAssetPaths(manifest)) {
    if (!exists(path.join(SRC, ref))) fail(`${platform}: manifest references missing file src/${ref}`);
  }
  if (process.exitCode) continue;

  if (dryRun) {
    console.log(`\x1b[33m–\x1b[0m ${platform}: would write platform/${platform}/manifest.json`);
    continue;
  }

  const dest = await assemblePlatform(platform, manifest);
  const files = manifestAssetPaths(manifest).length;
  console.log(
    `\x1b[32m✓\x1b[0m ${path.relative(process.cwd(), dest)}  ` +
    `(${manifest.name} v${manifest.version}, ${files} manifest-referenced files)`
  );
}

// Keep the two release manifests honest about the version they carry.
const pkg = await readJSON(path.join(path.resolve('.'), 'package.json'));
for (const platform of PLATFORMS) {
  if (manifests[platform].version !== pkg.version) {
    fail(`version drift: src/manifest.base.json is ${manifests[platform].version}, package.json is ${pkg.version}`);
  }
}

if (!dryRun && PLATFORMS.length === 2) {
  console.log(`\nLoad unpacked → ${path.join(PLATFORM, 'chromium')}`);
  console.log(`about:debugging → ${path.join(PLATFORM, 'firefox')}`);
}
