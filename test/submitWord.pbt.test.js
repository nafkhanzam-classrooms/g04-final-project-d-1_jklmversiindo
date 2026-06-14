'use strict';

/**
 * test/submitWord.pbt.test.js
 *
 * Property 14 — Validates: Requirements 3.1, 4.6, 9.2
 *   Submissions from non-active players are no-ops:
 *   no broadcast, no state change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

require('./_mocks');

const gameManager = require('../server/gameManager');
const validator = require('../server/wordValidator');

// Build a tiny dictionary so isValid won't blow up.
function setupDict() {
  validator._setDictionaryForTests(new Set(['ada', 'apa', 'ikan', 'kasur', 'mata']));
}

// A minimal "io" object recording emit calls.
function makeFakeIo() {
  const calls = [];
  return {
    calls,
    emit: (ev, payload) => calls.push({ ev, payload }),
  };
}

function makeSocket(name) {
  const calls = [];
  return {
    id: name,
    data: {},
    emit: (ev, payload) => calls.push({ ev, payload }),
    _calls: calls,
  };
}

async function startTwoPlayerGame() {
  gameManager._resetForTests();
  setupDict();
  const io = makeFakeIo();
  gameManager.bindIo(io);
  const s1 = makeSocket('s1');
  const s2 = makeSocket('s2');
  const p1 = gameManager.registerPlayer(s1, 'Alice');
  const p2 = gameManager.registerPlayer(s2, 'Bob');
  await gameManager.startGame(p1.id);
  return { io, s1, s2, p1, p2 };
}

test('Property 14: submissions from non-active players are no-ops', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 0, maxLength: 30 }),
      async (word) => {
        const ctx = await startTwoPlayerGame();
        const stateBefore = gameManager._getStateForTests();
        // Identify the non-active player.
        const nonActive = stateBefore.activePlayerId === ctx.p1.id ? ctx.p2.id : ctx.p1.id;
        const ioCallsBefore = ctx.io.calls.length;

        await gameManager.submitWord(nonActive, word);

        const stateAfter = gameManager._getStateForTests();
        assert.equal(stateAfter.round, stateBefore.round);
        assert.equal(stateAfter.activePlayerId, stateBefore.activePlayerId);
        assert.equal(stateAfter.currentSyllable, stateBefore.currentSyllable);
        for (let i = 0; i < stateBefore.players.length; i += 1) {
          assert.equal(stateAfter.players[i].lives, stateBefore.players[i].lives,
            `lives should not change for ${stateBefore.players[i].id}`);
        }
        assert.equal(ctx.io.calls.length, ioCallsBefore,
          'no broadcasts should occur for a non-active submission');
        return true;
      },
    ),
    { numRuns: 100 },
  );
});
