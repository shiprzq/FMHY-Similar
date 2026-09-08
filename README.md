<p align="center">
  <img alt="FMHY Similar" src="assets/logo.svg" width="96" height="96">
</p>

<h1 align="center">FMHY Similar</h1>

<p align="center">
  A Manifest&nbsp;V3 browser extension that makes the <a href="https://fmhy.net">FMHY</a> wiki
  instantly navigable: subtle red indicators mark every resource, a ★ saves favorites, and
  double-clicking any entry surfaces up to five ranked alternatives — all from a
  <strong>fully local</strong> database, with zero network traffic while you browse.
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="#usage">Usage</a> ·
  <a href="#whats-inside">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-red" alt="MIT license">
  <img src="https://img.shields.io/badge/Chrome-✓-brightgreen" alt="Chrome">
  <img src="https://img.shields.io/badge/Firefox-✓-brightgreen" alt="Firefox">
  <img src="https://img.shields.io/badge/resources-20,601-4d7bfa" alt="20,601 resources bundled">
  <img src="https://img.shields.io/badge/network-zero-orange" alt="Zero network requests">
</p>

> ⚠️ **Unofficial community project.** FMHY Similar is not affiliated with, endorsed by, or
> sponsored by the FMHY wiki or its maintainers.

---

## What it does

| Feature | Behaviour |
|---|---|
| **Resource detection** | Finds genuine resource links in the article body and reads their name, URL, category, section, description and tags. Navigation, headers, footers, TOC, callouts and `↪️` cross-references are ignored. |
| **Red indicator** | A thin red bar beside every detected resource — CSS-only, keyboard-focusable, ARIA-labelled, zero layout shift. |
| **Favorite button** | A subtle ☆ that becomes a ★. Persisted in extension storage across browser restarts. No account. |
| **Find Similar** | Double-click a resource (or its indicator) to open a card with up to **5** ranked alternatives. Never opens a new tab. |
| **Similarity engine** | Weighted scoring over category, tags, keywords, description, features and platform, normalised 0–100. IDF-weighted cosine so distinctive terms count most. |
| **Local search** | Exact, prefix and fuzzy matching across names, tags, categories and descriptions. |
| **Dashboard** | Favorites, recently viewed, and quick search from the toolbar icon. Press `/` to focus search. |
| **Settings** | General / Appearance / Database / Privacy, including a safe database updater with snapshot+rollback. |

**20,601 real resources** ship bundled, parsed from FMHY's own published wiki markdown.

---

## Install

FMHY Similar is a browser extension for **Google Chrome** (and Chromium derivatives: Edge, Brave, Opera, Vivaldi, Arc) and **Mozilla Firefox**.

### <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome.svg" width="16" height="16" alt=""> Chrome / Chromium / Edge / Brave

1. Clone or download this repository.
   ```bash
   git clone https://github.com/shiprzq/FMHY-Similar.git
   cd FMHY-Similar
   npm run prepare-dev    # generates icons and the platform/ folders (optional if you already have platform/chromium)
   ```
2. Open your browser and navigate to [`chrome://extensions`](chrome://extensions).
3. Enable **Developer mode** — the toggle is in the top-right corner.
4. Click the **Load unpacked** button.
5. Select the **`platform/chromium/`** directory inside your cloned project (or the unpacked folder you downloaded).
6. Visit any page on [fmhy.net](https://fmhy.net) — for example [fmhy.net/video-tools](https://fmhy.net/video-tools). You should see a thin red line and a ☆ beside each resource. Double-click one.

> If you downloaded the repository as a ZIP instead of cloning it, be sure to unzip it first and select the `platform/chromium/` **subfolder**, not the whole archive.

> The same instructions apply to Edge (`edge://extensions`), Brave (`brave://extensions`), Opera (`opera://extensions`), Vivaldi (`vivaldi://extensions`) and other Chromium-based browsers.

### <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/firefox/firefox.svg" width="16" height="16" alt=""> Firefox

Firefox is fully supported — the source is cross-browser and the Firefox build uses the same code as Chrome with just a manifest swap for MV3 event pages.

The signed extension link is **coming soon** — AMO review is in progress. Until then you can load the unsigned build temporarily for testing:

```bash
npm run prepare-dev
```

1. Open [`about:debugging#/runtime/this-firefox`](about:debugging#/runtime/this-firefox).
2. Click **Load Temporary Add-on…**.
3. Select `platform/firefox/manifest.json` from your cloned project.

Temporary add-ons are reset when Firefox restarts — the signed add-on will install normally once published. Watch this space, or star the repo to get notified.

### Userscript (optional)

A self-contained userscript (Greasemonkey / Violentmonkey / Tampermonkey) is provided in [`userscript/fmhy-similar.user.js`](userscript/fmhy-similar.user.js) for quick experiments without installing an extension. It does not include the dashboard popup or background database updater.

---

## Usage

| Action | How |
|---|---|
| Find similar | Double-click the resource or its red indicator, or click the **Similar** pill |
| Find similar (keyboard) | Focus the red line with `Tab`, then press `Enter` or `Space` |
| Navigate the card | `↑` / `↓` between alternatives; `Tab` cycles through all controls |
| Close the card | Press `Esc`, or click anywhere outside |
| Favorite | Click the ☆ beside a resource, or inside the card |
| Dashboard | Click the toolbar icon (press `/` to focus search) |
| Settings | Toolbar icon → gear icon |

On touch devices and narrow screens the **Similar** pill is always visible and the card docks as a bottom sheet, so nothing depends on hover or double-click alone.

---

## Project layout

```
FMHY-Similar/
├── src/                           Source of truth (edit here)
│   ├── manifest.base.json         Shared manifest (MV3, permissions, CSP)
│   ├── manifest.chromium.json     Chromium-only overlay (service_worker)
│   ├── manifest.firefox.json      Firefox-only overlay (background.scripts, gecko id)
│   ├── background/                Event handlers: DB + index + message router
│   ├── content/                   Injected page UI (detector, indicators, popup, styles)
│   ├── core/                      Namespace, browser shim, storage, text, search, similarity
│   ├── database/                  Schema, codec, parser, updater, bundled resources.json
│   ├── popup/                     Dashboard (html/js/css)
│   ├── options/                   Settings page (html/js/css)
│   └── icons/                     Rendered icons (generated from assets/logo.svg)
├── assets/                        Design master (logo.svg — the only icon you ever edit)
├── platform/                      Build output, what you actually load in your browser
│   ├── chromium/                  Produced by `npm run build:chromium`
│   └── firefox/                   Produced by `npm run build:firefox`
├── tools/                         Build, test and icon scripts (no npm dependencies)
├── userscript/                    Standalone userscript build
├── dist/                          Packaged archives (npm run package)
├── LICENSE                        MIT
└── package.json
```

Every module attaches to a shared `FMHYS` namespace, so the **same source files** run in the service worker (via `importScripts`), the content script (manifest `js` array), extension pages (`<script src>`) and Node (build/test) — no bundler, no duplicated logic, no framework.

---

## How it works

### Resource dataset

FMHY publishes its wiki as markdown — this extension consumes those published documents directly:

- `https://raw.githubusercontent.com/fmhy/edit/main/docs/<page>.md` — the project's own git mirror, one document per wiki page (default source)
- `https://fmhy.net/single-page.md` — the entire wiki in one document (fallback)

This is **not scraping**. The files are listed on FMHY's own [Backups page](https://fmhy.net/other/backups). The extension:

- Reads only already-published markdown, never rendered pages.
- Makes network requests **only** when you press *Update database* (or, if you opt in, at most **once every 24 hours**).
- Spaces per-page requests **250 ms** apart.
- Makes **zero** network requests during normal browsing or while you use Find Similar.

`fmhy.net/robots.txt` allows `/` (disallowing only `/assets/` and image files).

### Similarity engine

```
similarityScore = categoryMatch      · 0.25
                + tagSimilarity      · 0.25
                + keywordSimilarity  · 0.20
                + descriptionSim     · 0.15
                + featureSimilarity  · 0.10
                + platformMatch      · 0.05
```

- Each component is `0..1`; the result is normalised to **0–100**.
- Keyword and description similarity use **IDF-weighted cosine**, so distinctive words ("torrent", "transcoding") count far more than common ones.
- Matching resource type gives a ×1.06 confirmation; an FMHY ⭐ gives ×1.05.
- Resources on the **same registrable domain** are penalised ×0.25 — they're usually the same product, not an alternative.
- Candidates come from index postings (same subcategory → shared distinctive terms → same category), so a lookup costs **O(candidates)**, never O(20,601).
- Results are deduplicated by **id, name and domain**, capped at **5**, and anything below the minimum score (default 28) is **omitted rather than padded**. The current resource is never returned.

Real output from the bundled database:

```
qBittorrent → qBittorrent Enhanced (93), Transmission (80), BiglyBT (74), Distribyted (72), PikaTorrent (72)
Kdenlive    → Pitivi (76), Flowblade (74), davincibox (70), AV Linux (61), mpv (58)
Jellyfin    → Kodi (58), Awesome Jellyfin (58), Plex (53), Plezy (51)
```

### Performance

| Metric | Measured |
|---|---|
| Bundled dataset | 20,601 resources, 3.3 MB packed (9.5 MB raw — **65 % smaller**, lossless dictionary encoding) |
| Packaged extension | ~950 KB zipped |
| Index build | ~600 ms, once per service-worker lifetime |
| Search query | **~1 ms** |
| Find Similar (cold) | ~11 ms |
| Find Similar (cached) | <0.05 ms |
| Network per interaction | **zero** |

How that's achieved:

- The DOM is scanned **once**; a `WeakSet` guarantees every anchor is examined exactly once.
- A single batched message resolves every link on the page.
- The `MutationObserver` is scoped to the article body, ignores our own nodes, and is debounced at 220 ms.
- The index and engine live in the **service worker** — built once per session, shared by every tab.
- Similarity results are LRU-cached (300 entries); IDF values and description term sets are memoised.
- No polling, no background timers other than the opt-in daily update alarm.

### Database safety guarantees

- The previous database is snapshotted as a backup **before** anything is written.
- A dataset where **<50 %** of entries are valid is **rejected outright**.
- A dataset **>50 % smaller** than the installed one is rejected as likely truncated.
- A failed write **restores the backup**.
- A torn/partial read is detected (row count vs meta) and treated as "unavailable" rather than served as corrupt data.

---

## Security & privacy

**Permissions requested:** `storage`, `alarms`. That's it.
**Host permissions:** `https://fmhy.net/*` and `https://raw.githubusercontent.com/fmhy/*`.
No `tabs`, no `history`, no `<all_urls>`.

- All database content is treated as **untrusted input**. There is **no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or `new Function`** anywhere in the source — every string reaches the DOM via `textContent`. This is enforced by tests.
- Every URL passes `url-validator.js` before it becomes an `href` or a navigation: `http(s)` only, no credentials in URLs, length-bounded, parse-checked.
- Strict CSP: `script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- The content script runs **only on `fmhy.net`** — never on third-party resource websites.
- **No browsing history is collected.** The extension cannot read it.
- **No FMHY URLs are sent anywhere.** Matching is entirely local.
- No telemetry, analytics, identifiers or fingerprinting. No account, ever.
- "Recently viewed" records only resources you explicitly open from a Find Similar card, is capped at 50, is toggleable and is clearable.

All injected CSS is namespaced under `.fmhys-*` (enforced by tests) so the extension cannot restyle FMHY, and the original link text, `href` and behaviour are never modified.

---

## Accessibility

- Full keyboard support: indicators are focusable (`Enter`/`Space`), the card traps `Tab`, `↑`/`↓` move between alternatives, `Esc` closes.
- Visible focus rings on every interactive element.
- ARIA throughout: `role="dialog"` + `aria-labelledby` on the card, `aria-pressed` on favorite toggles, descriptive `aria-label`s ("Add qBittorrent to favorites"), `role="status"`/`"alert"` on notices, a WAI-ARIA tabs pattern in the dashboard.
- `prefers-reduced-motion` disables all transitions and animations.
- `forced-colors` (high contrast) support for the indicator.
- Text contrast meets WCAG AA in both themes.
- Nothing depends on hover alone; touch devices always get a visible *Similar* button.

---

## Development

You don't need any build tools to work on the extension — `src/` is plain, hand-authored
JavaScript and CSS. The tooling is plain Node (≥20), with **zero npm dependencies**:

```bash
npm install          # (no dependencies — only wires up scripts)
npm run icons        # (re)render src/icons/* from assets/logo.svg
npm run build        # assemble platform/chromium and platform/firefox
npm test             # build dry-run + 22 assertions covering parser, schema,
                     #   codec, search, similarity, detector, manifests,
                     #   CSP, selector hygiene and icon integrity
npm run package      # produce dist/FMHY-Similar-{chromium,firefox}-<version>.zip
```

`tools/test.mjs` runs the extension's real modules — including a dependency-free mini-DOM
for the detector — so the bytes that ship are the bytes tested.

### Adding a platform

Adding a new Chromium-derivative (Arc, Opera GX, etc.) requires no code changes — just load
`platform/chromium/` from that browser's extensions page. If you need a separate build for
another MV3 engine (e.g. Safari Web Extensions), add a `manifest.<name>.json` overlay to
`src/` and a stanza to `tools/build.mjs` — the shared code is already browser-agnostic via
`core/browser.js`.

---

## License

FMHY Similar is released under the [MIT License](LICENSE). Resource data is derived from the
publicly published markdown corpus at fmhy.net, which is released under its own license — see
FMHY's own repository for details.
