'use strict';

/**
 * test/turnOrder.pbt.test.js
 *
 * Property 5 — Validates: Requirements 3.2
 *   For any non-empty turnOrder of length n with currentId in turnOrder,
 *   applying advanceTurn n times returns to currentId, and the n
 *   intermediate ids are exactly the elements of turnOrder (each visited once).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// We mock the redis client and db before requiring gameManager so that the
// module never actually tries to connect to Redis or open a SQLite file.
require('./_mocks');

const { advanceTurn } = require('../server/gameManager');

test('Property 5: advanceTurn rotates exactly once around the ring', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 0, max: 7 }),
      (turnOrder, startIndexBase) => {
        const startIdx = startIndexBase % turnOrder.length;
        const start = turnOrder[startIdx];
        let cur = start;
        const visited = [];
        for (let i = 0; i < turnOrder.length; i += 1) {
          cur = advanceTurn(turnOrder, cur);
          visited.push(cur);
        }
        // After n applications, we should be back at the start.
        assert.equal(cur, start, 'should return to start after n rotations');
        // The set of visited ids should equal the set of turnOrder.
        assert.deepEqual([...visited].sort(), [...turnOrder].sort());
        // The first n-1 visited ids should not include start (single rotation).
        for (let i = 0; i < visited.length - 1; i += 1) {
          assert.notEqual(visited[i], start, 'should not revisit start before n steps');
        }
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test('advanceTurn returns the only id when length is 1', () => {
  assert.equal(advanceTurn(['only'], 'only'), 'only');
});
