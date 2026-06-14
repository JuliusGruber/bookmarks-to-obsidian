import { describe, it, expect } from 'vitest';
import { createContentIndex } from '../bookmarks-to-obsidian/scripts/src/content-index.mjs';
import { fingerprint, simhash, normalizeBody } from '../bookmarks-to-obsidian/scripts/src/fingerprint.mjs';

const ARTICLE = `
Loop engineering is the practice of designing feedback loops that keep an agent on task.
A good loop has three parts: a goal, an observation step, and a correction step.
When the agent drifts away from the plan, the correction step nudges it back toward the goal.
The art is choosing how tight the loop should be. Too tight and the agent thrashes on noise.
Too loose and it wanders off for many steps before anyone notices the problem.
Most production systems settle somewhere in the middle, trimming the loop over time
as they learn which signals actually predict drift and which are just random noise.
`;
const ARTICLE_REPOST = `Subscribe to my newsletter for a weekly post like this one.\n${ARTICLE}`;
const DIFFERENT = `
Yesterday I went hiking in the mountains and saw three deer near the rocky ridge.
The weather was cold but clear, and the narrow trail was covered in fresh white snow.
We packed sandwiches and a thermos of coffee and stopped at the summit for a long lunch.
On the way back down a sudden storm rolled in, so we hurried back toward the parked car.
`;

describe('contentIndex.classify', () => {
  it('returns unique when no title key matches', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('Totally Other', DIFFERENT));
    expect(v.verdict).toBe('unique');
  });

  it('returns exact when the body hash matches, regardless of title', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('A Different Title', ARTICLE));
    expect(v).toMatchObject({ verdict: 'exact', duplicateOf: 'Loop Engineering.md' });
  });

  it('returns near when the title matches and the body is within the distance', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('Loop Engineering', ARTICLE_REPOST));
    expect(v.verdict).toBe('near');
    expect(v.duplicateOf).toBe('Loop Engineering.md');
    expect(v.distance).toBeLessThanOrEqual(6);
  });

  it('returns flag when the title matches but every candidate is beyond the distance', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    const v = idx.classify(fingerprint('Loop Engineering', DIFFERENT));
    expect(v.verdict).toBe('flag');
    expect(v.possibleDuplicateOf).toEqual(['Loop Engineering.md']);
  });

  it('treats an empty title key as no title match (only the exact tier applies)', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    expect(idx.classify(fingerprint('', DIFFERENT)).verdict).toBe('unique');
    expect(idx.classify(fingerprint('', ARTICLE)).verdict).toBe('exact');
  });

  it('honors a custom distance threshold', () => {
    const idx = createContentIndex();
    idx.add(fingerprintFile('Loop Engineering.md', 'Loop Engineering', ARTICLE));
    // distance 0 forces the near tier to miss → flag.
    expect(idx.classify(fingerprint('Loop Engineering', ARTICLE_REPOST), { distance: 0 }).verdict).toBe('flag');
  });
});

// Helper: build the { file, titleKey, bodyHash, simhash } record add() expects.
function fingerprintFile(file, title, markdown) {
  const fp = fingerprint(title, markdown);
  return { file, titleKey: fp.titleKey, bodyHash: fp.bodyHash, simhash: fp.simhash };
}
