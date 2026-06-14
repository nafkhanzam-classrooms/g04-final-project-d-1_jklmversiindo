'use strict';

/**
 * test/wordValidator.pbt.test.js
 *
 * Property-based tests for server/wordValidator.js.
 *
 * Property 1 — Validates: Requirements 4.1, 4.2, 4.3, 4.5, 9.1
 *   isValid(word, syl) returns { ok: true } iff D.has(trim+lower(word))
 *   AND trim+lower(word).includes(lower(syl)).
 *
 * Property 2 — Validates: Requirements 4.4
 *   Validator is case- and whitespace-insensitive: for any word and syllable,
 *   isValid(word, s).ok === isValid("  " + UPPER(word) + "  ", s).ok.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const validator = require('../server/wordValidator');

// fast-check arbitrary that produces lowercase ASCII non-empty strings.
const lowerLetterStr = fc.stringMatching(/^[a-z]{1,12}$/);

function withDictionary(words, fn) {
  const set = new Set(words.map((w) => w.toLowerCase()));
  validator._setDictionaryForTests(set);
  try { return fn(set); } finally { validator._resetForTests(); }
}

test('Property 1: isValid accepts iff dictionary contains lowercase trimmed word AND it contains the syllable', () => {
  fc.assert(
    fc.property(
      fc.array(lowerLetterStr, { minLength: 1, maxLength: 30 }),
      lowerLetterStr,                       // candidate word
      fc.string({ minLength: 1, maxLength: 5 }), // syllable (any string)
      (dictWords, candidate, syllableRaw) => {
        const syllable = String(syllableRaw).replace(/[^a-zA-Z]/g, '').toLowerCase() || 'a';
        return withDictionary(dictWords, (dict) => {
          const trimmed = candidate.trim().toLowerCase();
          const expectedOk = dict.has(trimmed) && trimmed.includes(syllable);
          const got = validator.isValid(candidate, syllable);
          if (expectedOk) {
            assert.equal(got.ok, true);
          } else {
            assert.equal(got.ok, false);
            assert.ok(['EMPTY', 'NOT_IN_DICTIONARY', 'MISSING_SYLLABLE'].includes(got.reason));
          }
          return true;
        });
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 2: validator is case- and whitespace-insensitive', () => {
  fc.assert(
    fc.property(
      fc.array(lowerLetterStr, { minLength: 1, maxLength: 30 }),
      lowerLetterStr,
      lowerLetterStr,
      (dictWords, candidate, syllable) => {
        return withDictionary(dictWords, () => {
          const a = validator.isValid(candidate, syllable);
          const b = validator.isValid('  ' + candidate.toUpperCase() + '  ', syllable);
          assert.equal(a.ok, b.ok);
          return true;
        });
      },
    ),
    { numRuns: 200 },
  );
});

test('isValid returns EMPTY for whitespace-only input', () => {
  withDictionary(['ada', 'apa'], () => {
    const r1 = validator.isValid('', 'a');
    const r2 = validator.isValid('   ', 'a');
    assert.deepEqual(r1, { ok: false, reason: 'EMPTY' });
    assert.deepEqual(r2, { ok: false, reason: 'EMPTY' });
  });
});
