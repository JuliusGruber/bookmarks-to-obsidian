# bookmarks-to-obsidian (Claude skill)

Self-contained Claude Code skill that imports Chrome bookmarks into an Obsidian
vault as Web-Clipper-quality markdown notes. It renders each page in the gateway's
Chrome (CDP), runs Defuddle in the live DOM, and harvests the images the page
loaded into the vault — also raw-fetching and keeping the better extraction when a
render looks thin or like a consent/paywall shell.

- **Operator guide:** see [`SKILL.md`](./SKILL.md) — this is what Claude reads.
- **Engine:** `import.mjs` + `src/*.mjs` — a deterministic Node CLI (`node import.mjs --help`).
- **Tests:** `npm test` (vitest unit + Defuddle fixture integration).

## Setup

```
npm install
```

Requires Node 20+ and the local `chrome-bookmarks-gateway` running on
`http://localhost:3000` (its dedicated Chrome, with CDP on `http://localhost:9222`,
doubles as the rendering engine). Dependencies: `defuddle` (extraction; bundles
`linkedom` for node-side parsing), `puppeteer-core` (CDP render + image capture,
connect-only — no bundled browser), and `image-size` (tracking-pixel filtering).
If `node_modules/` is missing (e.g.
after copying the skill to a new machine), re-run `npm install` from this directory.
