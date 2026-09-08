/**
 * FMHY Similar — shared namespace bootstrap.
 *
 * Every core module attaches itself to `globalThis.FMHYS` so that the exact
 * same source files can be consumed by:
 *   - the MV3 service worker (via importScripts)
 *   - content scripts (via manifest `js` array, ordered)
 *   - popup / options pages (via <script src>)
 *   - Node build tooling (via tools/node-shim.mjs)
 *
 * No bundler, no framework, no eval.
 */
(function (root) {
  'use strict';
  root.FMHYS = root.FMHYS || {};
  root.FMHYS.VERSION = '1.0.0';
  /** Schema version of the resource database format. */
  root.FMHYS.SCHEMA_VERSION = 1;
})(typeof globalThis !== 'undefined' ? globalThis : self);
