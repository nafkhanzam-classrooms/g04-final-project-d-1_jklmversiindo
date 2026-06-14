'use strict';

/**
 * server/wordValidator.js
 *
 * Pure validator over a preloaded in-memory dictionary.
 *
 * - `loadDictionary(jsonPath?)` loads `data/words_id.json` once into a Set;
 *   throws if the file is missing, not valid JSON, not an array, or contains
 *   fewer than 5000 distinct lowercase entries.
 * - `dictionarySize()` returns the loaded Set's size (throws if not loaded).
 * - `isValid(word, syllable)` returns one of:
 *     { ok: true }
 *     { ok: false, reason: 'EMPTY' }
 *     { ok: false, reason: 'NOT_IN_DICTIONARY' }
 *     { ok: false, reason: 'MISSING_SYLLABLE' }
 *
 * Pure: no I/O, no logging.
 */

const fs = require('fs');
const path = require('path');

const MIN_DICTIONARY_SIZE = 5000;

let dictionary = null;
let dictionaryPath = null;

function loadDictionary(jsonPath) {
  // Idempotent: if already loaded, return the existing Set.
  if (dictionary) return dictionary;

  const resolvedPath = path.isAbsolute(jsonPath || '')
    ? jsonPath
    : path.resolve(process.cwd(), jsonPath || 'data/words_id.json');

  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(
      `wordValidator.loadDictionary: failed to read "${resolvedPath}": ${err.message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `wordValidator.loadDictionary: invalid JSON at "${resolvedPath}": ${err.message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `wordValidator.loadDictionary: expected an array of strings at "${resolvedPath}".`,
    );
  }

  const set = new Set();
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const norm = entry.trim().toLowerCase();
    if (!norm) continue;
    set.add(norm);
  }

  if (set.size < MIN_DICTIONARY_SIZE) {
    throw new Error(
      `wordValidator.loadDictionary: dictionary at "${resolvedPath}" has ${set.size} `
        + `distinct entries; need >= ${MIN_DICTIONARY_SIZE}.`,
    );
  }

  dictionary = set;
  dictionaryPath = resolvedPath;
  return dictionary;
}

function dictionarySize() {
  if (!dictionary) {
    throw new Error('wordValidator.dictionarySize: dictionary not loaded.');
  }
  return dictionary.size;
}

function isValid(word, syllable) {
  const trimmed = String(word == null ? '' : word).trim();
  if (trimmed === '') {
    return { ok: false, reason: 'EMPTY' };
  }

  const normalized = trimmed.toLowerCase();
  const syl = String(syllable == null ? '' : syllable).toLowerCase();

  if (!dictionary) {
    // Defensive: if validator is called before dictionary load, fail closed.
    return { ok: false, reason: 'NOT_IN_DICTIONARY' };
  }

  if (!dictionary.has(normalized)) {
    return { ok: false, reason: 'NOT_IN_DICTIONARY' };
  }

  if (syl !== '' && !normalized.includes(syl)) {
    return { ok: false, reason: 'MISSING_SYLLABLE' };
  }

  return { ok: true };
}

// Test-only helper: replace the dictionary with a custom Set.
function _setDictionaryForTests(set) {
  dictionary = set;
  dictionaryPath = '<test>';
}

function _resetForTests() {
  dictionary = null;
  dictionaryPath = null;
}

module.exports = {
  loadDictionary,
  dictionarySize,
  isValid,
  _setDictionaryForTests,
  _resetForTests,
  get _dictionaryPath() {
    return dictionaryPath;
  },
};
