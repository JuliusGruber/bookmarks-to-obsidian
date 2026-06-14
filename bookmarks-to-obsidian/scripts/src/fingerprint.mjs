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

// 64-bit hash of a string = the first 8 bytes of its SHA-1 digest (a Buffer).
// Working on the byte buffer avoids BigInt (which is not JSON-serialisable).
function hash64(str) {
  return createHash('sha1').update(str).digest().subarray(0, 8);
}

/**
 * 64-bit SimHash over word 3-gram shingles, returned as a 16-char hex string.
 * Near-identical prose with differing boilerplate lands within a few bits;
 * genuinely different text lands far apart.
 */
export function simhash(normalizedBody, { gram = 3 } = {}) {
  const words = String(normalizedBody).split(' ').filter(Boolean);
  const shingles = [];
  if (words.length < gram) {
    if (words.length) shingles.push(words.join(' '));
  } else {
    for (let i = 0; i + gram <= words.length; i += 1) {
      shingles.push(words.slice(i, i + gram).join(' '));
    }
  }
  const bits = new Array(64).fill(0);
  for (const sh of shingles) {
    const h = hash64(sh); // 8-byte Buffer
    for (let b = 0; b < 64; b += 1) {
      const bit = (h[b >> 3] >> (7 - (b & 7))) & 1;
      bits[b] += bit ? 1 : -1;
    }
  }
  const out = Buffer.alloc(8);
  for (let b = 0; b < 64; b += 1) {
    if (bits[b] > 0) out[b >> 3] |= 1 << (7 - (b & 7));
  }
  return out.toString('hex');
}

/** Bit (Hamming) distance between two hex SimHashes. */
export function hamming(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  const len = Math.min(ba.length, bb.length);
  let dist = 0;
  for (let i = 0; i < len; i += 1) {
    let x = ba[i] ^ bb[i];
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}

/**
 * Shared by the vault scan and the extract stage: fingerprint a note's title +
 * markdown into { titleKey, bodyHash, simhash, wordCount }. wordCount is over the
 * normalized body (so it is comparable across renders).
 */
export function fingerprint(title, markdown) {
  const body = normalizeBody(markdown);
  return {
    titleKey: titleKey(title),
    bodyHash: bodyHash(body),
    simhash: simhash(body),
    wordCount: body ? body.split(' ').length : 0,
  };
}
