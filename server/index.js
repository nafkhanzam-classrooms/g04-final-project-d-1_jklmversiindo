'use strict';

/**
 * server/index.js
 *
 * WordFuse process entry point.
 *
 * Steps on startup:
 *  1. Initialize SQLite via db.init().
 *  2. Load the Indonesian dictionary; exit non-zero on missing/invalid/<5000.
 *  3. Verify Redis connectivity (PING); exit non-zero if unreachable.
 *  4. Start an Express static server on 0.0.0.0:3000 serving public/.
 *  5. Start a Socket.io server on 0.0.0.0:3001 with permissive LAN CORS.
 *  6. Wire connection-level event handlers to gameManager (with try/catch
 *     guards so a malformed event from a single client cannot disconnect
 *     other clients or crash the process).
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');
const wordValidator = require('./wordValidator');
const redisClient = require('./redisClient');
const gameManager = require('./gameManager');

const STATIC_PORT = 3000;
const SOCKET_PORT = 3001;

async function main() {
  // 1. SQLite
  try {
    db.init();
  } catch (err) {
    console.error('[startup] db.init failed:', err && err.message ? err.message : err);
    process.exit(1);
  }

  // 2. Dictionary
  try {
    const dictPath = path.resolve(__dirname, '..', 'data', 'words_id.json');
    wordValidator.loadDictionary(dictPath);
    console.log(`[startup] dictionary loaded: ${wordValidator.dictionarySize()} entries`);
  } catch (err) {
    console.error('[startup] dictionary load failed:', err && err.message ? err.message : err);
    console.error('[startup] ensure data/words_id.json exists and contains >= 5000 entries.');
    process.exit(1);
  }

  // 3. Redis
  try {
    const redis = redisClient.getClient();
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error(`unexpected PING response: ${pong}`);
    console.log('[startup] redis OK (PING -> PONG)');
  } catch (err) {
    console.error('[startup] redis unreachable:', err && err.message ? err.message : err);
    console.error('[startup] start `redis-server` on 127.0.0.1:6379 and try again.');
    process.exit(1);
  }

  // 4. Static server
  const app = express();
  const publicDir = path.resolve(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('/health', (req, res) => res.json({ ok: true, dictSize: wordValidator.dictionarySize() }));
  await new Promise((resolve, reject) => {
    const httpServer = app.listen(STATIC_PORT, '0.0.0.0', (err) => {
      if (err) reject(err);
      else resolve(httpServer);
    });
  });
  console.log(`[startup] static server on http://0.0.0.0:${STATIC_PORT} (public/${path.sep})`);

  // 5. Socket.io server
  const sockHttp = http.createServer();
  const io = new Server(sockHttp, {
    cors: { origin: true, credentials: false },
    transports: ['websocket', 'polling'],
  });
  await new Promise((resolve, reject) => {
    sockHttp.listen(SOCKET_PORT, '0.0.0.0', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  console.log(`[startup] socket.io server on http://0.0.0.0:${SOCKET_PORT}`);

  gameManager.bindIo(io);

  // ---------------------------------------------------------------
  // Global chat + system messages.
  // - Maintains a Map<playerId, name> by intercepting lobby_update
  //   broadcasts (so we never mutate gameManager state).
  // - Emits chat_message events with playerId='system' for game
  //   lifecycle hooks (game_started, player_eliminated, game_over).
  // - send_chat is rate-limited per-player to one message / 500 ms,
  //   with a 100-character cap and silent rejection on violation.
  // - Eliminated players can still send and receive chat (no checks
  //   on lives / participation).
  // ---------------------------------------------------------------
  const playerNames = new Map();      // playerId -> name (for system messages)
  const announcedPlayers = new Set(); // playerId -> already announced "joined"
  const lastChatTime = new Map();     // playerId -> last send timestamp
  const CHAT_RATE_MS = 500;
  const CHAT_MAX_LEN = 100;

  const origEmit = io.emit.bind(io);
  io.emit = function (event, payload) {
    origEmit(event, payload);
    try {
      if (event === 'lobby_update' && payload && Array.isArray(payload.players)) {
        for (const p of payload.players) {
          if (p && p.id && p.name) playerNames.set(p.id, p.name);
        }
      } else if (event === 'game_started') {
        systemChat('🎮 Permainan dimulai!');
      } else if (event === 'player_eliminated' && payload && payload.player) {
        const nm = playerNames.get(payload.player) || 'Pemain';
        systemChat(`💀 ${nm} telah gugur!`);
      } else if (event === 'game_over') {
        if (payload && payload.winner) {
          const nm = playerNames.get(payload.winner) || 'Pemenang';
          systemChat(`🏆 ${nm} memenangkan permainan!`);
        } else {
          systemChat('Permainan berakhir tanpa pemenang.');
        }
      }
    } catch (err) {
      console.error('[chat] system mirror failed:', err && err.message ? err.message : err);
    }
  };

  function systemChat(message) {
    origEmit('chat_message', {
      playerId: 'system',
      name: 'System',
      message,
      timestamp: Date.now(),
    });
  }

  // 6. Wire events with per-handler try/catch guards.
  io.on('connection', (socket) => {
    console.log(`[socket] connect ${socket.id}`);

    socket.on('join_lobby', (payload) => {
      try {
        const name = payload && typeof payload.name === 'string' ? payload.name : '';
        const playerId = payload && typeof payload.playerId === 'string' ? payload.playerId : undefined;
        const player = gameManager.registerPlayer(socket, name, playerId);
        if (player && player.id && !announcedPlayers.has(player.id)) {
          announcedPlayers.add(player.id);
          systemChat(`👋 ${player.name} bergabung ke lobby.`);
        }
      } catch (err) {
        console.error('[socket] join_lobby handler error:', err && err.message ? err.message : err);
      }
    });

    socket.on('send_chat', (payload) => {
      try {
        const id = socket.data && socket.data.playerId;
        if (!id) return;
        const raw = payload && typeof payload.message === 'string' ? payload.message : '';
        const message = raw.trim();
        if (!message) return;            // empty / whitespace only — drop
        if (message.length > CHAT_MAX_LEN) return; // too long — drop silently
        const now = Date.now();
        const last = lastChatTime.get(id) || 0;
        if (now - last < CHAT_RATE_MS) return;     // rate limited — drop silently
        lastChatTime.set(id, now);
        const name = playerNames.get(id) || 'Player';
        origEmit('chat_message', {
          playerId: id,
          name,
          message,
          timestamp: now,
        });
      } catch (err) {
        console.error('[socket] send_chat handler error:', err && err.message ? err.message : err);
      }
    });

    socket.on('rejoin', (payload) => {
      try {
        const playerId = payload && typeof payload.playerId === 'string' ? payload.playerId : '';
        if (playerId) gameManager.reattachSocket(playerId, socket);
      } catch (err) {
        console.error('[socket] rejoin handler error:', err && err.message ? err.message : err);
      }
    });

    socket.on('start_game', () => {
      try {
        const id = socket.data && socket.data.playerId;
        if (id) gameManager.startGame(id);
      } catch (err) {
        console.error('[socket] start_game handler error:', err && err.message ? err.message : err);
      }
    });

    socket.on('submit_word', (payload) => {
      try {
        const id = socket.data && socket.data.playerId;
        const word = payload && typeof payload.word === 'string' ? payload.word : '';
        if (id) gameManager.submitWord(id, word);
      } catch (err) {
        console.error('[socket] submit_word handler error:', err && err.message ? err.message : err);
      }
    });

    socket.on('disconnect', (reason) => {
      try {
        const id = socket.data && socket.data.playerId;
        console.log(`[socket] disconnect ${socket.id} (${reason})`);
        if (id) gameManager.handleDisconnect(id);
      } catch (err) {
        console.error('[socket] disconnect handler error:', err && err.message ? err.message : err);
      }
    });

    // Unknown event names are silently ignored by Socket.io (no global rethrow).
  });

  console.log('[startup] WordFuse ready. Open http://localhost:3000');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[startup] fatal error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { main };
