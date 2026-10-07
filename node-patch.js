#!/usr/bin/env node
// ============================================================================
// patch.js — one-time patch for the CMA-ES hybrid tuning pipeline.
//
// Removes two obsolete guidance constants from leoInsertionV3's config:
//
//   1. STAGE_BURN_LOCK_TILT_DEG — replaced by STAGE_BURN_AOA_BIAS_DEG
//   2. MECO_APOGEE_KM           — replaced by fuel-based MECO trigger
//
// Also flips MECO_TRIGGER_ON_FUEL to true in the V3 preset.
//
// Affects two files only:
//   js/guideConfigDefaults.js
//   js/guideConstantDescriptions.js
//
// Legacy entries (V2, V1, ascentAoaHold) are intentionally untouched.
//
// Usage:   node patch.js
// Revert:  mv <file>.bak-before-cmaes-patch <file>
// ============================================================================

const fs = require('fs');
const path = require('path');

const BACKUP_SUFFIX = '.bak-before-cmaes-patch';

function apply(file, edits) {
  if (!fs.existsSync(file)) {
    console.error(`[FATAL] File not found: ${file}`);
    process.exit(1);
  }
  const bak = file + BACKUP_SUFFIX;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    console.log(`[BACKUP] ${file} → ${bak}`);
  } else {
    console.log(`[BACKUP] already exists: ${bak} (not overwriting)`);
  }

  let content = fs.readFileSync(file, 'utf8');

  for (const { desc, find, replace } of edits) {
    // Count matches (safe for both string and regex patterns).
    let count;
    if (find instanceof RegExp) {
      const flags = find.flags.includes('g') ? find.flags : find.flags + 'g';
      const g = new RegExp(find.source, flags);
      count = (content.match(g) || []).length;
    } else {
      count = content.split(find).length - 1;
    }

    if (count === 0) {
      console.error(`\n[MISS] ${file}`);
      console.error(`       ${desc}`);
      console.error('       Pattern not found — file may have been edited already.');
      process.exit(1);
    }
    if (count > 1) {
      console.error(`\n[AMBIGUOUS] ${file}`);
      console.error(`       ${desc}`);
      console.error(`       Found ${count} matches (expected 1). Aborting — no write.`);
      process.exit(1);
    }

    content = content.replace(find, replace);
    console.log(`  ✓ ${desc}`);
  }

  fs.writeFileSync(file, content);
  console.log(`[WRITE] ${file}\n`);
}

// ---------------------------------------------------------------------------
// 1) js/guideConfigDefaults.js
// ---------------------------------------------------------------------------

console.log('→ js/guideConfigDefaults.js');
apply('js/guideConfigDefaults.js', [
  {
    desc: 'V3 ascent: flip MECO_TRIGGER_ON_FUEL to true, delete MECO_APOGEE_KM',
    find: /MECO_TRIGGER_ON_FUEL: false,(\s*\n\s*MECO_TARGET_BOOSTER_FUEL_KG: 52612,)(\s*\n\s*MECO_APOGEE_KM: 150,)/,
    replace: 'MECO_TRIGGER_ON_FUEL: true,$1',
  },
  {
    desc: 'V3 insertion: delete STAGE_BURN_LOCK_TILT_DEG default',
    find: /(STAGE_BURN_CUTOFF_MARGIN_MPS: 0\.0,)(\s*\n\s*STAGE_BURN_LOCK_TILT_DEG: 90,)/,
    replace: '$1',
  },
  {
    desc: "V3 important-fields: delete 'insertion.STAGE_BURN_LOCK_TILT_DEG'",
    find: /\n\s*'insertion\.STAGE_BURN_LOCK_TILT_DEG',/,
    replace: '',
  },
  {
    desc: "V3 important-fields: delete 'ascent.MECO_APOGEE_KM'",
    find: /\n\s*'ascent\.MECO_APOGEE_KM',/,
    replace: '',
  },
]);

// ---------------------------------------------------------------------------
// 2) js/guideConstantDescriptions.js
// ---------------------------------------------------------------------------

console.log('→ js/guideConstantDescriptions.js');
apply('js/guideConstantDescriptions.js', [
  {
    desc: "Delete 'ascent.MECO_APOGEE_KM' description",
    find: /\n\s*'ascent\.MECO_APOGEE_KM':[^\n]*/,
    replace: '',
  },
  {
    desc: "Delete 'insertion.STAGE_BURN_LOCK_TILT_DEG' description",
    find: /\n\s*'insertion\.STAGE_BURN_LOCK_TILT_DEG':[^\n]*/,
    replace: '',
  },
]);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log('✓ Patch complete.\n');
console.log('Verify with:');
console.log("  grep -n 'STAGE_BURN_LOCK_TILT_DEG\\|MECO_APOGEE_KM' \\");
console.log('       js/guideConfigDefaults.js js/guideConstantDescriptions.js');
console.log('');
console.log('Expected: only V2/V1 legacy entries remain (lines ~79, 91, 125, 147,');
console.log('~227, ~228, ~341, ~345, ~375). No V3 hits.\n');
console.log('Sanity run:');
console.log('  node headless/run.js --guide leoInsertionV3 --duration 100\n');