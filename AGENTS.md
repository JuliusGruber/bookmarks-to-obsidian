# Repository conventions

## Specs and plans live at the repo root

All design specs and implementation plans go in **root-level** folders named
`specs/` and `plans/`:

- `specs/` — design specs (the "what" and "why": requirements, design decisions).
- `plans/` — implementation plans (the "how": ordered, executable task lists).

Do **not** nest these under `docs/`, `docs/superpowers/`, or any other parent.
There is exactly one `specs/` and one `plans/` directory, both at the repository
root.

### Naming

Prefix every file with the ISO date it was created:

- Spec: `specs/YYYY-MM-DD-<slug>-design.md`
- Plan: `plans/YYYY-MM-DD-<slug>.md`

A spec and its corresponding plan share the same `YYYY-MM-DD-<slug>` stem, e.g.
`specs/2026-06-13-selectable-bookmark-import-design.md` pairs with
`plans/2026-06-13-selectable-bookmark-import.md`.

### When writing new specs/plans

Whenever you (or a skill such as `superpowers:writing-plans` /
`superpowers:brainstorming`) produce a spec or plan, write it directly into the
root `specs/` or `plans/` folder following the naming above — never into a
skill-specific or `docs/`-nested subfolder.

## Tests live at the repo root, outside the skill folder

The distributable skill is the self-contained `bookmarks-to-obsidian/` folder —
the only thing users copy and the only thing packaged into a `.skill`. To keep
that folder shippable, **dev artifacts must not live inside it**:

- The **test suite** lives in the root-level `test/` folder and imports the code
  under test from `../bookmarks-to-obsidian/scripts/src/`. Never put tests,
  fixtures, `vitest`, or other dev tooling inside `bookmarks-to-obsidian/`.
- The **skill's own `package.json`** declares **runtime dependencies only** (no
  `devDependencies`, no test scripts).
- The **root `package.json`** is the dev/test harness: it depends on `vitest` and
  on the skill folder itself via a `file:` dependency, so the skill's runtime
  deps resolve during tests from a single source of truth. Run `npm install` then
  `npm test` at the repo root.

When packaging a `.skill`, only the `bookmarks-to-obsidian/` folder ships;
`node_modules/` is excluded and the root harness stays behind.

## Git workflow — commit directly to `main`

This is a single-maintainer repository. **Commit directly to `main` and push to
`origin/main`.** Do not create feature branches, git worktrees, or pull requests
for changes here — this deliberately overrides the default "branch first when on
the default branch" behavior.

## Git commit messages — shell syntax

This is a Windows repo with two shells available: PowerShell **and** the Bash
tool (Git Bash / POSIX sh). Each parses multi-line strings differently, and
mixing them corrupts commit messages.

- **PowerShell here-strings** use `@'` … `'@`. They are **only** valid in the
  PowerShell tool.
- **The Bash tool does not understand `@'…'@`.** It reads `@` as a literal
  character, so a PowerShell here-string passed to `git commit -m` leaks a stray
  `@` into the commit subject.

To stay shell-agnostic, write commit messages with **repeated `-m` flags** (one
per paragraph) — this works identically in both shells:

```sh
git commit -m "subject line" -m "body paragraph one" -m "body paragraph two"
```

Only use a here-string when you have matched the syntax to the tool: `@'…'@` in
the **PowerShell** tool, or a POSIX heredoc (`git commit -F - <<'EOF' … EOF`)
in the **Bash** tool.

### Prefer the PowerShell tool for git in this repo

This machine's interactive shell is PowerShell, so **run git commands through the
PowerShell tool** to match the user's environment. Reserve the Bash tool for
genuinely POSIX scripts (e.g. `*.sh` files, shebang scripts). Picking one shell
deliberately — rather than drifting between them — is what prevents the
syntax-mismatch class of bug described above.
