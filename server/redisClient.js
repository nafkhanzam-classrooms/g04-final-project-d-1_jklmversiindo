'use strict';

/**
 * server/redisClient.js
 *
 * Singleton ioredis client used by all server modules.
 *
 * - Lazily connects to 127.0.0.1:6379 (loopback only).
 * - Logs connection errors with a clear `[redis]` prefix; does not crash the
 *   process on transient errors (ioredis will retry automatically).
 * - `close()` quits the connection and resets the singleton (used in tests
 *   and on graceful shutdown).
 */

const Redis = require('ioredis');

let client = null;

function getClient() {
  if (client) return client;

  client = new Redis({
    host: '127.0.0.1',
    port: 6379,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  client.on('error', (err) => {
    console.error('[redis] connection error:', err && err.message ? err.message : err);
  });

  return client;
}

async function close() {
  if (!client) return;
  try {
    await client.quit();
  } catch (err) {
    // Best-effort during shutdown.
    console.error('[redis] error during quit:', err && err.message ? err.message : err);
  }
  client = null;
}

module.exports = { getClient, close };
