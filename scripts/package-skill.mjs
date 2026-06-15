#!/usr/bin/env node
// scripts/package-skill.mjs - repo-root dev tool (never ships).
//
// Builds dist/bookmarks-to-obsidian.skill: a zip of the bookmarks-to-obsidian/
// skill folder including its vendored node_modules/, so recipients run the
// skill with zero `npm install`. Mirrors the official skill-creator packager's
// archive layout (every entry prefixed with the skill folder name) but
// deliberately keeps node_modules, which the official packager strips.

import { createWriteStream } from 'node:fs';
import { mkdir, stat, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillName = 'bookmarks-to-obsidian';
const skillDir = join(repoRoot, skillName);
const distDir = join(repoRoot, 'dist');
const outFile = join(distDir, `${skillName}.skill`);

// Parity with the official packager's exclusions, minus node_modules (we ship it).
const EXCLUDE_DIRS = new Set(['__pycache__']);
const EXCLUDE_FILES = new Set(['.DS_Store']);
const EXCLUDE_SUFFIXES = ['.pyc'];

function isExcluded(relPath) {
  const parts = relPath.split(sep);
  if (parts.some((part) => EXCLUDE_DIRS.has(part))) return true;
  const name = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(name)) return true;
  return EXCLUDE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Refuse to build a copy-and-run archive without its manifest or vendored deps.
  if (!(await exists(join(skillDir, 'SKILL.md')))) {
    throw new Error(`SKILL.md not found in ${skillName}/`);
  }
  if (!(await exists(join(skillDir, 'node_modules')))) {
    throw new Error(`${skillName}/node_modules/ is missing - run \`npm run vendor\` first.`);
  }

  await mkdir(distDir, { recursive: true });

  const output = createWriteStream(outFile);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((resolveDone, rejectDone) => {
    output.on('close', resolveDone);
    archive.on('warning', rejectDone);
    archive.on('error', rejectDone);
  });
  archive.pipe(output);

  let count = 0;
  for await (const file of walk(skillDir)) {
    const rel = relative(skillDir, file);
    if (isExcluded(rel)) continue;
    // Prefix entries with the skill folder, matching relative_to(skill_path.parent).
    const archivePath = `${skillName}/${rel.split(sep).join('/')}`;
    archive.file(file, { name: archivePath });
    count++;
  }

  await archive.finalize();
  await done;
  console.log(`Packaged ${count} files -> ${relative(repoRoot, outFile)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
