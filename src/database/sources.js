/**
 * Where the resource dataset comes from.
 *
 * FMHY publishes its wiki as markdown. We consume those published documents
 * directly — one request per wiki page, only when the user presses
 * "Update database". There is no continuous crawling and no per-interaction
 * network access. robots.txt on fmhy.net allows `/` (it only disallows
 * /assets/ and image files), and the GitHub raw mirror is the project's own
 * distribution channel.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;

  /** Wiki pages, in sidebar order. `category` hints are used for page mapping. */
  const PAGES = [
    { slug: 'adblockvpnguide', file: 'privacy', title: 'Adblocking / Privacy' },
    { slug: 'ai', file: 'ai', title: 'Artificial Intelligence' },
    { slug: 'video', file: 'video', title: 'Movies / TV / Anime' },
    { slug: 'audio', file: 'audio', title: 'Music / Podcasts / Radio' },
    { slug: 'gaming', file: 'gaming', title: 'Gaming / Emulation' },
    { slug: 'reading', file: 'reading', title: 'Books / Comics / Manga' },
    { slug: 'downloading', file: 'downloading', title: 'Downloading' },
    { slug: 'torrenting', file: 'torrenting', title: 'Torrenting' },
    { slug: 'educational', file: 'educational', title: 'Educational' },
    { slug: 'mobile', file: 'mobile', title: 'Android / iOS' },
    { slug: 'linux-macos', file: 'linux-macos', title: 'Linux / macOS' },
    { slug: 'non-english', file: 'non-english', title: 'Non-English' },
    { slug: 'misc', file: 'misc', title: 'Miscellaneous' },
    { slug: 'system-tools', file: 'system-tools', title: 'System Tools' },
    { slug: 'file-tools', file: 'file-tools', title: 'File Tools' },
    { slug: 'internet-tools', file: 'internet-tools', title: 'Internet Tools' },
    { slug: 'social-media-tools', file: 'social-media-tools', title: 'Social Media Tools' },
    { slug: 'text-tools', file: 'text-tools', title: 'Text Tools' },
    { slug: 'gaming-tools', file: 'gaming-tools', title: 'Gaming Tools' },
    { slug: 'image-tools', file: 'image-tools', title: 'Image Tools' },
    { slug: 'video-tools', file: 'video-tools', title: 'Video Tools' },
    { slug: 'developer-tools', file: 'developer-tools', title: 'Developer Tools' },
    { slug: 'storage', file: 'storage', title: 'Storage' },
    { slug: 'beginners-guide', file: 'beginners-guide', title: "Beginner's Guide" }
  ];

  /**
   * The canonical page slug on fmhy.net differs from the repo filename for one
   * page (privacy.md is served at /adblockvpnguide -> /privacy). We resolve via
   * the table above and fall back to the file name.
   */
  const REPO_RAW = 'https://raw.githubusercontent.com/fmhy/edit/main/docs/';
  const SITE = 'https://fmhy.net/';

  /** Primary: the project's own git mirror (stable, cacheable, CORS-friendly). */
  function repoUrl(page) { return REPO_RAW + page.file + '.md'; }

  /** Fallback: the whole wiki as one markdown document. */
  const SINGLE_PAGE = SITE + 'single-page.md';

  /** Update endpoints in preference order. */
  const REMOTES = [
    { id: 'repo', label: 'FMHY git mirror (per page)', kind: 'pages' },
    { id: 'single', label: 'fmhy.net/single-page.md', kind: 'single', url: SINGLE_PAGE }
  ];

  FMHYS.sources = { PAGES, REPO_RAW, SITE, SINGLE_PAGE, REMOTES, repoUrl };
})(typeof globalThis !== 'undefined' ? globalThis : self);
