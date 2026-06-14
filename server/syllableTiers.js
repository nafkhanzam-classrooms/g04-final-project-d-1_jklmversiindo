'use strict';

/**
 * server/syllableTiers.js
 *
 * Tier table + selection helpers used by gameManager.
 *
 * Tier 1 (rounds 1-3):  10000 ms, 2-letter syllables
 * Tier 2 (rounds 4-6):   8000 ms, 3-letter syllables
 * Tier 3 (rounds 7+):    5000 ms, harder syllables
 */

const TIERS = [
  {
    roundFloor: 1,
    timerMs: 10000,
    syllables: ['AN', 'IN', 'KA', 'BA', 'TI', 'SA', 'RI', 'MA', 'LA', 'PA', 'NU', 'GA', 'TA', 'RU', 'PU'],
  },
  {
    roundFloor: 4,
    timerMs: 8000,
    syllables: ['PRO', 'KAN', 'ASI', 'PER', 'MEN', 'BER', 'TER', 'SIK', 'TAN', 'LAH', 'RAN', 'SUK', 'LIN', 'RAS'],
  },
  {
    roundFloor: 7,
    timerMs: 5000,
    syllables: ['NGKU', 'STR', 'TRI', 'SKR', 'NGGA', 'MBR', 'NDR', 'PSI', 'GLO', 'FLU'],
  },
];

function activeTier(round, tiers) {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`syllableTiers: round must be an integer >= 1 (got ${round})`);
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('syllableTiers: tiers must be a non-empty array');
  }
  // Walk high to low; pick the first whose floor <= round.
  let chosen = tiers[0];
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    if (tiers[i].roundFloor <= round) {
      chosen = tiers[i];
      break;
    }
  }
  return chosen;
}

function pickSyllable(round, tiers = TIERS, rng = Math.random) {
  const tier = activeTier(round, tiers);
  if (!Array.isArray(tier.syllables) || tier.syllables.length === 0) {
    throw new Error('syllableTiers: active tier has no syllables');
  }
  const r = typeof rng === 'function' ? rng() : Math.random();
  const idx = Math.min(tier.syllables.length - 1, Math.max(0, Math.floor(r * tier.syllables.length)));
  return tier.syllables[idx];
}

function timerForRound(round, tiers = TIERS) {
  return activeTier(round, tiers).timerMs;
}

module.exports = {
  TIERS,
  pickSyllable,
  timerForRound,
  activeTier,
};
