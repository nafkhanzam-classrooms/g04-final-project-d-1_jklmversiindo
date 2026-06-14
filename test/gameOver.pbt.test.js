'use strict';

/**
 * test/gameOver.pbt.test.js
 *
 * Property 8 — Validates: Requirements 6.2, 7.1
 *   For any complete match (with player counts 2..6) driven entirely by
 *   timeout events, the server emits exactly one game_over event AND
 *   db.saveMatch is called exactly once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const mocks = require('./_mocks');
const gameManager = require('../server/gameManager');
const validator = require('../server/wordValidator');
const timerManager = require('../server/timerManager');

function patchTimerManager() {
  const captured = { onTimeout: null };
  const realStart = timerManager.start;
  const realStop = timerManager.stop;
  timerManager.start = async function (durationMs, onTick, onTimeout) {
    captured.onTimeout = onTimeout;
    return undefined;
  };
  timerManager.stop = async function () {
    captured.onTimeout = null;
  };
  return {
    captured,
    restore: () => {
      timerManager.start = realStart;
      timerManager.stop = realStop;
    },
  };
}

function makeFakeIo() {
  const calls = [];
  return { calls, emit: (ev, payload) => calls.push({ ev, payload }) };
}

function makeSocket(name) {
  return { id: name, data: {}, emit: () => {} };
}

test('Property 8: exactly one game_over and one saveMatch per match', async () => {
  validator._setDictionaryForTests(new Set(['ada']));
  const patch = patchTimerManager();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        async (n) => {
          gameManager._resetForTests();
          mocks.resetMockState();
          const io = makeFakeIo();
          gameManager.bindIo(io);

          const ids = [];
          for (let i = 0; i < n; i += 1) {
            const s = makeSocket('s' + i);
            const p = gameManager.registerPlayer(s, 'P' + i);
            ids.push(p.id);
          }
          await gameManager.startGame(ids[0]);

          // Drive timeouts until the match ends. Each player has 3 lives,
          // so at most 3 * n timeouts before exactly one player remains.
          const safetyCap = 3 * n + 5;
          let steps = 0;
          while (gameManager._getStateForTests().inMatch && steps < safetyCap) {
            const cb = patch.captured.onTimeout;
            if (typeof cb !== 'function') break;
            await cb();
            steps += 1;
          }

          const gameOverCalls = io.calls.filter((c) => c.ev === 'game_over');
          assert.equal(gameOverCalls.length, 1, 'expected exactly one game_over event');

          const saved = mocks.getMockState().savedMatches;
          assert.equal(saved.length, 1, 'expected exactly one saveMatch call');

          // Sanity: dense ranks 1..n
          const players = saved[0].players;
          assert.equal(players.length, n);
          const ranks = players.map((p) => p.finalRank).sort((a, b) => a - b);
          for (let i = 0; i < n; i += 1) {
            assert.equal(ranks[i], i + 1, `dense rank ${i + 1} expected, got ${ranks[i]}`);
          }
          // Winner row matches winner_id
          const winnerRow = players.find((p) => p.finalRank === 1);
          if (saved[0].winnerId !== null) {
            assert.equal(winnerRow.id, saved[0].winnerId, 'rank 1 must equal winnerId');
          }

          return true;
        },
      ),
      { numRuns: 25 }, // each iteration starts a fresh "match" simulation
    );
  } finally {
    patch.restore();
    validator._resetForTests();
  }
});
