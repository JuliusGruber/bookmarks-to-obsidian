---
name: bookmarks-to-obsidian
description: Use when the user wants to import, sync, or pull their Chrome bookmarks into an Obsidian vault as full-article markdown notes — e.g. "import my AI bookmarks", "sync bookmarks to obsidian", "pull new bookmarks into the vault", "clip my bookmarked articles". Covers the AI reading folder in synced Chrome bookmarks.
---

# Bookmarks → Obsidian

## Overview

On-demand importer. Reads a Chrome bookmark folder via the local
`chrome-bookmarks-gateway`, extracts each **new** article to clean markdown with
Defuddle (the Obsidian Web Clipper's own engine), and writes Web-Clipper-parity
notes into a vault inbox. The work is a deterministic Node CLI; this skill is the
thin operator that health-checks, runs it, and summarizes the JSON report.

## When to use

- "import my AI bookmarks", "sync bookmarks to obsidian", "pull new bookmarks into the vault"
- **Not** for editing/searching bookmarks (use `chrome-bookmarks-gateway`) or one-off single-URL clips.

## Defaults (this machine)

- Tool: `C:\Users\juliu\.claude\skills\bookmarks-to-obsidian\import.mjs`
- Vault: `C:\Users\juliu\Documents\AIEngineeringArticles`
- Folder: `Mobile Lesezeichen/AI` (the iPad-reading home; ~197 links)
- Destination: `Clippings/` inside the vault — the Obsidian Web Clipper's own folder (created on first import). Override with `--inbox <subpath>`.

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

## Flags

`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`. Run the CLI with
`--help` for the full list.

## Common mistakes

- Running with the gateway down → the CLI exits 2 with `{"error":"gateway-unreachable"|"gateway-not-synced"}`. Start the gateway first; don't fabricate results.
- A bare `--folder "AI"` is **ambiguous** (an AI folder exists on the bar *and* under Mobile bookmarks) — the CLI errors with both paths. Use the full path `Mobile Lesezeichen/AI`.
- A real import mutates the vault. For an unfamiliar vault state, dry-run first (step 2) before writing.
- Transient `failed` (e.g. HTTP 429) is normal for rate-limited hosts; re-run later with `--retry-failed`.
