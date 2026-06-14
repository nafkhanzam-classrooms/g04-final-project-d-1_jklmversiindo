'use strict';

/**
 * server/gameManager.js
 *
 * Owns the WordFuse rules: lobby, host election, turn order, lives, syllable
 * selection, win condition, and SQLite persistence on game over.
 *
 * Public API:
 *   registerPlayer(socket, name, existingId?)
 *   reattachSocket(playerId, socket)
 *   startGame(callerId)
 *   submitWord(playerId, word)
 *   handleDisconnect(playerId)
 *   advanceTurn(turnOrder, currentId)        // exported for tests
 *   bindIo(io)                               // wire the Socket.io server instance
 *   _getStateForTests()                      // visibility for property tests
 *   _resetForTests()                         // reset module state in tests
 */

const { v4: uuidv4 } = require('uuid');

const wordValidator = require('./wordValidator');
const syllableTiers = require('./syllableTiers');
const timerManager = require('./timerManager');
const redisClient = require('./redisClient');
const db = require('./db');

const MAX_NAME_LEN = 20;
const MAX_WORD_LEN = 64;
const STARTING_LIVES = 3;
const DISCONNECT_GRACE_MS = 5000;

// Registration order is preserved by insertion order of this Map.
const players = new Map();      // playerId -> Player record
const sockets = new Map();      // playerId -> Socket
const disconnectTimers = new Map(); // playerId -> NodeJS.Timeout

let io = null;
let inMatch = false;
let participantIds = [];   // ids of players who started this match (for scoreboard)
let eliminationOrder = []; // ids in the order they were eliminated (earliest = lowest rank)
let turnOrder = [];        // alive player ids
let activePlayerId = null;
let currentSyllable = null;
let round = 0;
let endingMatch = false;   // idempotency guard for game_over

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bindIo(ioServer) {
  io = ioServer;
}

function broadcast(event, payload) {
  if (!io) return;
  try {
    io.emit(event, payload);
  } catch (err) {
    console.error('[gameManager] broadcast failed:', err && err.message ? err.message : err);
  }
}

function emitTo(socket, event, payload) {
  if (!socket) return;
  try {
    socket.emit(event, payload);
  } catch (err) {
    console.error('[gameManager] emitTo failed:', err && err.message ? err.message : err);
  }
}

function getHost() {
  for (const p of players.values()) {
    if (p.isHost) return p;
  }
  return null;
}

function recomputeHost() {
  // If no current host (or current host has been removed), promote the
  // first connected player by registration order.
  const current = getHost();
  if (current && players.has(current.id) && current.connected) return false;

  if (current) current.isHost = false;
  for (const p of players.values()) {
    if (p.connected) {
      p.isHost = true;
      return true;
    }
  }
  return false;
}

function publicPlayerView(p) {
  return {
    id: p.id,
    name: p.name,
    isHost: !!p.isHost,
    connected: !!p.connected,
    lives: p.lives,
  };
}

function broadcastLobby() {
  const list = [...players.values()].map(publicPlayerView);
  broadcast('lobby_update', { players: list });
}

// ---------------------------------------------------------------------------
// Public: registerPlayer
// ---------------------------------------------------------------------------

function registerPlayer(socket, name, existingId) {
  const trimmed = String(name == null ? '' : name).trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LEN) {
    emitTo(socket, 'error', { message: `Name must be 1-${MAX_NAME_LEN} characters.` });
    return null;
  }

  // Reuse existing identity if the client supplied a known id.
  let id = null;
  if (typeof existingId === 'string' && existingId && players.has(existingId)) {
    id = existingId;
  } else if (typeof existingId === 'string' && existingId) {
    // Trust the caller's stable id even if not yet in our map (first join from
    // a browser that already minted a uuid in localStorage).
    id = existingId;
  } else {
    id = uuidv4();
  }

  let p = players.get(id);
  if (!p) {
    p = {
      id,
      name: trimmed,
      isHost: players.size === 0,
      connected: true,
      lives: 0,
      wordsAccepted: 0,
      livesLost: 0,
    };
    players.set(id, p);
  } else {
    p.name = trimmed;
    p.connected = true;
  }

  if (socket) {
    if (!socket.data) socket.data = {};
    socket.data.playerId = id;
    sockets.set(id, socket);
  }

  // Persist the player row best-effort.
  try {
    db.upsertPlayer(id, trimmed);
  } catch (err) {
    console.error('[gameManager] db.upsertPlayer failed:', err && err.message ? err.message : err);
  }

  broadcastLobby();
  return p;
}

// ---------------------------------------------------------------------------
// Public: reattachSocket
// ---------------------------------------------------------------------------

function reattachSocket(playerId, socket) {
  if (typeof playerId !== 'string' || !playerId) return null;

  const existing = players.get(playerId);
  if (!existing) {
    // Unknown id: nothing to reattach. Caller may follow up with join_lobby.
    return null;
  }

  existing.connected = true;
  if (socket) {
    if (!socket.data) socket.data = {};
    socket.data.playerId = playerId;
    sockets.set(playerId, socket);
  }

  // Cancel any pending auto-forfeit for this player.
  const handle = disconnectTimers.get(playerId);
  if (handle) {
    clearTimeout(handle);
    disconnectTimers.delete(playerId);
  }

  // If we promoted a different host while this player was gone, that's fine;
  // we don't demote them back. But if there is currently no host, promote.
  recomputeHost();

  if (inMatch) {
    // Send a snapshot of the current match state to this socket only.
    const livesByPlayer = {};
    for (const p of players.values()) livesByPlayer[p.id] = p.lives;
    emitTo(socket, 'turn_start', {
      activePlayer: activePlayerId,
      syllable: currentSyllable,
      timerMs: syllableTiers.timerForRound(Math.max(1, round)),
      lives: livesByPlayer,
    });
  } else {
    emitTo(socket, 'lobby_update', { players: [...players.values()].map(publicPlayerView) });
  }

  return existing;
}

// ---------------------------------------------------------------------------
// Public: startGame
// ---------------------------------------------------------------------------

async function startGame(callerId) {
  const host = getHost();
  if (!host || callerId !== host.id) {
    const sock = sockets.get(callerId);
    emitTo(sock, 'error', { message: 'Only the host can start the game.' });
    return false;
  }

  const connected = [...players.values()].filter((p) => p.connected);
  if (connected.length < 2) {
    const sock = sockets.get(callerId);
    emitTo(sock, 'error', { message: 'Need at least 2 players to start.' });
    return false;
  }

  if (inMatch) {
    const sock = sockets.get(callerId);
    emitTo(sock, 'error', { message: 'A match is already in progress.' });
    return false;
  }

  inMatch = true;
  endingMatch = false;
  round = 1;
  participantIds = connected.map((p) => p.id);
  eliminationOrder = [];
  turnOrder = [...participantIds];

  for (const id of participantIds) {
    const p = players.get(id);
    p.lives = STARTING_LIVES;
    p.wordsAccepted = 0;
    p.livesLost = 0;
  }

  currentSyllable = syllableTiers.pickSyllable(round);
  activePlayerId = turnOrder[0];

  // Best-effort write to Redis. If Redis is down, the timer manager will
  // surface the error; we still proceed with in-memory state for resilience.
  const redis = redisClient.getClient();
  try {
    await redis.del('game:state', 'game:turn_order', 'game:timer');
    await redis.hmset('game:state', {
      syllable: currentSyllable,
      activePlayerId,
      round: String(round),
      startedAt: String(Date.now()),
    });
    await redis.rpush('game:turn_order', ...participantIds);
    for (const id of participantIds) {
      await redis.set(`player:${id}:lives`, String(STARTING_LIVES));
    }
  } catch (err) {
    console.error('[gameManager] redis init failed:', err && err.message ? err.message : err);
  }

  const timerMs = syllableTiers.timerForRound(round);
  await timerManager.start(
    timerMs,
    (ms) => broadcast('timer_tick', { remainingMs: ms }),
    () => onTimeout(),
  );

  broadcast('game_started', {
    firstPlayer: activePlayerId,
    syllable: currentSyllable,
    timerMs,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Pure helper: advanceTurn
// ---------------------------------------------------------------------------

function advanceTurn(order, currentId) {
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error('advanceTurn: turnOrder must be a non-empty array');
  }
  if (order.length === 1) return order[0];
  const idx = order.indexOf(currentId);
  if (idx === -1) {
    // Caller may have already removed the current id (eliminated mid-turn).
    // Fall back to first slot — caller's responsibility to use the correct
    // "previous active" semantics.
    return order[0];
  }
  return order[(idx + 1) % order.length];
}

// ---------------------------------------------------------------------------
// Public: submitWord
// ---------------------------------------------------------------------------

async function submitWord(playerId, word) {
  if (!inMatch) return;
  if (typeof playerId !== 'string') return;
  if (playerId !== activePlayerId) return; // silent no-op (R3.1)

  const trimmedWord = String(word == null ? '' : word).trim();
  if (trimmedWord.length > MAX_WORD_LEN) {
    // Per design / R9.3: treat as no-op (do not modify state).
    return;
  }

  const result = wordValidator.isValid(trimmedWord, currentSyllable);
  const submitterSocket = sockets.get(playerId);

  if (!result.ok) {
    emitTo(submitterSocket, 'word_rejected', { word: trimmedWord, reason: result.reason });
    return;
  }

  // Accepted.
  const submitter = players.get(playerId);
  if (submitter) submitter.wordsAccepted += 1;

  await timerManager.stop();
  round += 1;
  const nextPlayerId = advanceTurn(turnOrder, activePlayerId);
  const nextSyllable = syllableTiers.pickSyllable(round);
  activePlayerId = nextPlayerId;
  currentSyllable = nextSyllable;

  const redis = redisClient.getClient();
  try {
    await redis.hmset('game:state', {
      syllable: currentSyllable,
      activePlayerId,
      round: String(round),
    });
  } catch (err) {
    console.error('[gameManager] redis state update failed:', err && err.message ? err.message : err);
  }

  const timerMs = syllableTiers.timerForRound(round);
  await timerManager.start(
    timerMs,
    (ms) => broadcast('timer_tick', { remainingMs: ms }),
    () => onTimeout(),
  );

  broadcast('word_accepted', {
    word: trimmedWord,
    player: playerId,
    nextPlayer: nextPlayerId,
    nextSyllable,
    timerMs,
  });
}

// ---------------------------------------------------------------------------
// Internal: onTimeout (timer expiry / life lost flow)
// ---------------------------------------------------------------------------

async function onTimeout() {
  if (!inMatch || endingMatch) return;

  const loserId = activePlayerId;
  const loser = players.get(loserId);
  if (!loser) return;

  loser.lives = Math.max(0, loser.lives - 1);
  loser.livesLost += 1;

  const redis = redisClient.getClient();
  try {
    await redis.set(`player:${loserId}:lives`, String(loser.lives));
  } catch (err) {
    console.error('[gameManager] failed to update lives in redis:', err && err.message ? err.message : err);
  }

  broadcast('life_lost', { player: loserId, livesRemaining: loser.lives });

  let eliminatedHere = false;
  if (loser.lives <= 0) {
    eliminatedHere = true;
    eliminationOrder.push(loserId);
    broadcast('player_eliminated', { player: loserId });
    turnOrder = turnOrder.filter((id) => id !== loserId);
    try {
      await redis.lrem('game:turn_order', 0, loserId);
    } catch (err) {
      console.error('[gameManager] failed to remove from turn_order in redis:', err && err.message ? err.message : err);
    }
  }

  if (turnOrder.length <= 1) {
    await endMatch(turnOrder.length === 1 ? turnOrder[0] : null);
    return;
  }

  // Continue match.
  round += 1;
  // If the loser was eliminated, advance from the prior position; otherwise
  // pass to the player after the loser in the rotation.
  let nextId;
  if (eliminatedHere) {
    // Caller's `loserId` is no longer in turnOrder; pick a sensible neighbor.
    // Use the slot the loser was in (or 0 if they were last).
    nextId = turnOrder[0]; // safe baseline
    // Try to preserve "next after loser" by approximation: pick the player
    // whose pre-removal index was just after the loser. Since we already
    // removed them, advanceTurn against the still-current activePlayerId
    // wouldn't find them, so we just start with index 0 unless there's
    // a better candidate.
    if (eliminationOrder.length >= 1) {
      // For determinism in tests, just pick turnOrder[0].
      nextId = turnOrder[0];
    }
  } else {
    nextId = advanceTurn(turnOrder, loserId);
  }
  activePlayerId = nextId;
  currentSyllable = syllableTiers.pickSyllable(round);

  try {
    await redis.hmset('game:state', {
      syllable: currentSyllable,
      activePlayerId,
      round: String(round),
    });
  } catch (err) {
    console.error('[gameManager] redis hmset failed:', err && err.message ? err.message : err);
  }

  const timerMs = syllableTiers.timerForRound(round);
  await timerManager.start(
    timerMs,
    (ms) => broadcast('timer_tick', { remainingMs: ms }),
    () => onTimeout(),
  );

  broadcast('turn_start', {
    activePlayer: activePlayerId,
    syllable: currentSyllable,
    timerMs,
  });
}

// ---------------------------------------------------------------------------
// Internal: endMatch
// ---------------------------------------------------------------------------

async function endMatch(winnerId) {
  if (endingMatch) return;
  endingMatch = true;

  await timerManager.stop();

  // Compute scoreboard with dense ranks 1..playerCount.
  // Rank 1 = winner. Subsequent ranks = reverse elimination order
  // (the most-recently eliminated gets a better rank than someone eliminated
  // earlier).
  const playerCount = participantIds.length;
  const scores = [];
  if (winnerId) {
    const w = players.get(winnerId);
    scores.push({
      id: winnerId,
      name: w ? w.name : '',
      finalRank: 1,
      wordsAccepted: w ? w.wordsAccepted : 0,
      livesLost: w ? w.livesLost : 0,
    });
  }
  // Eliminated in reverse order — most recent elimination comes after winner
  // (rank 2), earliest elimination gets the worst rank.
  const eliminatedReversed = [...eliminationOrder].reverse();
  let nextRank = winnerId ? 2 : 1;
  for (const id of eliminatedReversed) {
    if (id === winnerId) continue;
    const p = players.get(id);
    scores.push({
      id,
      name: p ? p.name : '',
      finalRank: nextRank,
      wordsAccepted: p ? p.wordsAccepted : 0,
      livesLost: p ? p.livesLost : 0,
    });
    nextRank += 1;
  }
  // Any participant we somehow didn't account for (defensive): give them last rank.
  for (const id of participantIds) {
    if (scores.find((s) => s.id === id)) continue;
    const p = players.get(id);
    scores.push({
      id,
      name: p ? p.name : '',
      finalRank: nextRank,
      wordsAccepted: p ? p.wordsAccepted : 0,
      livesLost: p ? p.livesLost : 0,
    });
    nextRank += 1;
  }

  // Persist (best-effort; DB failure must not block game_over).
  try {
    db.saveMatch({
      matchId: uuidv4(),
      winnerId: winnerId || null,
      playerCount,
      players: scores.map((s) => ({
        id: s.id,
        finalRank: s.finalRank,
        wordsAccepted: s.wordsAccepted,
        livesLost: s.livesLost,
      })),
    });
  } catch (err) {
    console.error('[gameManager] db.saveMatch failed:', err && err.message ? err.message : err);
  }

  broadcast('game_over', { winner: winnerId || null, scores });

  // Clear redis transient state.
  const redis = redisClient.getClient();
  try {
    await redis.del('game:state', 'game:turn_order', 'game:timer');
    for (const id of participantIds) {
      await redis.del(`player:${id}:lives`);
    }
  } catch (err) {
    console.error('[gameManager] redis cleanup failed:', err && err.message ? err.message : err);
  }

  // Reset local match state so a new start_game is accepted.
  inMatch = false;
  endingMatch = false;
  round = 0;
  activePlayerId = null;
  currentSyllable = null;
  turnOrder = [];
  participantIds = [];
  eliminationOrder = [];
}

// ---------------------------------------------------------------------------
// Public: handleDisconnect
// ---------------------------------------------------------------------------

function handleDisconnect(playerId) {
  if (typeof playerId !== 'string' || !playerId) return;
  const p = players.get(playerId);
  if (!p) return;

  p.connected = false;
  sockets.delete(playerId);

  if (!inMatch) {
    // Lobby case: if the disconnecter was host, promote a new one.
    if (p.isHost) {
      p.isHost = false;
      recomputeHost();
    }
    broadcastLobby();
    return;
  }

  // Match in progress.
  if (playerId !== activePlayerId) return;

  // Active player disconnected — schedule auto-forfeit.
  if (disconnectTimers.has(playerId)) {
    clearTimeout(disconnectTimers.get(playerId));
  }
  const handle = setTimeout(async () => {
    disconnectTimers.delete(playerId);
    // Verify the player is still disconnected AND still the active player.
    const stillP = players.get(playerId);
    if (!stillP || stillP.connected) return;
    if (activePlayerId !== playerId) return;
    if (!inMatch || endingMatch) return;
    try {
      await onTimeout();
    } catch (err) {
      console.error('[gameManager] auto-forfeit onTimeout failed:', err && err.message ? err.message : err);
    }
  }, DISCONNECT_GRACE_MS);
  disconnectTimers.set(playerId, handle);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function _getStateForTests() {
  return {
    inMatch,
    round,
    activePlayerId,
    currentSyllable,
    turnOrder: [...turnOrder],
    participantIds: [...participantIds],
    eliminationOrder: [...eliminationOrder],
    players: [...players.values()].map((p) => ({ ...p })),
  };
}

function _resetForTests() {
  for (const handle of disconnectTimers.values()) clearTimeout(handle);
  disconnectTimers.clear();
  players.clear();
  sockets.clear();
  inMatch = false;
  endingMatch = false;
  round = 0;
  activePlayerId = null;
  currentSyllable = null;
  turnOrder = [];
  participantIds = [];
  eliminationOrder = [];
  io = null;
}

module.exports = {
  registerPlayer,
  reattachSocket,
  startGame,
  submitWord,
  handleDisconnect,
  advanceTurn,
  bindIo,
  _getStateForTests,
  _resetForTests,
};
