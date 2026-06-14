'use strict';

/**
 * scripts/build_dictionary.js
 *
 * Generates `data/words_id.json` — a deterministic, alphabetically sorted
 * array of lowercase ASCII Indonesian word forms used by the WordFuse server.
 *
 * Source of truth: `data/kata-dasar.txt`, the KBBI-derived word list shipped
 * with the Sastrawi stemmer (~30k entries; CC-BY-licensed). We keep the file
 * checked in so the build is reproducible offline.
 *
 * Pipeline:
 *   1. Read Sastrawi's `kata-dasar.txt` and keep clean lowercase ASCII roots.
 *   2. Apply standard Indonesian affixation:
 *      - prefixes:     ber- me- meng- men- mem- meny- pe- peng- pen- pem- peny-
 *                      ter- di- se- ke-
 *      - suffixes:     -an -kan -i -nya -lah -kah -pun
 *      - confixes:     ke-an pe-an peng-an pen-an pem-an peny-an
 *                      me-kan men-kan mem-kan meng-kan meny-kan
 *                      me-i men-i mem-i meng-i meny-i
 *                      di-kan di-i
 *      - reduplication: <root>-<root>  (kept WITHOUT hyphen for ASCII matching)
 *                       collapsed form (e.g. "anak-anak" stored as "anakanak")
 *   3. Add a small loanword supplement that targets tier-3 syllables which do
 *      not naturally appear from Indonesian affixation
 *      (STR, SKR, MBR, NDR, PSI, GLO, FLU).
 *   4. Dedupe, lowercase, ASCII-only, sort alphabetically.
 *   5. Validate: ≥5000 entries AND every tier syllable has ≥1 substring hit.
 */

const fs = require('fs');
const path = require('path');

const KATA_DASAR_PATH = path.resolve(__dirname, '..', 'data', 'kata-dasar.txt');
const OUTPUT_PATH = path.resolve(__dirname, '..', 'data', 'words_id.json');

// ---------------------------------------------------------------------------
// 1) Load roots from Sastrawi's kata-dasar.txt
// ---------------------------------------------------------------------------
function loadRoots() {
  if (!fs.existsSync(KATA_DASAR_PATH)) {
    console.error(`[build_dictionary] missing ${KATA_DASAR_PATH}`);
    console.error('[build_dictionary] download with:');
    console.error('  curl -L -o data/kata-dasar.txt https://raw.githubusercontent.com/sastrawi/sastrawi/master/data/kata-dasar.txt');
    process.exit(1);
  }
  const raw = fs.readFileSync(KATA_DASAR_PATH, 'utf8');
  const set = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const w = line.trim().toLowerCase();
    if (!w) continue;
    // Strip metadata tabs / counts if any (Sastrawi format is one token per line).
    const tok = w.split(/\s+/)[0];
    set.add(tok);
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// 2) Affix sets — chosen to cover the high-frequency Indonesian forms
//    (ber-, me-, di-, ter-, ke-an, -an, -kan, -i, -nya) without exploding
//    the cross-product into millions of low-quality variants.
// ---------------------------------------------------------------------------
const PREFIXES = ['ber', 'me', 'men', 'mem', 'meng', 'di', 'ter', 'se', 'pe', 'peng', 'ke'];

const SUFFIXES = ['an', 'kan', 'i', 'nya'];

const CONFIXES = [
  ['ke', 'an'],
  ['pe', 'an'],
  ['peng', 'an'],
  ['per', 'an'],
  ['me', 'kan'],
  ['men', 'kan'],
  ['mem', 'kan'],
  ['meng', 'kan'],
  ['di', 'kan'],
  ['di', 'i'],
  ['ber', 'an'],
];

// ---------------------------------------------------------------------------
// 3) Generation
// ---------------------------------------------------------------------------
function generateForms(roots) {
  const out = new Set();

  for (const raw of roots) {
    const root = String(raw).trim().toLowerCase();
    if (!root) continue;

    // Skip multi-token / hyphenated roots — we'll handle reduplication below.
    const isHyphen = root.includes('-');
    const baseRoot = isHyphen ? root.split('-')[0] : root;

    // Always include the base root (with the hyphen stripped if any).
    out.add(baseRoot);
    if (isHyphen) {
      // Reduplication from a hyphenated root: collapse to single token.
      out.add(root.replace(/-/g, ''));
    }

    // Suffixes.
    for (const suf of SUFFIXES) out.add(baseRoot + suf);

    // Prefixes.
    for (const pre of PREFIXES) out.add(pre + baseRoot);

    // Confixes (prefix + root + suffix).
    for (const [pre, suf] of CONFIXES) out.add(pre + baseRoot + suf);

    // Plain reduplication of any non-hyphenated root: e.g. "anak" -> "anakanak".
    if (!isHyphen && baseRoot.length >= 2) {
      out.add(baseRoot + baseRoot);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 4) Loanword supplement (targets tier-3 syllables that don't appear from affixation)
// ---------------------------------------------------------------------------
const loanwordSupplement = [
  // STR
  'struktur', 'struktural', 'instrumen', 'instruksi', 'instruktur',
  'distribusi', 'distributor', 'demonstrasi', 'demonstran',
  'ilustrasi', 'ilustrator', 'abstrak', 'registrasi',
  'restrukturisasi', 'infrastruktur', 'magister', 'frustrasi',
  'orkestra', 'pastri', 'restorasi', 'restoran', 'austria', 'australia',
  'industri', 'industrialisasi', 'sastra', 'sastrawan', 'astronot', 'astronomi',
  // SKR
  'manuskrip', 'transkripsi', 'deskripsi', 'inskripsi', 'preskripsi',
  'sanskrit', 'distrik',
  // MBR
  'membran', 'embrio', 'embriologi', 'sembrono', 'kambrium', 'lumbrikus',
  // NDR
  'cendrawasih', 'indra', 'indria', 'sindrom', 'silindris', 'silinder',
  'kalender', 'agenda', 'legenda', 'rendang',
  // PSI
  'psikologi', 'psikolog', 'psikis', 'psikiatri', 'psikiater',
  'psikoterapi', 'psikologis', 'psikometri',
  // GLO
  'global', 'globalisasi', 'glosarium', 'gloria', 'glomerulus', 'igloo',
  // FLU
  'flu', 'fluida', 'fluor', 'refluks', 'fluktuasi', 'influensa', 'influenza',
  'fluorida', 'fluoresensi',
  // Common loanwords commonly used in modern Indonesian
  'analisis', 'aplikasi', 'argumen', 'aspirasi', 'birokrasi',
  'diagnosa', 'diskusi', 'dokumen', 'donasi', 'edukasi', 'efektif',
  'energi', 'fakultas', 'farmasi', 'festival', 'filsafat', 'formal',
  'galeri', 'genetik', 'geologi', 'grafis', 'historis', 'hotel',
  'identitas', 'imigrasi', 'inisiatif', 'insiden', 'inspeksi', 'institut',
  'interaksi', 'invasi', 'isolasi', 'kategori', 'klinik', 'koleksi',
  'koloni', 'komedi', 'komentar', 'komite', 'komoditas', 'komunitas',
  'konser', 'koordinasi', 'kreatif', 'kriteria', 'kritik', 'kualitas',
  'kuantitas', 'literatur', 'logika', 'maksimal', 'media', 'medis',
  'memori', 'metode', 'militer', 'mineral', 'minimum', 'modal', 'modern',
  'monumen', 'museum', 'musik', 'nasional', 'negatif', 'norma', 'novel',
  'objek', 'observasi', 'obsesi', 'operasi', 'opini', 'orientasi',
  'parlemen', 'partai', 'partner', 'pasien', 'piramida', 'pilot', 'planet',
  'positif', 'praktik', 'presiden', 'prestasi', 'pribadi', 'prinsip',
  'prioritas', 'produk', 'produksi', 'profesi', 'profil', 'progresif',
  'promosi', 'proporsi', 'protein', 'protes', 'provinsi',
  'reaksi', 'realistis', 'redaksi', 'regional', 'relasi', 'reputasi',
  'resep', 'reservasi', 'revolusi', 'risiko', 'sains', 'sanksi', 'satelit',
  'sektor', 'seleksi', 'seminar', 'serial', 'simbol', 'simfoni', 'sosial',
  'standar', 'stasiun', 'statistik', 'status', 'strategi', 'studi',
  'subsidi', 'survei', 'taktis', 'teknik', 'teknologi', 'teori',
  'tradisi', 'tragedi', 'transportasi', 'turis', 'turnamen', 'universitas',
  'variasi', 'vegetasi', 'verifikasi', 'versi', 'video', 'vitamin',
  'volume', 'wacana', 'wilayah', 'yayasan', 'zaman', 'zona',
];

// ---------------------------------------------------------------------------
// 5) Tier syllables — must match server/syllableTiers.js
// ---------------------------------------------------------------------------
const TIER_SYLLABLES = [
  // tier 1
  'AN', 'IN', 'KA', 'BA', 'TI', 'SA', 'RI', 'MA', 'LA', 'PA',
  'NU', 'GA', 'TA', 'RU', 'PU',
  // tier 2
  'PRO', 'KAN', 'ASI', 'PER', 'MEN', 'BER', 'TER', 'SIK',
  'TAN', 'LAH', 'RAN', 'SUK', 'LIN', 'RAS',
  // tier 3
  'NGKU', 'STR', 'TRI', 'SKR', 'NGGA', 'MBR', 'NDR', 'PSI', 'GLO', 'FLU',
];

// ---------------------------------------------------------------------------
// 6) Main
// ---------------------------------------------------------------------------
function main() {
  const roots = loadRoots();
  console.log(`[build_dictionary] roots loaded from kata-dasar.txt: ${roots.length}`);

  const generated = generateForms(roots);

  // Add the original roots themselves (in case the loop above stripped a hyphen).
  for (const r of roots) {
    const cleaned = r.replace(/-/g, '');
    if (cleaned) generated.add(cleaned);
    generated.add(r); // also keep the hyphenated literal so we can filter later
  }

  // Loanword supplement.
  for (const w of loanwordSupplement) {
    generated.add(String(w).trim().toLowerCase());
  }

  // Final filter: lowercase ASCII letters only (a-z), length >= 2.
  const final = [...generated]
    .filter((w) => typeof w === 'string' && /^[a-z]{2,}$/.test(w))
    .sort((a, b) => a.localeCompare(b, 'en'));

  // Tier-syllable hit counts.
  const hits = {};
  for (const syl of TIER_SYLLABLES) {
    const lc = syl.toLowerCase();
    hits[syl] = final.reduce((n, w) => n + (w.includes(lc) ? 1 : 0), 0);
  }

  console.log(`[build_dictionary] final word count: ${final.length}`);
  console.log('[build_dictionary] tier-syllable hits:');
  for (const syl of TIER_SYLLABLES) {
    console.log(`  ${syl.padEnd(5)} -> ${hits[syl]}`);
  }

  // Sanity-check a handful of common words.
  const probe = ['makan', 'memakan', 'makanan', 'dimakan', 'proporsi', 'produksi',
    'dengar', 'mendengar', 'didengar', 'jalan', 'berjalan', 'tidur', 'tertidur'];
  console.log('[build_dictionary] sanity:');
  for (const w of probe) {
    console.log(`  ${w.padEnd(12)} -> ${final.includes(w) ? 'OK' : 'MISSING'}`);
  }

  if (final.length < 5000) {
    console.error(`[build_dictionary] ERROR: dictionary has ${final.length} entries; need >= 5000.`);
    process.exit(1);
  }
  const missing = TIER_SYLLABLES.filter((s) => hits[s] === 0);
  if (missing.length > 0) {
    console.error(`[build_dictionary] ERROR: tier syllables with zero hits: ${missing.join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(final), { encoding: 'utf8' });
  console.log(`[build_dictionary] wrote ${final.length} entries to ${OUTPUT_PATH}`);
}

main();
