# Rendered clipping — Web-Clipper-parity markdown via in-browser Defuddle

- **Date:** 2026-06-06
- **Skill:** `bookmarks-to-obsidian` (`C:\Users\juliu\.claude\skills\bookmarks-to-obsidian`)
- **Status:** design approved, pending implementation plan

## Problem

The importer produces lower-quality markdown than the Obsidian Web Clipper, even
though it already uses the Clipper's own extraction engine (Defuddle). The user's
three concrete complaints, in priority order:

1. **Missing / thin / mangled body** — pages come through empty, truncated, or
   full of consent-wall / JS-shell junk.
2. **Formatting fidelity** — e.g. a pull-quote duplicated as both a `>` blockquote
   and a body paragraph; runtime-applied code highlighting and math lost.
3. **Images** — broken/relative URLs, lazy-load placeholders, tracking pixels.

Titles and frontmatter are *not* a complaint and are out of scope for changes.

## Root cause (verified)

The current pipeline is `fetch()` raw server HTML → `Defuddle` (node build, jsdom)
→ markdown. The Obsidian Web Clipper instead runs Defuddle against the **live,
rendered, post-JavaScript `document`** in the user's browser. All three complaints
trace to that single difference:

- **Body** — A raw `fetch()` returns only the initial server HTML: SPA shells,
  JS-injected content, and consent/login-gated articles come back empty or
  stubbed. Defuddle cannot extract content that is not in the DOM.
- **Images** — Lazy-loaded *real* image URLs are injected at runtime; on a raw
  fetch only the base64/placeholder `src` is present, which Defuddle then **drops
  as unresolvable**, losing the image entirely. Tracking-pixel and duplicate-image
  removal relies on `getComputedStyle` / `getBoundingClientRect`, which are
  **no-ops under jsdom** (Defuddle gates that path on `isBrowser`), so junk leaks.
- **Formatting** — The duplicated pull-quote is a *visually hidden* duplicate the
  browser would strip via layout measurement; jsdom can't measure, so it survives.
  Same mechanism. Runtime code highlighting and KaTeX/MathJax math exist only in
  the rendered DOM.

Confirmed, so we don't waste effort fixing the wrong thing:

- **The markdown converter is already at parity.** The skill imports
  `defuddle/node` with `markdown: true`; that build runs the *exact same*
  `createMarkdownContent` (Turndown + all custom rules: tables, code-fence
  language, callouts, footnotes, embeds, math) the extension uses. No rule changes
  are needed — the rules just need a *rendered* DOM as input.
- **The node build does not execute scripts.** `defuddle/node` parses with jsdom
  using `resources: 'usable'` but with `runScripts` disabled, so there is no JS
  execution and no layout engine. This is structural, not a config tweak.
- **The Clipper does not download images** — it keeps cleaned remote absolute
  URLs. Local download (below) is a deliberate step *beyond* the Clipper, chosen by
  the user.
- **Feasibility:** a dedicated Chrome is already running with CDP on
  `http://localhost:9222` (proxy on `9223`), signed into the user's Google account
  with bookmark sync — the **same** browser the importer already requires to be up
  (it health-checks the gateway before doing anything). Rendering reuses it with
  **no new browser download and no new runtime requirement.**

## Goals

- Match Web-Clipper body completeness and formatting fidelity by extracting from
  the rendered DOM.
- Resolve, clean, and **download** images into the vault, rewriting links so they
  survive the user's later note-moves.
- Never regress below today's behaviour: keep raw-fetch extraction as a fallback.
- Stay a deterministic Node CLI with unit tests; remain additive to the existing
  module set.

## Non-goals

- No metadata/template/frontmatter changes (titles, author, tags stay as-is).
- No consent-wall *bypass* beyond an optional best-effort flag (off by default).
- No two-stage render cache, no Playwright-launched bundled browser.
- No new vault organisation; the import still lands in `Clippings/` and the user
  continues to file notes into `Articles/<category>/` manually.

## Approach

**Add a CDP-render stage to the existing CLI** (chosen over a two-stage
render-cache or a Playwright rewrite — both add complexity the task doesn't need).
Keep every proven piece (gateway walk, dedup, manifest, report, frontmatter,
filename safety). Replace only the per-bookmark *fetch → extract* core with
*render → extract → download-images*, and keep raw fetch as the fallback.

### Architecture

New modules (existing ones unchanged except `import.mjs` wiring):

| Module | Responsibility |
|---|---|
| `src/render.mjs` *(new)* | Connect to the running Chrome via CDP (connect-only, **no browser binary**), open a tab, navigate, trigger lazy-load, flatten shadow DOM, run **Defuddle in the live `document`**, return cleaned content + metadata, close the tab. |
| `src/images.mjs` *(new)* | Given cleaned content + base URL: download each image, dedupe by content hash, rewrite references to local Obsidian embeds. |
| `import.mjs` *(edited)* | Per-bookmark core becomes render → extract → download-images; steps 1–7 (gateway, classify, limit, manifest, report) unchanged. New per-item report fields. |
| `src/extract.mjs` *(unchanged)* | Its `fetchPage` / `extractFromHtml` become the **fallback** path. |

### Data flow (per bookmark)

```
bookmark.url
  └─ render.mjs: CDP connect → new tab → navigate(networkidle, timeout)
        → auto-scroll to bottom (trigger lazy-loaders) → flatten shadow DOM
        → run Defuddle on live document → { cleanedHtml|markdown, meta } → close tab
        │  (on connect/nav failure → fallback: extract.mjs fetchPage + Defuddle-node)
  └─ markdown: same createMarkdownContent rules (see "Markdown conversion")
  └─ images.mjs: for each <img> URL → download (browser ctx → node fetch)
        → hash + dedupe → write <inbox>/_attachments/<slug-NN.ext>
        → rewrite reference to ![[slug-NN.ext]]   (failed download → leave remote URL)
  └─ frontmatter.mjs (unchanged) + body → note.mjs write
```

### Markdown conversion (parity preserved)

In-page Defuddle does the parse/clean (this is where layout-based cleanup happens:
tracking-pixel removal, hidden duplicate pull-quotes gone, lazy/srcset real URLs
resolved). Markdown is then produced by the **same `createMarkdownContent`** the
skill already ships:

- **Primary:** inject the Defuddle *full browser bundle* and produce markdown
  in-page (exactly what the extension does).
- **Fallback:** if that bundle does not expose the converter, run
  `Defuddle(cleanedHtml, url, { markdown: true })` in node on the
  **already-cleaned** HTML — same Turndown rules, and the layout-based removals
  have already been applied in-page, so jsdom's missing measurement no longer
  matters.

The implementation plan picks one as default and keeps the other as a safety net.

### Image pipeline (decided defaults)

1. **Folder:** one shared `<inbox>/_attachments/` (default `Clippings/_attachments/`),
   created on demand.
2. **Link style:** Obsidian **embed wikilinks** `![[slug-01.png]]`, not markdown
   `![](path)`. *Rationale:* the user later moves notes from `Clippings/` into
   `Articles/<category>/`; relative markdown links break on the move, but
   `![[basename]]` resolves anywhere in the vault. Filenames are made unique
   (note-slug + index) so basename resolution is unambiguous.
3. **Download path:** through the browser context first (reuses the page's cookies
   for session-gated images), falling back to a plain node fetch.
4. **Naming & type:** `<note-slug>-<NN>.<ext>`; extension derived from
   `Content-Type` / magic bytes, not the URL. Dedupe identical bytes within a note
   by content hash.
5. **Skips & failures:** skip `data:` URIs and already-local refs; a failed
   download leaves the original remote URL in place (never breaks the note) and is
   counted in the report.

### Rendering details

- Connect-only to `http://localhost:9222` (or the `9223` proxy). Candidate client
  libs: `playwright-core` (`connectOverCDP`) or `puppeteer-core` (`connect`) — both
  attach without downloading a browser; the plan picks one. No bundled Chromium.
- Viewport ~1280×800, navigate with `waitUntil: networkidle` and a bounded timeout
  (~20s) plus a short settle; **auto-scroll to bottom then top** to trigger lazy
  loaders before extraction.
- Replicate the extension's **shadow-DOM flatten** before parse (small inlined
  helper) so web-component content is captured.
- **Tab hygiene:** one fresh tab per render, always closed (even on error); never
  touch existing tabs or bookmarks, so the gateway's bookmark sync is undisturbed.
- **Render concurrency** default **3** (one Chrome; keep it gentle). This is
  separate from the existing `--concurrency` (raw-fetch fallback).
- **Consent walls:** rely on the persistent `cbg-chrome-profile` remembering
  dismissals; an optional `--dismiss-consent` flag does best-effort common-button
  clicking. Off by default (the extension does none; default clicking is fragile).

### Fallback ladder (per bookmark)

1. CDP render → in-page Defuddle.
2. On CDP-connect or nav failure/timeout → raw `fetchPage` + `Defuddle-node`
   (today's behaviour).
3. On thin/empty or fetch error → recorded as `skipped-thin` / `failed` exactly as
   today.

### Report / status changes

- Per imported item: `path: 'rendered' | 'fetched-fallback'` and
  `images: { downloaded, failed }`.
- Summary: counts of rendered vs fallback, total images downloaded/failed.
- All existing statuses (`imported`, `skipped-existing`, `skipped-thin`,
  `skipped-binary`, `failed`, `skipped-limit`) unchanged.

### Idempotency

Unchanged: the manifest + vault scan skip already-imported URLs, so images are not
re-downloaded on re-runs. Within a run, images dedupe by hash. `--retry-failed`
re-renders and re-downloads, as today.

## Error handling

- CDP unreachable at start → fall back to raw-fetch for the whole run (the gateway
  health-check already gates this; rendering failure must not abort the import).
- Per-page render error/timeout → fallback ladder above; never aborts the run.
- Tab cleanup guaranteed via `finally`; a crashed tab is logged and the bookmark
  takes the fallback path.
- Image download error → leave remote URL, count as failed, continue.

## Testing

- `test/images.test.mjs` *(new)*: URL resolution/absolutization, extension from
  content-type, hash dedupe, wikilink rewrite, filename sanitisation/collision,
  and "failed download leaves the remote URL".
- Render-result → note assembly tested with fixtures (no live browser): a pure
  function takes `{ cleanedHtml|markdown, meta, imageMap }` and returns the note
  body; assert frontmatter + embeds.
- A **guarded live smoke** test (skipped in the default `vitest run`, enabled by an
  env var) connects to CDP and renders a `data:`/localhost page end-to-end.
- Existing tests stay green; the fallback path keeps `extract.mjs` coverage valid.

## Risks & open questions (resolve in the plan)

- **Browser full bundle exposing `createMarkdownContent`** — mitigated by the node
  conversion fallback on already-cleaned HTML.
- **CDP client library choice** (`playwright-core` vs `puppeteer-core`) — decide in
  the plan; requirement is connect-only, no bundled browser.
- **Driving the gateway Chrome during bookmark sync** — mitigated by new-tabs-only,
  low concurrency, guaranteed tab close.
- **Hotlink-protected images** — mitigated by browser-context download.
- **Performance** — ~197 pages × ~2–4s render at concurrency 3 ≈ 10–15 min for a
  full backfill. Acceptable for an occasional backfill; note it in the skill docs.
- **Sites that still block/captcha even when rendered** — accepted; they take the
  fallback path or are skipped, same as today.

## Out of scope

Metadata/template changes, new frontmatter fields, consent-bypass beyond the
optional flag, two-stage render cache, bundled-browser launch.
