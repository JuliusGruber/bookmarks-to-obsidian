# Rendered clipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bookmarks-to-obsidian` produce Web-Clipper-quality markdown by rendering each page in the already-running gateway Chrome (CDP), running Defuddle in the live DOM, and downloading images into the vault — with raw fetch kept as a fallback so nothing regresses.

**Architecture:** Add two modules. `src/render.mjs` connects to Chrome over CDP (connect-only, no bundled browser), renders the page, and runs Defuddle's browser bundle in the live `document` to get cleaned HTML + rendered-DOM metadata. `src/images.mjs` downloads the images referenced by the produced markdown and rewrites them to Obsidian embeds. `import.mjs` is rewired to a render → `extractFromHtml` → download-images → write flow, falling back to today's `fetchPage` path on any render failure. The markdown converter is unchanged — `extractFromHtml` re-converts the in-page-cleaned HTML and was verified to produce byte-identical markdown.

**Tech Stack:** Node ESM, Defuddle 0.6.6 (`defuddle/node` for conversion, `dist/index.full.js` browser bundle injected in-page), `puppeteer-core` (CDP connect), `image-size` (tracking-pixel filter), vitest.

---

## Deviations from the approved spec (call out if you disagree)

1. **Markdown path:** the spec listed "node conversion of in-page-cleaned HTML" as a *fallback*; it is now the **primary** path. Reason: the installed Defuddle 0.6.6 browser bundle (`index.full.js`) exposes only the `Defuddle` class, **not** `createMarkdownContent`. A spike proved re-feeding the cleaned HTML through `extractFromHtml` yields byte-identical markdown, so this reuses the existing converter and its tests with no fidelity loss.
2. **Image download transport:** the spec said "browser-context first"; the plan uses a **node fetch with `Referer` + Chrome UA** instead. Reason: in-page `fetch()` of cross-origin images is blocked by CORS (opaque responses can't be read), whereas `Referer`+UA defeats the common hotlink-protection case without CORS issues. Truly cookie-gated images fall back to leaving the remote URL in place.
3. **Shadow-DOM flatten:** included as a best-effort in-page step (try/catch), as the spec requested.

Everything else matches the spec: drive the gateway Chrome on `:9222`, in-page Defuddle parse for layout-based cleanup, shared `<inbox>/_attachments/` folder, `![[wikilink]]` embeds, `rendered` vs `fetched-fallback` ladder, optional-off `--dismiss-consent`, render concurrency 3, no metadata/frontmatter changes.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `package.json` | modify | add `puppeteer-core`, `image-size` deps |
| `src/images.mjs` | create | parse image refs from markdown, download (dedupe + tracking-pixel filter), rewrite to `![[…]]` |
| `test/images.test.mjs` | create | unit tests for all of `images.mjs` |
| `src/render.mjs` | create | CDP connect, render, in-page Defuddle parse → cleaned HTML + metadata |
| `test/render.smoke.test.mjs` | create | opt-in live smoke test (skipped unless `RENDER_SMOKE=1`) |
| `import.mjs` | modify | render→extract→images→write flow, fallback ladder, new flags, render summary |
| `SKILL.md` | modify | document rendering, images, new flags, perf note |
| `README.md` | modify | same, for the standalone tool |

The existing `src/extract.mjs`, `src/frontmatter.mjs`, `src/note.mjs`, `src/dedup.mjs`, `src/gateway.mjs`, `src/report.mjs` are reused unchanged (`extract.mjs` becomes the fallback converter).

---

## Task 0: Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the two dependencies**

Edit the `dependencies` block in `package.json` so it reads exactly:

```json
  "dependencies": {
    "defuddle": "^0.6.0",
    "image-size": "^2.0.0",
    "jsdom": "^24.1.0",
    "puppeteer-core": "^23.0.0"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes without error; `node_modules/puppeteer-core` and `node_modules/image-size` exist. `puppeteer-core` does **not** download a browser (that is `puppeteer`, which we are not installing).

- [ ] **Step 3: Verify the image-size v2 named API and Defuddle global are what the code assumes**

Create `_probe.mjs` at the skill root:

```js
import { imageSize } from 'image-size';
// minimal 120x80 PNG header
const b = Buffer.alloc(33);
b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
b.writeUInt32BE(13, 8); b.write('IHDR', 12);
b.writeUInt32BE(120, 16); b.writeUInt32BE(80, 20);
const d = imageSize(new Uint8Array(b));
console.log('image-size:', d.width, d.height, d.type);   // expect 120 80 png
```

Run: `node _probe.mjs && rm -f _probe.mjs` (PowerShell: `node _probe.mjs ; Remove-Item _probe.mjs`)
Expected: `image-size: 120 80 png`. If the named import fails, the installed major is not 2.x — re-pin and adjust `images.mjs` imports before continuing.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add puppeteer-core and image-size deps"
```

(If the skill directory is not yet a git repo, run `git init && git add -A && git commit -m "chore: snapshot before rendered-clipping work"` first, then this commit.)

---

## Task 1: `src/images.mjs` — image download + rewrite

**Files:**
- Create: `src/images.mjs`
- Test: `test/images.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/images.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractImageRefs,
  resolveUrl,
  pickExtension,
  attachmentBase,
  uniqueAttachmentName,
  downloadImages,
} from '../src/images.mjs';

// Build a minimal valid PNG header that image-size can read (w x h).
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
}

describe('extractImageRefs', () => {
  it('finds markdown images, unwrapping <> and ignoring titles', () => {
    const md = 'a ![x](https://e.com/a.png) b ![](<https://e.com/b.jpg> "t") c';
    const refs = extractImageRefs(md);
    expect(refs.map((r) => r.url)).toEqual(['https://e.com/a.png', 'https://e.com/b.jpg']);
    expect(refs[0].alt).toBe('x');
  });
});

describe('resolveUrl', () => {
  it('absolutizes relative against the base, returns null on garbage', () => {
    expect(resolveUrl('/p/x.png', 'https://e.com/a/')).toBe('https://e.com/p/x.png');
    expect(resolveUrl('::::', 'not a url')).toBeNull();
  });
});

describe('pickExtension', () => {
  it('prefers detected type, then content-type, then URL suffix, else png', () => {
    expect(pickExtension('jpg', 'image/png', 'x')).toBe('jpg');
    expect(pickExtension(null, 'image/webp; charset=x', 'x')).toBe('webp');
    expect(pickExtension(null, '', 'https://e.com/x.GIF?z=1')).toBe('gif');
    expect(pickExtension(null, '', 'https://e.com/noext')).toBe('png');
  });
});

describe('attachment naming', () => {
  it('zero-pads the index and sanitizes the slug', () => {
    expect(attachmentBase('My Note/Title', 3)).toBe('My Note Title-03');
  });
  it('avoids collisions against taken names', () => {
    const taken = new Set(['note-01.png']);
    expect(uniqueAttachmentName('note', 1, 'png', taken)).toBe('note-01 (2).png');
  });
});

describe('downloadImages', () => {
  const attachDir = () => mkdtemp(join(tmpdir(), 'b2o-'));

  it('downloads a real image, rewrites to an embed, dedupes by hash', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)\n\n![b](https://e.com/dup.png)';
    const png = fakePng(120, 80);
    const fetchImpl = async () => ({ bytes: png, contentType: 'image/png' });
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.downloaded).toBe(1); // identical bytes => one file, two embeds
    expect(res.markdown).toContain('![[note-01.png]]');
    expect((res.markdown.match(/!\[\[note-01\.png\]\]/g) || []).length).toBe(2);
    const files = await readdir(dir);
    expect(files).toEqual(['note-01.png']);
    expect((await readFile(join(dir, 'note-01.png'))).length).toBe(png.length);
  });

  it('drops tracking pixels (< 33px) and removes their reference', async () => {
    const dir = await attachDir();
    const md = 'before ![pixel](https://e.com/p.png) after';
    const fetchImpl = async () => ({ bytes: fakePng(1, 1), contentType: 'image/png' });
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.dropped).toBe(1);
    expect(res.downloaded).toBe(0);
    expect(res.markdown).toBe('before  after');
  });

  it('leaves the remote URL and counts a failure when download fails', async () => {
    const dir = await attachDir();
    const md = '![a](https://e.com/a.png)';
    const fetchImpl = async () => null;
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(res.failed).toBe(1);
    expect(res.markdown).toBe('![a](https://e.com/a.png)');
  });

  it('skips data: URIs untouched', async () => {
    const dir = await attachDir();
    const md = '![x](data:image/png;base64,AAAA)';
    let called = 0;
    const fetchImpl = async () => { called += 1; return null; };
    const res = await downloadImages(md, { baseUrl: 'https://e.com/post', slug: 'note', attachDir: dir, fetchImpl });
    expect(called).toBe(0);
    expect(res.markdown).toBe(md);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/images.test.mjs`
Expected: FAIL — `Cannot find module '../src/images.mjs'`.

- [ ] **Step 3: Implement `src/images.mjs`**

Create `src/images.mjs`:

```js
// Download the images referenced by extracted markdown into a vault attachments
// folder and rewrite each reference to an Obsidian embed (![[name]]). Embeds are
// used (not ![](path)) so links survive when the note is later moved between
// folders — Obsidian resolves embeds by basename anywhere in the vault.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ![alt](url) or ![alt](<url> "title"); url stops at whitespace or ) unless <wrapped>.
const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

const ILLEGAL = /[\\/:*?"<>|]/g;
const EXT_BY_TYPE = {
  png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp',
  svg: 'svg', bmp: 'bmp', avif: 'avif', ico: 'ico', tiff: 'tiff',
};

/** Parse markdown image references in document order. */
export function extractImageRefs(markdown) {
  const refs = [];
  for (const m of String(markdown).matchAll(IMG_RE)) {
    let url = m[2].trim();
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
    refs.push({ raw: m[0], alt: m[1], url });
  }
  return refs;
}

/** Absolutize `url` against `base`; null if it can't be parsed. */
export function resolveUrl(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

/** Choose a file extension from (in order) the sniffed type, content-type, URL. */
export function pickExtension(detectedType, contentType, url) {
  if (detectedType && EXT_BY_TYPE[detectedType]) return EXT_BY_TYPE[detectedType];
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const fromCt = ct.startsWith('image/') ? ct.slice(6) : '';
  if (EXT_BY_TYPE[fromCt]) return EXT_BY_TYPE[fromCt];
  const m = String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  if (m && EXT_BY_TYPE[m[1].toLowerCase()]) return EXT_BY_TYPE[m[1].toLowerCase()];
  return 'png';
}

export function hashBytes(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

/** `<slug>-NN` with the slug stripped of filename-illegal characters. */
export function attachmentBase(slug, index) {
  const safe = String(slug || 'image').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim() || 'image';
  return `${safe}-${String(index).padStart(2, '0')}`;
}

/** First non-colliding `<base>.<ext>`, then `<base> (2).<ext>`, … */
export function uniqueAttachmentName(slug, index, ext, taken) {
  const base = attachmentBase(slug, index);
  let name = `${base}.${ext}`;
  let n = 2;
  while (taken.has(name)) { name = `${base} (${n}).${ext}`; n += 1; }
  return name;
}

function replaceAll(haystack, needle, replacement) {
  return haystack.split(needle).join(replacement);
}

async function defaultImageFetch(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(referer ? { referer } : {}),
    },
  });
  if (!res.ok) return null;
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || '',
  };
}

/**
 * Download every image in `markdown` into `attachDir`, rewrite each reference to
 * an Obsidian embed, dedupe identical bytes within the note, and drop
 * tracking-pixel-sized images. Returns { markdown, downloaded, failed, dropped }.
 * Failed downloads keep their original remote URL so notes never break.
 */
export async function downloadImages(markdown, {
  baseUrl,
  slug,
  attachDir,
  fetchImpl = defaultImageFetch,
  minDim = 33,
  minBytes = 512,
  takenNames = new Set(),
} = {}) {
  // Unique by raw match so an image used twice is processed once.
  const refs = [];
  const seenRaw = new Set();
  for (const r of extractImageRefs(markdown)) {
    if (!seenRaw.has(r.raw)) { seenRaw.add(r.raw); refs.push(r); }
  }

  let out = markdown;
  let downloaded = 0;
  let failed = 0;
  let dropped = 0;
  const byHash = new Map();
  let index = 0;

  for (const ref of refs) {
    const abs = resolveUrl(ref.url, baseUrl);
    if (!abs || abs.startsWith('data:')) continue; // leave untouched
    index += 1;

    let dl;
    try { dl = await fetchImpl(abs, baseUrl); } catch { dl = null; }
    if (!dl || !dl.bytes || dl.bytes.length === 0) { failed += 1; continue; }

    let dim = null;
    try { dim = imageSize(dl.bytes); } catch { dim = null; }
    const maxDim = dim ? Math.max(dim.width || 0, dim.height || 0) : null;
    const junk = (maxDim !== null && maxDim < minDim) ||
                 (maxDim === null && dl.bytes.length < minBytes);
    if (junk) { out = replaceAll(out, ref.raw, ''); dropped += 1; continue; }

    const h = hashBytes(dl.bytes);
    let name = byHash.get(h);
    if (!name) {
      const ext = pickExtension(dim && dim.type, dl.contentType, abs);
      name = uniqueAttachmentName(slug, index, ext, takenNames);
      takenNames.add(name);
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, name), dl.bytes);
      byHash.set(h, name);
      downloaded += 1;
    }
    out = replaceAll(out, ref.raw, `![[${name}]]`);
  }

  return { markdown: out, downloaded, failed, dropped };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/images.test.mjs`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/images.mjs test/images.test.mjs
git commit -m "feat(images): download + dedupe images, rewrite to obsidian embeds"
```

---

## Task 2: `src/render.mjs` — CDP render + in-page Defuddle

**Files:**
- Create: `src/render.mjs`
- Test: `test/render.smoke.test.mjs`

- [ ] **Step 1: Implement `src/render.mjs`**

Create `src/render.mjs`:

```js
// Render a page in the already-running gateway Chrome (CDP) and run Defuddle in
// the live document — the same thing the Obsidian Web Clipper does. Returns the
// cleaned content HTML plus rendered-DOM metadata; markdown conversion happens in
// node afterwards via extractFromHtml. Never launches or closes the browser
// (connect/disconnect only), so the gateway's Chrome is left running.
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Browser UMD bundle that defines window.Defuddle (the class). 0.6.6 does not
// expose the markdown converter in this bundle — that is done in node.
const DEFUDDLE_BUNDLE = join(HERE, '..', 'node_modules', 'defuddle', 'dist', 'index.full.js');

// Scroll to the bottom (and back) to trigger lazy-loaders before extraction.
const AUTOSCROLL = `async () => {
  await new Promise((resolve) => {
    let total = 0; const step = 800;
    const timer = setInterval(() => {
      window.scrollBy(0, step); total += step;
      if (total >= document.body.scrollHeight + 2000) { clearInterval(timer); resolve(); }
    }, 60);
    setTimeout(() => { clearInterval(timer); resolve(); }, 6000);
  });
  window.scrollTo(0, 0);
}`;

// Best-effort: inline shadow-root content so web-component bodies are captured.
const FLATTEN_SHADOW = `() => {
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) {
      try { el.insertAdjacentHTML('beforeend', el.shadowRoot.innerHTML); } catch (e) {}
    }
  }
}`;

const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.fc-cta-consent',
  'button[aria-label*="accept" i]',
  'button[title*="accept" i]',
];

/** Connect to an existing Chrome over CDP. Does not download or launch a browser. */
export async function connectBrowser(cdpUrl = 'http://localhost:9222') {
  return puppeteer.connect({ browserURL: cdpUrl, protocolTimeout: 60000 });
}

async function tryDismissConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ delay: 20 });
        await new Promise((r) => setTimeout(r, 300));
        return;
      }
    } catch { /* keep trying */ }
  }
}

/**
 * Render `url` and extract via in-page Defuddle.
 * Returns { status: 'ok', content, title, author, published, description, image,
 * site, domain, wordCount } or { status: 'render-failed', reason }.
 */
export async function renderPage(browser, url, { navTimeoutMs = 25000, dismissConsent = false } = {}) {
  let page;
  try {
    page = await browser.newPage();
    await page.setBypassCSP(true); // let addScriptTag run on CSP-strict pages
    await page.setViewport({ width: 1280, height: 900 });
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: navTimeoutMs });
    } catch { /* slow/chatty page: extract whatever finished loading */ }

    if (dismissConsent) await tryDismissConsent(page);
    await page.evaluate(`(${AUTOSCROLL})()`).catch(() => {});
    await page.evaluate(`(${FLATTEN_SHADOW})()`).catch(() => {});
    await page.addScriptTag({ path: DEFUDDLE_BUNDLE });

    const result = await page.evaluate((pageUrl) => {
      const D = window.Defuddle;
      if (!D) return null;
      const r = new D(document, { url: pageUrl }).parse();
      return {
        content: r.content, title: r.title, author: r.author,
        published: r.published, description: r.description, image: r.image,
        site: r.site, domain: r.domain, wordCount: r.wordCount,
      };
    }, url);

    if (!result || !result.content) return { status: 'render-failed', reason: 'empty parse result' };
    return { status: 'ok', ...result };
  } catch (e) {
    return { status: 'render-failed', reason: e.message || String(e) };
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
  }
}
```

- [ ] **Step 2: Write the opt-in smoke test**

Create `test/render.smoke.test.mjs`. It is skipped unless you run with `RENDER_SMOKE=1` AND the gateway Chrome is up — it proves the full live path end-to-end without hitting the network (a `data:` page).

```js
import { describe, it, expect } from 'vitest';
import { connectBrowser, renderPage } from '../src/render.mjs';

const RUN = process.env.RENDER_SMOKE === '1';
const d = RUN ? describe : describe.skip;

d('renderPage (live CDP smoke)', () => {
  it('renders a data: page and extracts the body via in-page Defuddle', async () => {
    const browser = await connectBrowser(process.env.CDP_URL || 'http://localhost:9222');
    try {
      const html =
        '<h1>Smoke Title</h1><article><p>' +
        'This is a sufficiently long article body so Defuddle keeps it as content. '.repeat(8) +
        '</p></article>';
      const res = await renderPage(browser, 'data:text/html,' + encodeURIComponent(html));
      expect(res.status).toBe('ok');
      expect(res.content).toMatch(/sufficiently long article body/);
    } finally {
      await browser.disconnect(); // never .close() — that would kill the gateway Chrome
    }
  }, 60000);
});
```

- [ ] **Step 3: Verify the suite is green and the smoke test is skipped by default**

Run: `npx vitest run`
Expected: PASS; `render.smoke` reported as skipped (no `RENDER_SMOKE`).

- [ ] **Step 4 (optional, requires the gateway up): run the live smoke**

Run (PowerShell): `$env:RENDER_SMOKE=1; npx vitest run test/render.smoke.test.mjs; Remove-Item Env:RENDER_SMOKE`
Expected: PASS. If it errors with a connection failure, start the gateway (`C:\Users\juliu\cbg-up.ps1`) and retry. This step is optional for the commit but recommended before wiring Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/render.mjs test/render.smoke.test.mjs
git commit -m "feat(render): CDP render + in-page Defuddle extraction"
```

---

## Task 3: Wire rendering into `import.mjs`

This task rewires the per-bookmark core and adds flags, a fallback ladder, and a render summary. There are no new unit tests here (the new logic is orchestration over already-tested units); correctness is verified by the existing suite staying green plus the manual dry-run in Task 5.

**Files:**
- Modify: `import.mjs`

- [ ] **Step 1: Add the new imports**

In `import.mjs`, below the existing `import { ... } from './src/report.mjs';` line (currently line 25), add:

```js
import { connectBrowser, renderPage } from './src/render.mjs';
import { downloadImages } from './src/images.mjs';
```

- [ ] **Step 2: Add the new option defaults**

In `parseArgs`, extend the `opts` object literal with these keys (place them after `concurrency: 4,`):

```js
    render: true,
    cdpUrl: 'http://localhost:9222',
    renderConcurrency: 3,
    dismissConsent: false,
```

- [ ] **Step 3: Add the new flag cases**

In the `switch (a)` of `parseArgs`, add these cases before `case '-h':`:

```js
      case '--no-render': opts.render = false; break;
      case '--cdp-url': opts.cdpUrl = next(); break;
      case '--render-concurrency': opts.renderConcurrency = Math.max(1, Number(next())); break;
      case '--dismiss-consent': opts.dismissConsent = true; break;
```

- [ ] **Step 4: Document the flags in the HELP string**

In the `HELP` template literal, add these lines inside the `Options:` block (after the `--concurrency` line):

```
  --no-render            Skip Chrome rendering; use the raw-fetch path only.
  --cdp-url <url>        Chrome CDP endpoint for rendering (default: http://localhost:9222).
  --render-concurrency <N>  Parallel render tabs (default: 3).
  --dismiss-consent      Best-effort click common cookie/consent accept buttons.
```

- [ ] **Step 5: Compute the attachments dir and connect the browser**

In `main`, just after the line `const inboxAbs = join(vaultAbs, opts.inbox);` (currently line 120), add:

```js
  const attachDir = join(inboxAbs, '_attachments');
```

Then, immediately after the `await mkdir(inboxAbs, { recursive: true });` guard for `within.length` (currently line 185), add the browser connection (best-effort: a failure degrades to fetch-only, it must not abort the run):

```js
  // Connect to the gateway Chrome for rendering. Failure → whole run uses fetch.
  let browser = null;
  if (opts.render && !opts.dryRun && within.length) {
    try {
      browser = await connectBrowser(opts.cdpUrl);
    } catch (e) {
      process.stderr.write(`render disabled: cannot connect to ${opts.cdpUrl} (${e.message})\n`);
    }
  }
```

Note: rendering is skipped on `--dry-run` (no notes are written, so no need to spend render time). Dry-run keeps using the existing fetch path to estimate quality.

- [ ] **Step 6: Replace the per-bookmark worker body**

Replace the entire `await mapPool(within, opts.concurrency, async ({ bm, norm, slot }) => { … });` block (currently lines 188-236) with the version below. It renders first, falls back to fetch, downloads images, and records the path taken. Use `opts.renderConcurrency` when a browser is connected, else the old `opts.concurrency`.

```js
  const renderTaken = new Set(); // attachment filenames used this run (collision guard)
  const poolSize = browser ? opts.renderConcurrency : opts.concurrency;

  await mapPool(within, poolSize, async ({ bm, norm, slot }) => {
    let host = '';
    try { host = new URL(bm.url).host; } catch { /* keep '' */ }

    // --- 1. Produce markdown + a metadata source, via render or fetch. ---
    let markdown = null;
    let wordCount = 0;
    let metaSource = null;     // { title, author, published, description }
    let pathTaken = null;      // 'rendered' | 'fetched-fallback'

    if (browser) {
      const r = await renderPage(browser, bm.url, {
        navTimeoutMs: 25000,
        dismissConsent: opts.dismissConsent,
      });
      if (r.status === 'ok') {
        const ex = await extractFromHtml(r.content, bm.url, { minWords: opts.minWords });
        if (ex.status === 'ok') {
          markdown = ex.content;
          wordCount = ex.wordCount;
          metaSource = r; // rendered-DOM metadata (richer than the fragment re-parse)
          pathTaken = 'rendered';
        } else {
          // Rendered but genuinely thin — record and stop (don't waste a fetch).
          const reason = `wordCount ${ex.wordCount} < ${opts.minWords}`;
          outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason, path: 'rendered' };
          manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
          return;
        }
      }
      // r.status === 'render-failed' falls through to the fetch path below.
    }

    if (markdown === null) {
      // --- Fallback: today's raw-fetch path. ---
      const fetched = await fetchPage(bm.url, { timeoutMs: 20000 });
      if (fetched.status === 'failed') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'failed', reason: fetched.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'failed', reason: fetched.reason, at: created };
        return;
      }
      if (fetched.status === 'skipped-binary') {
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-binary', reason: fetched.reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'skipped-binary', reason: fetched.reason, at: created };
        return;
      }
      const ex = await extractFromHtml(fetched.html, bm.url, { minWords: opts.minWords });
      if (ex.status !== 'ok') {
        const reason = `wordCount ${ex.wordCount} < ${opts.minWords}`;
        outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason, path: 'fetched-fallback' };
        manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
        return;
      }
      markdown = ex.content;
      wordCount = ex.wordCount;
      metaSource = ex.meta;
      pathTaken = 'fetched-fallback';
    }

    // --- 2. Title + filename. ---
    const title = (metaSource && metaSource.title) || bm.title || host || 'untitled';
    const base = sanitizeFilename(title);
    const filename = uniqueFilename(base, '.md', (n) => existingNames.has(n));
    existingNames.add(filename);

    // --- 3. Download images (real runs only). ---
    let images = { downloaded: 0, failed: 0, dropped: 0 };
    if (!opts.dryRun) {
      images = await downloadImages(markdown, {
        baseUrl: bm.url,
        slug: base,
        attachDir,
        takenNames: renderTaken,
      });
      markdown = images.markdown;
    }

    // --- 4. Assemble + write the note. ---
    const body = buildFrontmatter({
      title,
      source: bm.url,
      authors: splitAuthors(metaSource && metaSource.author),
      published: normalizeDate(metaSource && metaSource.published),
      description: (metaSource && metaSource.description) || '',
      created,
    }) + `\n${markdown}\n`;

    if (!opts.dryRun) await writeNoteFile(join(inboxAbs, filename), body);

    outcomes[slot] = {
      url: bm.url,
      title,
      status: 'imported',
      file: filename,
      wordCount,
      path: pathTaken,
      images: { downloaded: images.downloaded, failed: images.failed, dropped: images.dropped },
      dryRun: opts.dryRun || undefined,
    };
    manifest[norm] = { bookmarkId: bm.id, status: 'imported', file: filename, at: created };
  });
```

- [ ] **Step 7: Disconnect the browser after the pool finishes**

Immediately after the `await mapPool(...)` call you just wrote, add:

```js
  if (browser) { try { await browser.disconnect(); } catch { /* ignore */ } }
```

`disconnect()` (never `close()`) leaves the gateway's Chrome running.

- [ ] **Step 8: Add a render/image summary to the report meta**

In the `report.meta = { … }` object (currently lines 242-253), add these fields (after `retryFailed: opts.retryFailed,`):

```js
    render: {
      enabled: Boolean(browser),
      rendered: outcomes.filter((o) => o && o.path === 'rendered').length,
      fetchedFallback: outcomes.filter((o) => o && o.path === 'fetched-fallback').length,
      imagesDownloaded: outcomes.reduce((n, o) => n + ((o && o.images && o.images.downloaded) || 0), 0),
      imagesFailed: outcomes.reduce((n, o) => n + ((o && o.images && o.images.failed) || 0), 0),
    },
```

- [ ] **Step 9: Run the full test suite (must stay green)**

Run: `npx vitest run`
Expected: PASS — existing `extract`, `frontmatter`, `gateway`, `note`, `report`, `url` tests plus the new `images` tests; `render.smoke` skipped.

- [ ] **Step 10: Syntax/smoke-check the CLI help**

Run: `node import.mjs --help`
Expected: prints help including the four new flags; exits 0 (no runtime error from the edits).

- [ ] **Step 11: Commit**

```bash
git add import.mjs
git commit -m "feat(import): render via CDP with fetch fallback, download images, report path"
```

---

## Task 4: Documentation

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update `SKILL.md` Overview**

Replace the Overview paragraph (currently lines 8-14) with:

```markdown
## Overview

On-demand importer. Reads a Chrome bookmark folder via the local
`chrome-bookmarks-gateway`, **renders each new article in the gateway's Chrome
over CDP** and runs Defuddle in the live page (the Obsidian Web Clipper's own
engine + technique), downloads the article's images into the vault, and writes
Web-Clipper-quality notes into a vault inbox. If rendering is unavailable it falls
back to a raw fetch so it never does worse than before. The work is a deterministic
Node CLI; this skill is the thin operator that health-checks, runs it, and
summarizes the JSON report.
```

- [ ] **Step 2: Document rendering + images + flags in `SKILL.md`**

After the `## Defaults (this machine)` list (currently ends ~line 26), insert a new section:

```markdown
## Rendering & images

- Rendering uses the **same Chrome the gateway already runs** (CDP on
  `http://localhost:9222`) — no extra browser, no new requirement. Each article is
  opened in a fresh tab, rendered, extracted with in-page Defuddle, and the tab is
  closed. The gateway's Chrome is left running (connect/disconnect only).
- Images are downloaded into `Clippings/_attachments/` and referenced as Obsidian
  embeds (`![[name]]`) so links survive when you move notes into `Articles/…`.
  Tracking pixels (< 33px) are dropped; failed downloads keep their remote URL.
- A full backfill renders ~3 pages at a time; budget roughly 10–15 minutes for
  ~200 links. `--dry-run` does **not** render (it estimates with the fast path).
```

- [ ] **Step 3: Update the `## Flags` list in `SKILL.md`**

Replace the Flags paragraph (currently lines 56-59) with:

```markdown
`--vault`, `--folder`, `--inbox`, `--dry-run`, `--limit N`, `--retry-failed`,
`--min-words N`, `--concurrency N`, `--rpc-url`, `--gateway`, `--no-render`,
`--cdp-url`, `--render-concurrency N`, `--dismiss-consent`. Run the CLI with
`--help` for the full list.
```

- [ ] **Step 4: Add a report-status row and a parsing note in `SKILL.md`**

In the `## Report statuses` section, after the table, add:

```markdown
Each `imported` item also reports `path` (`rendered` or `fetched-fallback`) and an
`images` count. The report `meta.render` block summarizes how many were rendered
vs. fell back, and total images downloaded/failed — surface this in your summary
(e.g. "42 imported (40 rendered, 2 fetch-fallback), 130 images saved").
```

- [ ] **Step 5: Mirror the changes into `README.md`**

Replace the description (currently lines 3-4):

```markdown
Self-contained Claude Code skill that imports Chrome bookmarks into an Obsidian
vault as Web-Clipper-quality markdown notes. It renders each page in the gateway's
Chrome (CDP), runs Defuddle in the live DOM, and downloads images into the vault —
falling back to a raw fetch when rendering is unavailable.
```

Replace the Setup requirements paragraph (currently lines 16-19):

```markdown
Requires Node 20+ and the local `chrome-bookmarks-gateway` running on
`http://localhost:3000` (its Chrome, with CDP on `http://localhost:9222`, doubles
as the rendering engine). Dependencies: `defuddle` + `jsdom` (extraction),
`puppeteer-core` (CDP render, connect-only — no bundled browser), and `image-size`
(tracking-pixel filtering). If `node_modules/` is missing (e.g. after copying the
skill to a new machine), re-run `npm install` from this directory.
```

- [ ] **Step 6: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: document CDP rendering, image download, and new flags"
```

---

## Task 5: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the gateway is up**

Run: `curl -sS http://localhost:3000/syncz`
Expected: `{"ok":true}`. If not, run `C:\Users\juliu\cbg-up.ps1` and re-check.

- [ ] **Step 2: Render-path smoke (live)**

Run (PowerShell): `$env:RENDER_SMOKE=1; npx vitest run test/render.smoke.test.mjs; Remove-Item Env:RENDER_SMOKE`
Expected: PASS — confirms CDP connect + in-page Defuddle work against this machine's Chrome.

- [ ] **Step 3: Small real import into a throwaway inbox**

Run:
```
node import.mjs --vault "C:\Users\juliu\Documents\AIEngineeringArticles" --folder "Mobile Lesezeichen/AI" --inbox "Clippings/_rendertest" --limit 3
```
Expected: JSON report on stdout with `meta.render.enabled: true`, most items `path: "rendered"`, and non-zero `imagesDownloaded`. Diagnostics (if any) on stderr.

- [ ] **Step 4: Eyeball the output quality**

Open the 3 notes under `Clippings/_rendertest/` and the `Clippings/_rendertest/_attachments/` folder. Verify against the original complaints:
- body is complete (not a consent-wall/JS shell),
- images are local `![[…]]` embeds that resolve in Obsidian (no broken/placeholder images, no leftover tracking pixels),
- formatting (code, lists, quotes) reads cleanly; compare one note to the same URL clipped by the real Web Clipper if you have it.

- [ ] **Step 5: Clean up the throwaway inbox**

Delete the `Clippings/_rendertest/` folder (it was only for verification). Do this in the file explorer or:
Run (PowerShell): `Remove-Item -Recurse -Force "C:\Users\juliu\Documents\AIEngineeringArticles\Clippings\_rendertest"`

- [ ] **Step 6: Final full suite**

Run: `npx vitest run`
Expected: PASS, all suites (render.smoke skipped). No commit needed — verification only.

---

## Self-review notes (for the implementer)

- **Fallback guarantee:** if Chrome/CDP is down, `connectBrowser` fails, `browser` stays `null`, and every bookmark takes the original fetch path — behaviour-identical to today plus image download. Verify by running Task 5 Step 3 with `--no-render` and confirming `meta.render.enabled: false` and `path: "fetched-fallback"`.
- **Never kill the gateway Chrome:** only `browser.disconnect()` is used, never `browser.close()`, and only fresh tabs are opened/closed. Grep the diff for `.close()` and confirm it appears only on `page`, never on `browser`.
- **Idempotency:** the manifest + vault scan still skip already-imported URLs before any render, so re-runs don't re-render or re-download. `--retry-failed` re-renders failed/thin entries as before.
- **`extractFromHtml` on cleaned HTML** was verified to equal direct conversion (spike), so the rendered path's markdown matches the converter the fallback path uses.
