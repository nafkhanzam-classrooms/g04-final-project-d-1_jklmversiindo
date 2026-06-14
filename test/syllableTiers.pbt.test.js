'use strict';

/**
 * test/syllableTiers.pbt.test.js
 *
 * Property 3 — Validates: Requirements 5.1, 5.2, 5.3, 4.7
 *   pickSyllable(round) returns a syllable from the unique active tier.
 *
 * Property 4 — Validates: Requirements 5.1, 5.2, 5.3, 4.7
 *   timerForRound(round) equals the active tier's timerMs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { TIERS, pickSyllable, timerForRound, activeTier } = require('../server/syllableTiers');

test('Property 3: pickSyllable returns a syllable from the round-active tier', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.double({ min: 0, max: 0.999999 }),
      (round, r) => {
        const syl = pickSyllable(round, TIERS, () => r);
        const tier = activeTier(round, TIERS);
        assert.ok(tier.syllables.includes(syl), `expected ${syl} in ${tier.syllables.join(',')} for round=${round}`);
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 4: timerForRound returns the active tier timerMs', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50 }), (round) => {
      const ms = timerForRound(round, TIERS);
      const tier = activeTier(round, TIERS);
      assert.equal(ms, tier.timerMs);
      return true;
    }),
    { numRuns: 200 },
  );
});

test('Boundary: rounds 1-3 -> 10000ms, 4-6 -> 8000ms, 7+ -> 5000ms', () => {
  for (let r = 1; r <= 3; r += 1) assert.equal(timerForRound(r), 10000);
  for (let r = 4; r <= 6; r += 1) assert.equal(timerForRound(r), 8000);
  for (let r = 7; r <= 30; r += 1) assert.equal(timerForRound(r), 5000);
});
