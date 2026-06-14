'use strict';

/**
 * server/db.js
 *
 * SQLite persistence layer using better-sqlite3.
 *
 * - `init()`     creates the three required tables idempotently.
 * - `upsertPlayer(id, name)` inserts or updates a player row.
 * - `saveMatch({...})` persists a finished match plus per-player stats
 *   in a single transaction.
 * - `getLeaderboard(limit)` returns top players ordered by total wins.
 *
 * The DB file lives at `<repoRoot>/wordfuse.db` and is auto-created.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'wordfuse.db');

let db = null;
let stmts = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function init() {
  const conn = getDb();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      match_id     TEXT PRIMARY KEY,
      winner_id    TEXT,
      player_count INTEGER NOT NULL,
      ended_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_players (
      match_id        TEXT NOT NULL,
      player_id       TEXT NOT NULL,
      final_rank      INTEGER NOT NULL,
      words_accepted  INTEGER NOT NULL,
      lives_lost      INTEGER NOT NULL,
      PRIMARY KEY (match_id, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_match_players_player
      ON match_players (player_id);
    CREATE INDEX IF NOT EXISTS idx_match_players_rank
      ON match_players (final_rank);
  `);

  stmts = {
    upsertPlayer: conn.prepare(`
      INSERT INTO players (id, name, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `),
    insertMatch: conn.prepare(`
      INSERT INTO matches (match_id, winner_id, player_count, ended_at)
      VALUES (?, ?, ?, ?)
    `),
    insertMatchPlayer: conn.prepare(`
      INSERT INTO match_players
        (match_id, player_id, final_rank, words_accepted, lives_lost)
      VALUES (?, ?, ?, ?, ?)
    `),
    leaderboard: conn.prepare(`
      SELECT
        p.id   AS id,
        p.name AS name,
        COUNT(mp.match_id) AS wins
      FROM players p
      LEFT JOIN match_players mp
        ON mp.player_id = p.id AND mp.final_rank = 1
      GROUP BY p.id, p.name
      ORDER BY wins DESC, p.name ASC
      LIMIT ?
    `),
  };
}

function ensureInit() {
  if (!stmts) init();
}

function upsertPlayer(id, name) {
  ensureInit();
  if (typeof id !== 'string' || !id) throw new Error('upsertPlayer: invalid id');
  if (typeof name !== 'string' || !name) throw new Error('upsertPlayer: invalid name');
  stmts.upsertPlayer.run(id, name, Math.floor(Date.now() / 1000));
}

/**
 * Persists a finished match in a single transaction.
 *
 * @param {{
 *   matchId: string,
 *   winnerId: string | null,
 *   playerCount: number,
 *   players: Array<{ id: string, finalRank: number, wordsAccepted: number, livesLost: number }>
 * }} record
 */
function saveMatch(record) {
  ensureInit();
  if (!record || typeof record !== 'object') {
    throw new Error('saveMatch: record required');
  }
  const { matchId, winnerId = null, playerCount, players } = record;
  if (typeof matchId !== 'string' || !matchId) {
    throw new Error('saveMatch: matchId required');
  }
  if (!Number.isInteger(playerCount) || playerCount < 0) {
    throw new Error('saveMatch: playerCount must be a non-negative integer');
  }
  if (!Array.isArray(players)) {
    throw new Error('saveMatch: players must be an array');
  }

  const endedAt = Math.floor(Date.now() / 1000);
  const conn = getDb();

  const tx = conn.transaction((rec) => {
    stmts.insertMatch.run(rec.matchId, rec.winnerId, rec.playerCount, endedAt);
    for (const p of rec.players) {
      stmts.insertMatchPlayer.run(
        rec.matchId,
        p.id,
        p.finalRank,
        p.wordsAccepted | 0,
        p.livesLost | 0,
      );
    }
  });

  tx({ matchId, winnerId, playerCount, players });
}

function getLeaderboard(limit = 10) {
  ensureInit();
  return stmts.leaderboard.all(Number.isInteger(limit) ? limit : 10);
}

function close() {
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.error('[db] error closing:', err && err.message ? err.message : err);
    }
    db = null;
    stmts = null;
  }
}

module.exports = {
  init,
  upsertPlayer,
  saveMatch,
  getLeaderboard,
  close,
  // Exported for tests only.
  _dbPath: DB_PATH,
};
