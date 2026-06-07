---
name: bookmarks-to-obsidian
description: Use when the user wants to import, sync, or pull their Chrome bookmarks into an Obsidian vault as full-article markdown notes — e.g. "import my AI bookmarks", "sync bookmarks to obsidian", "pull new bookmarks into the vault", "clip my bookmarked articles". Covers the AI reading folder in synced Chrome bookmarks.
---

# Bookmarks → Obsidian

## Overview

On-demand importer. Reads a Chrome bookmark folder via the local
`chrome-bookmarks-gateway`, **renders each new article in the gateway's Chrome
over CDP** and runs Defuddle in the live page (the Obsidian Web Clipper's own
engine + technique), **harvests the images the page already loaded**, and writes
Web-Clipper-quality notes into a vault inbox. For each page it renders *and*, when
the render looks thin or like a cookie/paywall shell, also raw-fetches and keeps
the better of the two — so it never does worse than before. The work is a
deterministic Node CLI; this skill is the thin operator that health-checks, runs
it, and summarizes the JSON report.

## When to use

- "import my AI bookmarks", "sync bookmarks to obsidian", "pull new bookmarks into the vault"
- **Not** for editing/searching bookmarks (use `chrome-bookmarks-gateway`) or one-off single-URL clips.

## Defaults (this machine)

- Tool: `C:\Users\juliu\.claude\skills\bookmarks-to-obsidian\import.mjs`
- Vault: `C:\Users\juliu\Documents\AIEngineeringArticles`
- Folder: `Mobile Lesezeichen/AI` (the iPad-reading home; ~197 links)
- Destination: `Clippings/` inside the vault — the Obsidian Web Clipper's own folder (created on first import). Override with `--inbox <subpath>`.

## Rendering & images

- Rendering uses the **same dedicated Chrome the gateway already runs** (CDP on
  `http://localhost:9222`) — no extra browser. Each article is opened in a fresh
  tab, consent banners are dismissed (EN+DE, precision-targeted), the page is
  rendered and extracted with in-page Defuddle, and the tab is closed. The
  gateway's Chrome is left running (connect/disconnect only).
- **Pick-the-better:** if the render is missing, below `--min-words`, or looks
  like a consent/paywall/JS shell, the importer also raw-fetches and keeps the
  better extraction. Each `imported` item reports `path`: `rendered` or
  `fetched-fallback`.
- **Images** are harvested from the render's own network responses (authenticated,
  defeats hotlink/cookie/CORS); anything not captured is node-fetched, and
  anything still unreachable keeps its remote URL (counted as `imagesRemote`).
  They are saved to `Clippings/_attachments/` and referenced as Obsidian embeds
  (`![[name]]`) so links survive when you move notes into `Articles/…`. Tracking
  pixels (< 33px) are dropped.
- A full backfill renders ~3 pages at a time; budget roughly **15–30 minutes for
  ~200 links** (slower than the old fetch-only path). Per-item progress is printed
  to **stderr**. `--dry-run` **does** render (capped to `--limit`, or 10 if no
  limit) for an honest preview, but writes no notes and downloads no images — so
  dry-run notes still show remote image URLs; do a small throwaway-inbox import to
  verify the downloaded-image experience.

## Workflow

1. **Health check** the gateway: `curl -sS http://localhost:3000/syncz` → expect `{"ok":true}`.
   - No connection → tell the user to run `C:\Users\juliu\cbg-up.ps1` (offer it; do **not** launch Chrome silently). Re-check after.
   - `503` → Chrome profile not synced; same fix.
2. **First run / when unsure → dry-run first** so the user can eyeball quality:
   ```
   node "C:\Users\juliu\.claude\skills\bookmarks-to-obsidian\import.mjs" --vault "C:\Users\juliu\Documents\AIEngineeringArticles" --folder "Mobile Lesezeichen/AI" --dry-run --limit 10
   ```
3. **Real import** (writes notes) — drop `--dry-run`; omit `--limit` for the full backfill:
   ```
   node "C:\Users\juliu\.claude\skills\bookmarks-to-obsidian\import.mjs" --vault "C:\Users\juliu\Documents\AIEngineeringArticles" --folder "Mobile Lesezeichen/AI"
   ```
4. **Parse** the JSON report on stdout and **summarize** in prose: imported N → inbox, plus skipped/failed counts. List the `skipped-thin` and `failed` items for manual triage. Never paste the raw JSON at the user.
5. **Offer next**: `--retry-failed` (re-attempts `failed` + `skipped-thin`), open the inbox, or clip a thin one manually in Safari/Web Clipper.

## Report statuses

| status | meaning |
|---|---|
| `imported` | new note written to the inbox |
| `skipped-existing` | URL already in the vault or import manifest |
| `skipped-thin` | wordCount below `--min-words` (video / SPA / paywall) |
| `skipped-binary` | non-HTML content type (PDF, image) |
| `failed` | fetch error (HTTP/DNS/timeout); retry with `--retry-failed` |
| `skipped-limit` | a new bookmark held back by `--limit` this run |

Each `imported` item also reports `path` (`rendered` or `fetched-fallback`) and an
`images` count (`downloaded` / `remote` / `dropped`). The report `meta.render`
block summarizes how many were rendered vs. fell back, and total images
downloaded vs. left remote — surface this in your summary (e.g. "42 imported
(40 rendered, 2 fetch-fallback), 130 images saved, 4 left remote").

## Flags

`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`, `--no-render`,
`--cdp-url`, `--render-concurrency N`, `--no-dismiss-consent`. Run the CLI with
`--help` for the full list.

## Common mistakes

- Running with the gateway down → the CLI exits 2 with `{"error":"gateway-unreachable"|"gateway-not-synced"}`. Start the gateway first; don't fabricate results.
- A bare `--folder "AI"` is **ambiguous** (an AI folder exists on the bar *and* under Mobile bookmarks) — the CLI errors with both paths. Use the full path `Mobile Lesezeichen/AI`.
- A real import mutates the vault. For an unfamiliar vault state, dry-run first (step 2) before writing.
- Transient `failed` (e.g. HTTP 429) is normal for rate-limited hosts; re-run later with `--retry-failed`.
