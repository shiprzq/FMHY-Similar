# FMHY Similar

A lightweight Manifest V3 browser extension that enhances the [FMHY](https://fmhy.net) wiki
**without replacing or modifying its design**. It marks the resources on a page, lets you
favorite them, and — the main event — shows you **similar alternatives instantly**, from a
local database, with no backend and no network request per interaction.

> Unofficial community project. Not affiliated with, or endorsed by, FMHY.

---

## What it does

| Feature | Behaviour |
|---|---|
| **Resource detection** | Finds genuine resource links in the article body and reads their name, URL, category, section, description and tags. Navigation, headers, footers, TOC, callouts and `↪️` cross-references are ignored. |
| **Red indicator** | A thin 2px red line beside each detected resource. CSS-only, keyboard focusable, ARIA labelled, no layout shift. |
| **Favorite button** | A subtle ☆ that becomes a clear ★. Stored in extension storage; survives browser restarts and extension reloads. No account. |
| **Find Similar** | Double-click a resource or its indicator (or press the *Similar* button) to open a card with **at most 5** ranked alternatives. Never opens a new tab. |
| **Similarity engine** | Weighted scoring over category, tags, keywords, description, features and platform. Normalised 0–100. |
| **Search** | Local index supporting exact, prefix and fuzzy matching across names, tags, categories and descriptions. |
| **Dashboard** | Favorites, Recently Viewed and quick Search from the toolbar icon. |
| **Settings** | General / Appearance / Database / Privacy, including a safe database updater. |

**20,601 real resources** are bundled, parsed from FMHY's own published wiki markdown.

---

## Install (Chrome / Chromium / Edge / Brave / Opera)

1. Download or clone this folder.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the `fmhy-similar/` folder.
5. Visit any page on <https://fmhy.net> — e.g. [fmhy.net/video-tools](https://fmhy.net/video-tools).

You should see a thin red line and a ☆ beside each resource. Double-click one.

To produce a distributable archive: `npm run package` → `fmhy-similar.zip`.

### Usage

| Action | How |
|---|---|
| Find similar | Double-click the resource or its red line, or click the **Similar** pill |
| Find similar (keyboard) | Focus the red line with `Tab`, press `Enter` or `Space` |
| Navigate the card | `↑` / `↓` between alternatives, `Tab` cycles all controls |
| Close the card | `Esc`, or click anywhere outside |
| Favorite | Click the ☆ beside a resource, or inside the card |
| Dashboard | Click the toolbar icon (`/` focuses search) |
| Settings | Toolbar icon → gear |

On touch devices and narrow screens the *Similar* pill is always visible and the card
docks as a bottom sheet, so nothing depends on hover or double-click alone.

---

## Architecture

```
fmhy-similar/
├── manifest.json               MV3 config — 2 permissions, 2 host permissions, strict CSP
├── background/
│   └── service-worker.js       Owns the DB + index; message router; update alarm
├── content/
│   ├── content.js              Orchestrator: settings → scan → resolve → decorate
│   ├── detector.js             Finds real resources; rejects chrome/nav/callouts
│   ├── indicators.js           Red line, favorite star, "Similar" pill
│   ├── similar-popup.js        The Find Similar card (positioning, a11y, focus trap)
│   └── styles.css              Fully namespaced (.fmhys-*), theme-aware
├── core/
│   ├── namespace.js            Shared global bootstrap (no bundler needed)
│   ├── browser.js              chrome/browser shim → promise API (Firefox portability)
│   ├── text.js                 slugify, tokenize, stemming, Jaccard, Levenshtein
│   ├── url-validator.js        The only path to any href/navigation
│   ├── storage.js              Settings, favorites, recents, chunked DB persistence
│   ├── favorites.js            Favorites store + cross-surface change events
│   ├── search.js               Inverted + prefix + trigram index
│   └── similarity.js           Weighted scoring & candidate generation
├── database/
│   ├── resources.json          Bundled seed: 20,601 resources (packed form)
│   ├── schema.js               Record validation, normalisation, dedupe
│   ├── fmhy-parser.js          FMHY markdown → structured records
│   ├── codec.js                Dictionary encoding (9.5 MB → 3.3 MB, lossless)
│   ├── sources.js              Where datasets come from
│   └── database.js             Load / index / update / import / reset
├── popup/                      Dashboard (html/js/css)
├── options/                    Settings page (html/js/css)
├── icons/
└── tools/                      Build & test scripts (not shipped)
```

Every module attaches to a shared `FMHYS` namespace, so the **same source files** run in the
service worker (`importScripts`), the content script (manifest `js` array), the extension
pages (`<script src>`) and Node (build/test) — no bundler, no duplicated logic.

---

## The resource dataset

### Where the data comes from

FMHY publishes its wiki as markdown, which is what this extension consumes:

- `https://raw.githubusercontent.com/fmhy/edit/main/docs/<page>.md` — the project's own git
  mirror, one document per wiki page (**default**)
- `https://fmhy.net/single-page.md` — the entire wiki in one document (fallback)

This is **not scraping**. These are documents FMHY publishes specifically for reuse (they are
listed on FMHY's own [Backups page](https://fmhy.net/other/backups)). The extension:

- reads **only** already-published markdown, never rendered pages
- makes network requests **only** when you press *Update database* (or, if you opt in, at
  most **once per 24 hours**)
- spaces per-page requests **250 ms** apart
- makes **zero** network requests during normal browsing or when you use Find Similar

`fmhy.net/robots.txt` allows `/` (disallowing only `/assets/` and image files).

### Schema

```jsonc
{
  "id":          "video-tools--imgburn--majorgeeks-com",  // stable & unique
  "name":        "ImgBurn",
  "url":         "https://www.majorgeeks.com/...",        // the resource itself
  "fmhyUrl":     "https://fmhy.net/video-tools#disc-utilities",
  "category":    "Video Tools",
  "subcategory": "Disc Utilities",
  "section":     "Disc Utilities",
  "page":        "video-tools",
  "description": "CD / DVD Burning",
  "tags":        ["video", "tools", "disc", "burning"],
  "platforms":   ["Windows"],
  "features":    ["burning"],
  "type":        "software",     // site|software|index|tool|guide|extension|app|…
  "starred":     false,          // FMHY's ⭐ recommendation marker
  "mirrors":     ["https://github.com/..."]
}
```

Only `name`, `url` and `fmhyUrl` are required. Everything else is optional and defaulted.

The dataset envelope is `{ "meta": { version, source, generatedAt }, "resources": [ … ] }`.

### Updating the database in the extension

**Settings → Database → Update database.** The pipeline is deliberately conservative:

1. **Download** the markdown (per page, or single-page).
2. **Validate** every record against the schema.
3. **Remove** malformed entries — they are dropped, never "repaired" into nonsense.
4. **Deduplicate** by id and by (name + domain + category); the richer record wins and
   mirrors are merged.
5. **Build** the search and similarity indexes.
6. **Save** locally, chunked, with the meta record written last as the commit point.
7. **Show** the version, date and resource count.

Safety guarantees:

- The previous database is snapshotted as a backup **before** anything is written.
- A dataset where **<50 %** of entries are valid is **rejected outright**.
- A dataset **>50 % smaller** than the installed one is **rejected** as a likely truncation.
- A failed write **restores the backup**.
- A torn/partial read is detected (row count vs. meta) and treated as "unavailable" rather
  than served as corrupt data.

A valid database is therefore never silently overwritten with a corrupted one.

### Importing your own dataset

**Settings → Database → Import JSON…** accepts the envelope above (or a bare array of
records). It goes through the exact same validation, dedupe and rollback path. **Export JSON**
writes the installed database back out.

### Rebuilding the bundled seed

```bash
npm run build:db            # per page from the git mirror (default)
npm run build:db:single     # one request to fmhy.net/single-page.md
node tools/build-database.mjs --from ./some-dir   # parse local .md files
node tools/build-database.mjs --plain             # write uncompacted JSON
```

The build script uses the extension's own parser/validator/codec, verifies the codec round-trip
is lossless, and refuses to write a dataset that fails validation.

---

## Similarity engine

```
similarityScore = categoryMatch      * 0.25
                + tagSimilarity      * 0.25
                + keywordSimilarity  * 0.20
                + descriptionSim     * 0.15
                + featureSimilarity  * 0.10
                + platformMatch      * 0.05
```

- Each component is `0..1`; the result is normalised to **0–100**.
- Keyword and description similarity use **IDF-weighted cosine**, so distinctive words
  ("torrent", "transcoding") count far more than common ones.
- Matching resource type gives a ×1.06 confirmation; an FMHY ⭐ gives ×1.05.
- Resources on the **same registrable domain** are penalised ×0.25 — they are usually the same
  product, not an alternative.
- Candidates come from index postings (same subcategory → shared distinctive terms → same
  category), so a lookup costs **O(candidates)**, never O(20,601).
- Results are deduplicated by **id, name and domain**, capped at **5**, and anything below the
  minimum score (default 28) is **omitted rather than padded**. Fewer good results beat five
  mediocre ones. The current resource is never returned.

Real output from the shipped database:

```
qBittorrent   → qBittorrent Enhanced(93), Transmission(80), BiglyBT(74), Distribyted(72), PikaTorrent(72)
Kdenlive      → Pitivi(76), Flowblade(74), davincibox(70), AV Linux(61), mpv(58)
Jellyfin      → Kodi(58), Awesome Jellyfin(58), Plex(53), Plezy(51)
```

---

## Performance

| Metric | Measured |
|---|---|
| Bundled dataset | 20,601 resources, 3.3 MB packed (9.5 MB raw, **65 % smaller**, lossless) |
| Packaged extension | 934 KB |
| Index build | ~600 ms, once per service-worker lifetime |
| Search query | **~1 ms** |
| Find Similar (cold) | ~11 ms |
| Find Similar (cached) | <0.05 ms |
| Network per interaction | **zero** |

How that is achieved:

- The DOM is scanned **once**; a `WeakSet` guarantees each anchor is examined exactly once.
- A single **batched** message resolves every link on the page, instead of one per link.
- The `MutationObserver` is scoped to the article body, ignores our own nodes, and is
  **debounced at 220 ms**.
- The index and engine live in the **service worker** — built once per session, shared by
  every tab, rather than rebuilt per tab.
- Similarity results are **LRU-cached** (300 entries); IDF values and description term sets
  are memoised.
- The database is stored **dictionary-encoded and chunked**, keeping it at 3.3 MB of the
  10 MB `storage.local` quota.
- No polling, no background timers except the opt-in daily update alarm.

---

## Security & privacy

**Permissions requested:** `storage`, `alarms`. That is all.
**Host permissions:** `https://fmhy.net/*` and `https://raw.githubusercontent.com/fmhy/*`.
No `tabs`, no `history`, no `<all_urls>`.

- All database content is treated as **untrusted input**. There is **no `innerHTML`,
  `outerHTML`, `insertAdjacentHTML`, `eval` or `new Function`** anywhere in the source — every
  string reaches the DOM via `textContent`. This is enforced by a test.
- Every URL passes `url-validator.js` before it becomes an `href` or a navigation:
  `http(s)` only, no credentials-in-URL, length-bounded, parse-checked.
- Strict CSP: `script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- The content script runs **only on `fmhy.net`** — never on third-party resource websites.
- **No browsing history is collected.** The extension cannot read it.
- **No FMHY URLs are sent anywhere.** Matching is entirely local.
- No telemetry, analytics, identifiers or fingerprinting. No account, ever.
- "Recently viewed" records only resources you explicitly open from a Find Similar card, is
  capped at 50, is toggleable and is clearable.

All CSS is namespaced under `.fmhys-*` (enforced by a test) so the extension cannot restyle
FMHY, and the original link text, `href` and behaviour are never modified.

---

## Accessibility

- Full keyboard support: indicators are focusable (`Enter`/`Space`), the card traps `Tab`,
  `↑`/`↓` move between alternatives, `Esc` closes.
- Visible focus rings on every interactive element.
- ARIA throughout: `role="dialog"` + `aria-labelledby` on the card, `aria-pressed` on favorite
  toggles, descriptive `aria-label`s ("Add qBittorrent to favorites"), `role="status"`/`"alert"`
  on notices, WAI-ARIA tabs pattern in the dashboard.
- `prefers-reduced-motion` disables all transitions and animations.
- `forced-colors` (high contrast) support for the indicator.
- Text contrast meets WCAG AA in both themes.
- Nothing depends on hover alone; touch devices always get a visible *Similar* button.

---

## Graceful degradation

The original FMHY page stays fully usable if anything goes wrong:

- Detection, resolution and decoration are individually wrapped — a failure leaves the page
  untouched rather than half-decorated.
- If the **database is unavailable**, indicators are not drawn, Find Similar is hidden, and a
  single dismissible toast explains why with a link to Settings. The page is not broken.
- If the **service worker is unreachable**, the content script exits quietly.
- If **no alternatives clear the score threshold**, the card shows exactly
  **"No strong alternatives found."** — recommendations are never fabricated.
- SPA route changes, lazily rendered content and extension reloads are all handled.

---

## Firefox

Chromium is the current target, but the port is deliberately small:

- No file touches `chrome.*` directly — everything goes through `core/browser.js`, which
  already normalises callback and promise APIs. A test enforces this for content scripts.
- No Chromium-only APIs are used.

To port: swap `background.service_worker` for `background.scripts` (or use the
`background.scripts` + `service_worker` dual key), add `browser_specific_settings.gecko.id`,
and change `options_ui`/`action` if desired. The core, content, popup and options code is
unchanged.

---

## Development

```bash
npm test              # 115 assertions: parser, schema, codec, index, engine, detector, manifest, hygiene
npm run build:db      # regenerate database/resources.json from the FMHY wiki
npm run package       # produce fmhy-similar.zip
```

`tools/test.mjs` runs the extension's real modules — including a dependency-free mini-DOM for
the detector — and covers everything on the acceptance list: detection accuracy, double-click
behaviour, popup positioning, the five-result maximum, favorites persistence, duplicate
prevention, similarity ranking (verified to beat random same-category picks in 58/58 samples),
malformed database entries, broken URLs, dynamically loaded content and extension reloads.
Theme, narrow-screen and interaction behaviour were additionally verified in a headless
Chromium harness.
