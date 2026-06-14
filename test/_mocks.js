'use strict';

/**
 * test/_mocks.js
 *
 * Patches `require` so that:
 *   - `../server/redisClient` returns an in-memory fake client.
 *   - `../server/db`           returns no-op stubs for init/upsertPlayer/saveMatch.
 *
 * Importing this module BEFORE any `../server/...` module ensures the fakes
 * are returned by Node's module cache. Subsequent tests can read recorded
 * calls via `getMockState()`.
 */

const Module = require('module');
const path = require('path');

const recordedSavedMatches = [];

function makeFakeRedis() {
  const hashes = new Map();
  const lists = new Map();
  const strings = new Map();
  const ttls = new Map(); // key -> expiry timestamp ms

  function isExpired(key) {
    const t = ttls.get(key);
    if (!t) return false;
    if (Date.now() >= t) {
      ttls.delete(key);
      strings.delete(key);
      hashes.delete(key);
      lists.delete(key);
      return true;
    }
    return false;
  }

  return {
    async ping() { return 'PONG'; },
    async set(key, val, ...rest) {
      strings.set(key, String(val));
      // Crude PX support: ['PX', ms]
      const i = rest.findIndex((x) => String(x).toUpperCase() === 'PX');
      if (i >= 0 && rest[i + 1]) {
        const ms = parseInt(rest[i + 1], 10);
        if (Number.isFinite(ms) && ms > 0) ttls.set(key, Date.now() + ms);
      }
      return 'OK';
    },
    async get(key) {
      isExpired(key);
      return strings.has(key) ? strings.get(key) : null;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (strings.delete(k)) n += 1;
        if (hashes.delete(k)) n += 1;
        if (lists.delete(k)) n += 1;
        ttls.delete(k);
      }
      return n;
    },
    async pttl(key) {
      isExpired(key);
      const t = ttls.get(key);
      if (!t) return strings.has(key) ? -1 : -2;
      return Math.max(0, t - Date.now());
    },
    async hmset(key, obj) {
      const h = hashes.get(key) || {};
      for (const [k, v] of Object.entries(obj)) h[k] = String(v);
      hashes.set(key, h);
      return 'OK';
    },
    async hgetall(key) {
      return hashes.get(key) || {};
    },
    async rpush(key, ...vals) {
      const arr = lists.get(key) || [];
      arr.push(...vals.map(String));
      lists.set(key, arr);
      return arr.length;
    },
    async lrange(key, start, stop) {
      const arr = lists.get(key) || [];
      const s = stop === -1 ? arr.length : stop + 1;
      return arr.slice(start, s);
    },
    async lrem(key, count, val) {
      const arr = lists.get(key) || [];
      let removed = 0;
      let i = 0;
      while (i < arr.length) {
        if (arr[i] === String(val)) {
          arr.splice(i, 1);
          removed += 1;
          if (count > 0 && removed >= count) break;
          continue;
        }
        i += 1;
      }
      lists.set(key, arr);
      return removed;
    },
    async quit() { return 'OK'; },
    on() {},
  };
}

const fakeClient = makeFakeRedis();

const fakeRedisClient = {
  getClient: () => fakeClient,
  close: async () => {},
};

const fakeDb = {
  init: () => {},
  upsertPlayer: () => {},
  saveMatch: (rec) => { recordedSavedMatches.push(rec); },
  getLeaderboard: () => [],
  close: () => {},
  _dbPath: '<test>',
};

const origResolve = Module._resolveFilename;
const serverDir = path.resolve(__dirname, '..', 'server');
const overrides = new Map([
  [path.join(serverDir, 'redisClient.js'), fakeRedisClient],
  [path.join(serverDir, 'db.js'), fakeDb],
]);

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  // Resolve to absolute path; if it matches an override, return our fake.
  let resolved;
  try {
    resolved = origResolve.call(Module, request, parent, ...rest);
  } catch (e) {
    return origLoad.call(Module, request, parent, ...rest);
  }
  if (overrides.has(resolved)) return overrides.get(resolved);
  return origLoad.call(Module, request, parent, ...rest);
};

function getMockState() {
  return {
    savedMatches: recordedSavedMatches,
  };
}

function resetMockState() {
  recordedSavedMatches.length = 0;
}

module.exports = { getMockState, resetMockState, fakeClient };
