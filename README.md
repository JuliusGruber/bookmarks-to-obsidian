# bookmarks-to-obsidian (Claude skill)

Self-contained Claude Code skill that imports Chrome bookmarks into an Obsidian
vault as clean, Web-Clipper-parity markdown notes.

- **Operator guide:** see [`SKILL.md`](./SKILL.md) — this is what Claude reads.
- **Engine:** `import.mjs` + `src/*.mjs` — a deterministic Node CLI (`node import.mjs --help`).
- **Tests:** `npm test` (vitest unit + Defuddle fixture integration).

## Setup

```
npm install
```

Requires Node 20+ and the local `chrome-bookmarks-gateway` running on
`http://localhost:3000`. Dependencies: `defuddle` (extraction) + `jsdom` (its
DOM backend). If `node_modules/` is missing (e.g. after copying the skill to a
new machine), re-run `npm install` from this directory.

## Design

Built from `docs-fork/2026-06-04-bookmark-to-obsidian-design.md`. Packaged as a
single self-contained skill (rather than a separate repo) so it stays decoupled
from the AI-Engineering-Coach fork while still being unit-testable and cron-able.
