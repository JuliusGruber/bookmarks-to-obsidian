// Bookmark classification + id-scoped selection helpers. Pure: no IO. The
// definition of a "new" bookmark (not in the vault, not remembered, not declined)
// lives here, so --list and the import engine agree by construction.
import { normalizeUrl } from './dedup.mjs';

/** Best-effort URL host; '' when the URL won't parse. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Split a folder's bookmarks into genuinely-new vs already-decided.
 *
 *   bookmarks:   [{ id, title, url }]  (from collectBookmarks)
 *   vaultSet:    Set of normalized URLs already present in the vault
 *   manifest:    { normUrl: { status, file?, duplicateOf?, ... } }
 *   retryFailed: re-include manifest `failed`/`skipped-thin` as new (never `declined`)
 *
 * Returns:
 *   newItems:      [{ id, title, url, domain, norm, slot }]  — to render/select
 *   decided:       [{ id, slot, url, title, status, reason, file?, duplicateOf? }]
 *   existingCount: decided.length (already handled: in vault, dup-in-run, or remembered)
 *   declinedCount: bookmarks whose manifest entry is `declined`
 *
 * Every bookmark lands in exactly one of newItems / decided / declined, so
 * newItems.length + decided.length + declinedCount === bookmarks.length.
 */
export function classifyBookmarks(bookmarks, { vaultSet, manifest, retryFailed = false } = {}) {
  const newItems = [];
  const decided = [];
  let declinedCount = 0;
  const seen = new Set();

  bookmarks.forEach((bm, slot) => {
    const norm = normalizeUrl(bm.url);

    if (seen.has(norm)) {
      decided.push({ id: bm.id, slot, url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'duplicate in run' });
      return;
    }
    seen.add(norm);

    if (vaultSet.has(norm)) {
      decided.push({ id: bm.id, slot, url: bm.url, title: bm.title, status: 'skipped-existing', reason: 'already in vault' });
      return;
    }

    const m = manifest[norm];
    if (m && m.status === 'declined') {
      declinedCount += 1;
      return; // hidden: neither new nor existing
    }
    const retryable = m && (m.status === 'failed' || m.status === 'skipped-thin');
    if (m && !(retryFailed && retryable)) {
      const status = m.status === 'imported' ? 'skipped-existing' : m.status;
      decided.push({ id: bm.id, slot, url: bm.url, title: bm.title, status, reason: 'remembered', file: m.file, duplicateOf: m.duplicateOf });
      return;
    }

    newItems.push({ id: bm.id, title: bm.title, url: bm.url, domain: hostOf(bm.url), norm, slot });
  });

  return { newItems, decided, existingCount: decided.length, declinedCount };
}
