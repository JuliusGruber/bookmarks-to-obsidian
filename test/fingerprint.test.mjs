import { describe, it, expect } from 'vitest';
import {
  titleKey,
  normalizeBody,
  bodyHash,
  simhash,
  hamming,
  fingerprint,
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

// A real-prose article, a boilerplate-varied copy (one extra line), and a
// genuinely different post. Kept long so shared 3-grams dominate the SimHash.
const ARTICLE = `
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;

const ARTICLE_REPOST = `
Subscribe to my newsletter for a weekly post like this one.
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;

const DIFFERENT = `
Yesterday I went hiking in the mountains and saw three deer near the rocky ridge.
The weather was cold but clear, and the narrow trail was covered in fresh white snow.
We packed sandwiches and a thermos of coffee and stopped at the summit for a long lunch.
On the way back down a sudden storm rolled in, so we hurried back toward the parked car.
It was a long and tiring day but worth every single step for the view from the very top.
`;

describe('simhash + hamming', () => {
  it('returns a 16-char hex string (64-bit) for any body', () => {
    expect(simhash(normalizeBody(ARTICLE))).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('has zero distance from itself', () => {
    const s = simhash(normalizeBody(ARTICLE));
    expect(hamming(s, s)).toBe(0);
  });

  it('keeps boilerplate-varied copies of one article within the near threshold (<= 6)', () => {
    const a = simhash(normalizeBody(ARTICLE));
    const b = simhash(normalizeBody(ARTICLE_REPOST));
    expect(hamming(a, b)).toBeLessThanOrEqual(6);
  });

  it('puts two distinct same-titled articles well above the threshold (> 6)', () => {
    const a = simhash(normalizeBody(ARTICLE));
    const c = simhash(normalizeBody(DIFFERENT));
    expect(hamming(a, c)).toBeGreaterThan(6);
  });
});

describe('fingerprint', () => {
  it('returns the title key, body hash, simhash and normalized word count', () => {
    const fp = fingerprint('Loop Engineering', 'Hello brave new world.');
    expect(fp.titleKey).toBe(titleKey('Loop Engineering'));
    expect(fp.bodyHash).toBe(bodyHash(normalizeBody('Hello brave new world.')));
    expect(fp.simhash).toBe(simhash(normalizeBody('Hello brave new world.')));
    expect(fp.wordCount).toBe(4);
  });

  it('fingerprints the same article identically before and after image rewrite', () => {
    const remote = fingerprint('A', 'Intro.\n\n![x](https://cdn/x.png)\n\nOutro body text here.');
    const local = fingerprint('A', 'Intro.\n\n![[A-01.png]]\n\nOutro body text here.');
    expect(remote.bodyHash).toBe(local.bodyHash);
    expect(remote.simhash).toBe(local.simhash);
  });
});
