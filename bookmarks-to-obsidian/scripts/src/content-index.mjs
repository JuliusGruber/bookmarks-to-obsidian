// In-memory index of known notes' fingerprints. Seeded from the vault scan and
// grown during reconcile, so within-run and cross-run dedup share one code path.
import { hamming } from './fingerprint.mjs';

/**
 * createContentIndex() → { add, classify }.
 *   add({ file, titleKey, bodyHash, simhash })  — register a known note.
 *   classify({ titleKey, bodyHash, simhash }, { distance = 6 }) → verdict object:
 *     { verdict: 'exact', duplicateOf }
 *     { verdict: 'near',  duplicateOf, distance }
 *     { verdict: 'flag',  possibleDuplicateOf: [files] }
 *     { verdict: 'unique' }
 */
export function createContentIndex() {
  const byHash = new Map();  // bodyHash -> file (first writer wins)
  const byTitle = new Map(); // titleKey -> Array<{ file, simhash }>

  function add({ file, titleKey, bodyHash, simhash }) {
    if (bodyHash && !byHash.has(bodyHash)) byHash.set(bodyHash, file);
    if (titleKey) {
      const arr = byTitle.get(titleKey) || [];
      arr.push({ file, simhash });
      byTitle.set(titleKey, arr);
    }
  }

  function classify({ titleKey, bodyHash, simhash }, { distance = 6 } = {}) {
    // Exact tier first: a byte-identical body short-circuits regardless of title.
    if (bodyHash && byHash.has(bodyHash)) {
      return { verdict: 'exact', duplicateOf: byHash.get(bodyHash) };
    }
    const peers = titleKey ? byTitle.get(titleKey) : null;
    if (!peers || !peers.length) return { verdict: 'unique' };

    // Near tier: same title and a close enough body.
    let best = null;
    for (const p of peers) {
      const d = hamming(simhash, p.simhash);
      if (best === null || d < best.distance) best = { distance: d, file: p.file };
    }
    if (best && best.distance <= distance) {
      return { verdict: 'near', duplicateOf: best.file, distance: best.distance };
    }
    // Flag tier: same title, but content diverged from every known peer.
    return { verdict: 'flag', possibleDuplicateOf: peers.map((p) => p.file) };
  }

  return { add, classify };
}
