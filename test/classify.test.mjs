import { describe, it, expect } from 'vitest';
import { classifyBookmarks } from '../bookmarks-to-obsidian/scripts/src/classify.mjs';

const BM = (id, url, title) => ({ id, url, title });

describe('classifyBookmarks', () => {
  it('marks a bookmark new when it is in neither the vault nor the manifest', () => {
    const bookmarks = [BM('1', 'https://arxiv.org/abs/1706.03762', 'Attention Is All You Need')];
    const { newItems, existingCount, declinedCount } = classifyBookmarks(bookmarks, {
      vaultSet: new Set(),
      manifest: {},
    });
    expect(newItems).toEqual([
      {
        id: '1',
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        domain: 'arxiv.org',
        norm: 'https://arxiv.org/abs/1706.03762',
        slot: 0,
      },
    ]);
    expect(existingCount).toBe(0);
    expect(declinedCount).toBe(0);
  });

  it('records an empty domain for an unparseable URL', () => {
    const { newItems } = classifyBookmarks([BM('1', 'not a url', 'X')], { vaultSet: new Set(), manifest: {} });
    expect(newItems[0].domain).toBe('');
  });

  it('excludes a URL already in the vault and counts it as existing', () => {
    const { newItems, existingCount } = classifyBookmarks([BM('1', 'https://example.com/a', 'A')], {
      vaultSet: new Set(['https://example.com/a']),
      manifest: {},
    });
    expect(newItems).toEqual([]);
    expect(existingCount).toBe(1);
  });

  it('excludes a declined manifest entry, counts it as declined, and never shows it', () => {
    const manifest = { 'https://example.com/declined': { bookmarkId: '9', status: 'declined', at: '2026-06-13' } };
    const out = classifyBookmarks([BM('9', 'https://example.com/declined', 'Declined One')], {
      vaultSet: new Set(),
      manifest,
    });
    expect(out.newItems).toEqual([]);
    expect(out.declinedCount).toBe(1);
    expect(out.existingCount).toBe(0);
  });

  it('keeps a declined entry hidden even under --retry-failed', () => {
    const manifest = { 'https://example.com/declined': { bookmarkId: '9', status: 'declined', at: '2026-06-13' } };
    const out = classifyBookmarks([BM('9', 'https://example.com/declined', 'Declined One')], {
      vaultSet: new Set(),
      manifest,
      retryFailed: true,
    });
    expect(out.newItems).toEqual([]);
    expect(out.declinedCount).toBe(1);
  });

  it('treats a remembered imported entry as existing (not new)', () => {
    const manifest = {
      'https://example.com/done': { bookmarkId: '3', status: 'imported', file: 'Done.md', at: '2026-06-13' },
    };
    const out = classifyBookmarks([BM('3', 'https://example.com/done', 'Done')], { vaultSet: new Set(), manifest });
    expect(out.newItems).toEqual([]);
    expect(out.existingCount).toBe(1);
    expect(out.decided[0]).toMatchObject({ id: '3', status: 'skipped-existing', reason: 'remembered', file: 'Done.md' });
  });

  it('rejoins failed/skipped-thin entries as new only under --retry-failed', () => {
    const manifest = {
      'https://example.com/failed': { bookmarkId: '1', status: 'failed', at: '2026-06-13' },
      'https://example.com/thin': { bookmarkId: '2', status: 'skipped-thin', at: '2026-06-13' },
    };
    const bookmarks = [BM('1', 'https://example.com/failed', 'F'), BM('2', 'https://example.com/thin', 'T')];

    const without = classifyBookmarks(bookmarks, { vaultSet: new Set(), manifest, retryFailed: false });
    expect(without.newItems).toEqual([]); // remembered, hidden

    const withRetry = classifyBookmarks(bookmarks, { vaultSet: new Set(), manifest, retryFailed: true });
    expect(withRetry.newItems.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('collapses a within-run duplicate URL (second occurrence is existing)', () => {
    const bookmarks = [
      BM('1', 'https://example.com/x?utm_source=a', 'X'),
      BM('2', 'https://example.com/x', 'X again'),
    ];
    const out = classifyBookmarks(bookmarks, { vaultSet: new Set(), manifest: {} });
    expect(out.newItems.map((i) => i.id)).toEqual(['1']);
    expect(out.existingCount).toBe(1);
    expect(out.decided[0]).toMatchObject({ status: 'skipped-existing', reason: 'duplicate in run' });
  });

  it('preserves bookmark order and slot indices', () => {
    const bookmarks = [
      BM('1', 'https://example.com/in-vault', 'A'),
      BM('2', 'https://example.com/new', 'B'),
    ];
    const out = classifyBookmarks(bookmarks, {
      vaultSet: new Set(['https://example.com/in-vault']),
      manifest: {},
    });
    expect(out.decided[0].slot).toBe(0);
    expect(out.newItems[0].slot).toBe(1);
  });
});
