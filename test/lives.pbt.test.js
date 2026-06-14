'use strict';

/**
 * test/lives.pbt.test.js
 *
 * Property 7 — Validates: Requirements 3.3, 3.4, 2.6
 *   For every player p in a single match, lives[p] starts at 3, never
 *   increases, and never goes below 0.
 *
 * We drive a small match with a sequence of "timeout" events (which are the
 * only cause of life loss) and assert the invariant after every step.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { resetMockState } = require('./_mocks');
const gameManager = require('../server/gameManager');
const validator = require('../server/wordValidator');
const timerManager = require('../server/timerManager');
const redisClient = require('../server/redisClient');

// We need to drive `onTimeout` directly; simplest is to install a custom
// timerManager.start that captures the onTimeout callback and never auto-fires.
// We patch via property replacement (only safe because tests run sequentially).
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

test('Property 7: lives are clamped to [0, 3] and monotonically non-increasing', async () => {
  validator._setDictionaryForTests(new Set(['ada', 'apa', 'ikan']));
  const patch = patchTimerManager();
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }), // player count
        fc.array(fc.constant('timeout'), { minLength: 1, maxLength: 12 }),
        async (n, events) => {
          gameManager._resetForTests();
          resetMockState();
          const io = makeFakeIo();
          gameManager.bindIo(io);

          const ids = [];
          for (let i = 0; i < n; i += 1) {
            const s = makeSocket('s' + i);
            const p = gameManager.registerPlayer(s, 'P' + i);
            ids.push(p.id);
          }
          await gameManager.startGame(ids[0]);

          // Initial invariant: every player has lives === 3.
          for (const p of gameManager._getStateForTests().players) {
            assert.equal(p.lives, 3, 'initial lives must be 3');
          }

          let prevLives = {};
          for (const p of gameManager._getStateForTests().players) prevLives[p.id] = p.lives;

          for (const _ of events) {
            const cb = patch.captured.onTimeout;
            if (typeof cb !== 'function') break; // match ended
            await cb();
            const state = gameManager._getStateForTests();
            for (const p of state.players) {
              assert.ok(p.lives >= 0 && p.lives <= 3,
                `lives must stay in [0,3], got ${p.lives} for ${p.id}`);
              assert.ok(p.lives <= prevLives[p.id],
                `lives must be non-increasing for ${p.id}`);
              prevLives[p.id] = p.lives;
            }
            if (!state.inMatch) break;
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  } finally {
    patch.restore();
    validator._resetForTests();
  }
});
