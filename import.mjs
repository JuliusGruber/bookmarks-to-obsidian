#!/usr/bin/env node
// Bookmark -> Obsidian importer (deterministic CLI).
//
// Walks a Chrome bookmark folder via the local chrome-bookmarks-gateway,
// extracts each new article to clean Web-Clipper-parity markdown with Defuddle,
// writes notes into a vault inbox, and prints a structured JSON report.
//
// Usage:
//   node import.mjs --vault <path> --folder "Mobile Lesezeichen/AI" [options]
//
// See --help for the full flag list.

import { mkdir, readdir } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { checkGateway, getTree, findFolder, collectBookmarks } from './src/gateway.mjs';
import { fetchPage, extractFromHtml } from './src/extract.mjs';
import { splitAuthors, normalizeDate, buildFrontmatter } from './src/frontmatter.mjs';
import { sanitizeFilename, uniqueFilename, writeNoteFile } from './src/note.mjs';
import {
  normalizeUrl,
  scanVaultSources,
  readManifest,
  writeManifest,
} from './src/dedup.mjs';
import { buildReport } from './src/report.mjs';

const HELP = `bookmarks-to-obsidian — import Chrome bookmarks into an Obsidian vault.

Required:
  --vault <path>         Absolute path to the Obsidian vault root.
  --folder <name|path>   Bookmark folder, e.g. "Mobile Lesezeichen/AI".
                         A bare ambiguous name errors with the candidate paths.

Options:
  --inbox <subpath>      Vault-relative destination folder (default: Clippings).
  --dry-run              Plan only: fetch/extract nothing is written, no manifest update.
  --limit <N>            Process at most N new bookmarks this run.
  --retry-failed         Re-attempt manifest entries marked failed or skipped-thin.
  --min-words <N>        Word-count floor for the thin-content gate (default: 200).
  --concurrency <N>      Parallel fetches (default: 4).
  --rpc-url <url>        Gateway RPC URL (default: http://localhost:3000/rpc).
  --gateway <url>        Gateway base URL for health check (default: http://localhost:3000).
  -h, --help             Show this help.

Output: a JSON report on stdout. Diagnostics go to stderr.`;

function parseArgs(argv) {
  const opts = {
    vault: null,
    folder: null,
    inbox: 'Clippings',
    dryRun: false,
    limit: Infinity,
    retryFailed: false,
    minWords: 200,
    concurrency: 4,
    rpcUrl: 'http://localhost:3000/rpc',
    gateway: 'http://localhost:3000',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    switch (a) {
      case '--vault': opts.vault = next(); break;
      case '--folder': opts.folder = next(); break;
      case '--inbox': opts.inbox = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--limit': opts.limit = Number(next()); break;
      case '--retry-failed': opts.retryFailed = true; break;
      case '--min-words': opts.minWords = Number(next()); break;
      case '--concurrency': opts.concurrency = Math.max(1, Number(next())); break;
      case '--rpc-url': opts.rpcUrl = next(); break;
      case '--gateway': opts.gateway = next(); break;
      case '-h': case '--help': opts.help = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function todayISO() {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${da}`;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fail(error, detail) {
  process.stdout.write(`${JSON.stringify({ error, detail }, null, 2)}\n`);
  process.exit(2);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (!opts.vault) fail('missing-vault', 'Pass --vault <path>.');
  if (!opts.folder) fail('missing-folder', 'Pass --folder "<name or path>".');

  const vaultAbs = isAbsolute(opts.vault) ? opts.vault : resolve(opts.vault);
  const inboxAbs = join(vaultAbs, opts.inbox);
  const manifestPath = join(inboxAbs, '.import-state.json');
  const created = todayISO();

  // 1. Gateway health.
  const health = await checkGateway(opts.gateway);
  if (health.status === 0) fail('gateway-unreachable', `Cannot reach ${opts.gateway}. Run cbg-up.ps1.`);
  if (!health.ok) fail('gateway-not-synced', `GET /syncz -> ${health.status}. Chrome profile not synced.`);

  // 2. Resolve the folder and its bookmarks.
  let bookmarks;
  let folderName;
  try {
    const roots = await getTree(opts.rpcUrl);
    const folder = findFolder(roots, opts.folder);
    folderName = folder.title;
    bookmarks = collectBookmarks(folder);
  } catch (e) {
    fail('folder-resolution-failed', e.message);
    return;
  }

  // 3. Dedup state: vault scan (truth) + manifest (provenance/fast path).
  const vaultSet = await scanVaultSources(vaultAbs);
  const manifest = await readManifest(manifestPath);
  let existingNames = new Set();
  try {
    existingNames = new Set((await readdir(inboxAbs)).filter((n) => n.toLowerCase().endsWith('.md')));
  } catch {
    /* inbox not created yet */
  }

  // 4. Classify each bookmark into already-decided vs. to-process.
  const outcomes = []; // final report items, in bookmark order
  const toProcess = []; // { bm, norm, slot } slot = index into outcomes
  const seen = new Set();
  for (const bm of bookmarks) {
    const norm = normalizeUrl(bm.url);
    const slot = outcomes.length;
    if (seen.has(norm)) {
      outcomes.push({ url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'duplicate in run' });
      continue;
    }
    seen.add(norm);
    if (vaultSet.has(norm)) {
      outcomes.push({ url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'already in vault' });
      continue;
    }
    const m = manifest[norm];
    const retryable = m && (m.status === 'failed' || m.status === 'skipped-thin');
    if (m && !(opts.retryFailed && retryable)) {
      const status = m.status === 'imported' ? 'skipped-existing' : m.status;
      outcomes.push({ url: bm.url, title: bm.title, status, reason: 'remembered', file: m.file });
      continue;
    }
    outcomes.push({ url: bm.url, title: bm.title, status: 'pending' });
    toProcess.push({ bm, norm, slot });
  }

  // 5. Apply --limit; anything beyond it is reported, never silently dropped.
  const within = toProcess.slice(0, opts.limit);
  for (const { bm, slot } of toProcess.slice(opts.limit)) {
    outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-limit', reason: `beyond --limit ${opts.limit}` };
  }

  if (!opts.dryRun && within.length) await mkdir(inboxAbs, { recursive: true });

  // 6. Fetch + extract + write, bounded by --concurrency.
  await mapPool(within, opts.concurrency, async ({ bm, norm, slot }) => {
    const fetched = await fetchPage(bm.url, { timeoutMs: 20000 });
    if (fetched.status === 'failed') {
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'failed', reason: fetched.reason };
      manifest[norm] = { bookmarkId: bm.id, status: 'failed', reason: fetched.reason, at: created };
      return;
    }
    if (fetched.status === 'skipped-binary') {
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-binary', reason: fetched.reason };
      manifest[norm] = { bookmarkId: bm.id, status: 'skipped-binary', reason: fetched.reason, at: created };
      return;
    }

    const ex = await extractFromHtml(fetched.html, bm.url, { minWords: opts.minWords });
    if (ex.status !== 'ok') {
      const reason = `wordCount ${ex.wordCount} < ${opts.minWords}`;
      outcomes[slot] = { url: bm.url, title: bm.title, status: 'skipped-thin', reason };
      manifest[norm] = { bookmarkId: bm.id, status: 'skipped-thin', reason, at: created };
      return;
    }

    const meta = ex.meta;
    let host = '';
    try { host = new URL(bm.url).host; } catch { /* keep '' */ }
    const title = meta.title || bm.title || host || 'untitled';
    const body = buildFrontmatter({
      title,
      source: bm.url,
      authors: splitAuthors(meta.author),
      published: normalizeDate(meta.published),
      description: meta.description || '',
      created,
    }) + `\n${ex.content}\n`;

    const base = sanitizeFilename(title);
    const filename = uniqueFilename(base, '.md', (n) => existingNames.has(n));
    existingNames.add(filename);

    if (!opts.dryRun) await writeNoteFile(join(inboxAbs, filename), body);
    outcomes[slot] = {
      url: bm.url,
      title,
      status: 'imported',
      file: filename,
      wordCount: ex.wordCount,
      dryRun: opts.dryRun || undefined,
    };
    manifest[norm] = { bookmarkId: bm.id, status: 'imported', file: filename, at: created };
  });

  // 7. Persist manifest (real runs only) and emit the report.
  if (!opts.dryRun) await writeManifest(manifestPath, manifest);

  const report = buildReport(outcomes);
  report.meta = {
    folder: folderName,
    folderSpec: opts.folder,
    vault: vaultAbs,
    inbox: opts.inbox,
    totalBookmarks: bookmarks.length,
    dryRun: opts.dryRun,
    minWords: opts.minWords,
    limit: Number.isFinite(opts.limit) ? opts.limit : null,
    retryFailed: opts.retryFailed,
    generatedAt: created,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  fail('unexpected', e.message || String(e));
});
