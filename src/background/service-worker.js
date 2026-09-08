/**
 * Chromium MV3 entry point.
 *
 * Loads the shared core modules into the service-worker global scope, then the
 * common background logic. Firefox uses manifest `background.scripts` instead
 * (see background/background.js) because it has no importScripts() in MV3.
 */
'use strict';

importScripts(
  '../core/namespace.js',
  '../core/browser.js',
  '../core/text.js',
  '../core/url-validator.js',
  '../database/schema.js',
  '../database/codec.js',
  '../core/storage.js',
  '../core/favorites.js',
  '../core/search.js',
  '../core/similarity.js',
  '../database/sources.js',
  '../database/fmhy-parser.js',
  '../database/database.js',
  'background.js'
);
