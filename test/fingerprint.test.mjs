import { describe, it, expect } from 'vitest';
import {
  titleKey,
  normalizeBody,
  bodyHash,
} from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

describe('titleKey', () => {
  it('canonicalizes case and whitespace so colliding titles share a key', () => {
    expect(titleKey('Loop Engineering')).toBe(titleKey('  loop   engineering '));
  });

  it('strips filename-illegal characters (matches sanitizeFilename)', () => {
    expect(titleKey('A/B:C')).toBe(titleKey('A B C'));
  });

  it('returns empty string for a missing/empty title so it never matches', () => {
    expect(titleKey('')).toBe('');
    expect(titleKey(null)).toBe('');
    expect(titleKey(undefined)).toBe('');
  });

  it('distinguishes genuinely different titles', () => {
    expect(titleKey('Loop Engineering')).not.toBe(titleKey('Year in Review 2025'));
  });
});

describe('normalizeBody', () => {
  it('drops remote image markup entirely', () => {
    expect(normalizeBody('hello ![alt](https://x.com/y.png) world'))
      .toBe(normalizeBody('hello world'));
  });

  it('drops local Obsidian image embeds entirely', () => {
    expect(normalizeBody('hello ![[my-note-01.png]] world'))
      .toBe(normalizeBody('hello world'));
  });

  it('reduces a markdown link to its anchor text', () => {
    expect(normalizeBody('see [the docs](https://x.com/docs) now'))
      .toBe(normalizeBody('see the docs now'));
  });

  it('is stable across image-path noise (pre- vs post-image-rewrite)', () => {
    const remote = 'Intro paragraph.\n\n![diagram](https://cdn.example.com/a.png)\n\nOutro.';
    const local = 'Intro paragraph.\n\n![[Loop Engineering-01.png]]\n\nOutro.';
    expect(normalizeBody(remote)).toBe(normalizeBody(local));
  });

  it('lowercases and collapses whitespace, dropping heading/emphasis markers', () => {
    expect(normalizeBody('# **Hello**   World\n\n_again_')).toBe('hello world again');
  });
});

describe('bodyHash', () => {
  it('is equal for identical normalized bodies and differs when content changes', () => {
    expect(bodyHash('the same text')).toBe(bodyHash('the same text'));
    expect(bodyHash('the same text')).not.toBe(bodyHash('different text'));
  });

  it('returns SHA-1 hex (40 chars)', () => {
    expect(bodyHash('x')).toMatch(/^[0-9a-f]{40}$/);
  });
});
