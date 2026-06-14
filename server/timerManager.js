'use strict';

/**
 * server/timerManager.js
 *
 * Authoritative server-side per-turn countdown using Redis TTL as source of
 * truth. At most one timer is active at any time.
 *
 * - `start(durationMs, onTick, onTimeout)` writes
 *   `SET game:timer <durationMs> PX <durationMs>` and starts a 200ms loop
 *   that reads PTTL and emits `onTick(remainingMs)`. When TTL <= 0, calls
 *   `onTimeout()` exactly once and stops.
 * - `stop()` cancels the active timer; `onTimeout` is not invoked afterwards.
 * - `remainingMs()` returns a one-shot snapshot of the remaining TTL.
 */

const TIMER_KEY = 'game:timer';
const TICK_INTERVAL_MS = 200;

let intervalHandle = null;
let activeDuration = 0;
let onTickFn = null;
let onTimeoutFn = null;
let timeoutFired = false;
let activeRunId = 0;

// Lazy require to keep this module unit-testable (the test file can mock the
// redis client first and require this module after).
function getRedis() {
  // eslint-disable-next-line global-require
  return require('./redisClient').getClient();
}

function clearLoop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function start(durationMs, onTick, onTimeout) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`timerManager.start: durationMs must be > 0 (got ${durationMs})`);
  }

  // Cancel any prior run before installing a new one.
  clearLoop();
  timeoutFired = false;
  activeDuration = durationMs;
  onTickFn = typeof onTick === 'function' ? onTick : null;
  onTimeoutFn = typeof onTimeout === 'function' ? onTimeout : null;
  activeRunId += 1;
  const myRunId = activeRunId;

  const redis = getRedis();
  // Use raw `set` with PX option so the TTL is set atomically with the value.
  try {
    await redis.set(TIMER_KEY, String(durationMs), 'PX', durationMs);
  } catch (err) {
    console.error('[timerManager] failed to set redis key:', err && err.message ? err.message : err);
    // Fall through; we will still attempt the loop, but TTL reads may fail
    // and trigger an immediate onTimeout (which is acceptable as a safety net).
  }

  intervalHandle = setInterval(async () => {
    // If a newer start() superseded us, exit silently.
    if (myRunId !== activeRunId) return;

    let pttl;
    try {
      pttl = await redis.pttl(TIMER_KEY);
    } catch (err) {
      console.error('[timerManager] pttl error:', err && err.message ? err.message : err);
      pttl = -2; // treat as expired
    }

    if (myRunId !== activeRunId) return;

    if (typeof pttl !== 'number' || pttl <= 0) {
      // Expired or missing.
      const fn = onTimeoutFn;
      clearLoop();
      timeoutFired = true;
      if (fn) {
        try { fn(); } catch (err) {
          console.error('[timerManager] onTimeout threw:', err && err.message ? err.message : err);
        }
      }
      return;
    }

    // Clamp into [0, activeDuration] to enforce the monotonicity contract.
    const clamped = Math.min(activeDuration, Math.max(0, pttl));
    if (onTickFn) {
      try { onTickFn(clamped); } catch (err) {
        console.error('[timerManager] onTick threw:', err && err.message ? err.message : err);
      }
    }
  }, TICK_INTERVAL_MS);
}

async function stop() {
  clearLoop();
  // Bump the run id so any in-flight async pttl resolutions are ignored.
  activeRunId += 1;
  const redis = getRedis();
  try {
    await redis.del(TIMER_KEY);
  } catch (err) {
    console.error('[timerManager] failed to del redis key:', err && err.message ? err.message : err);
  }
  // Drop callbacks so a buggy caller can't keep them alive.
  onTickFn = null;
  onTimeoutFn = null;
}

async function remainingMs() {
  const redis = getRedis();
  try {
    const pttl = await redis.pttl(TIMER_KEY);
    if (typeof pttl !== 'number' || pttl < 0) return 0;
    return pttl;
  } catch (err) {
    console.error('[timerManager] remainingMs error:', err && err.message ? err.message : err);
    return 0;
  }
}

function _isRunning() {
  return intervalHandle !== null;
}

function _hasFiredTimeout() {
  return timeoutFired;
}

module.exports = {
  start,
  stop,
  remainingMs,
  TIMER_KEY,
  TICK_INTERVAL_MS,
  _isRunning,
  _hasFiredTimeout,
};
