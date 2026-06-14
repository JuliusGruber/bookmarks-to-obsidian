// Content fingerprinting for dedup: title key + normalized-body hash + SimHash.
// Self-contained — node:crypto only, no new dependencies.
import { createHash } from 'node:crypto';
import { sanitizeFilename } from './note.mjs';

/**
 * Canonical lookup key for a title: the lowercased, sanitized title. By
 * construction titleKey(a) === titleKey(b) exactly when the two notes' filenames
 * would collide — the title key IS the " (2)" signal, reused as a lookup key.
 * Empty/missing titles return '' so they never match in the by-title index.
 */
export function titleKey(title) {
  const t = String(title ?? '').trim();
  if (!t) return '';
  return sanitizeFilename(t).toLowerCase();
}

/**
 * Reduce markdown to comparable plain text so the fingerprint is stable across
 * boilerplate and image-path noise: drop image markup (remote ![](url) AND local
 * ![[slug]] embeds), reduce links to their anchor text, strip heading/emphasis/
 * code markers, lowercase, collapse whitespace.
 */
export function normalizeBody(markdown) {
  let s = String(markdown ?? '');
  s = s.replace(/!\[\[[^\]]*\]\]/g, ' ');        // local image embeds ![[slug]]
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');    // remote images ![alt](url)
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');  // links [text](url) -> text
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');       // wikilinks [[target]] -> target
  s = s.replace(/[#*_`>~]/g, ' ');                // heading/emphasis/code/quote markers
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** SHA-1 hex of the normalized body — the exact-duplicate key. */
export function bodyHash(normalizedBody) {
  return createHash('sha1').update(String(normalizedBody)).digest('hex');
}
