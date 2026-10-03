#!/usr/bin/env node
// ============================================================================
// scripts/apply-guidance-blocks-loadorder.js
//
// Stage 1 helper. Adds `guidance-blocks.js` to the load order of every
// context that loads `guidance.js`, immediately BEFORE it (so the block
// registry is defined before guidance.js reads it).
//
// Idempotent: safe to re-run; each file is skipped if it already contains
// a reference to guidance-blocks.js.
//
// Run from project root:
//     node scripts/apply-guidance-blocks-loadorder.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function insertLineBefore(src, anchorSubstr, newLineText) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf(anchorSubstr) !== -1) {
      const indent = (lines[i].match(/^(\s*)/) || ['', ''])[1];
      lines.splice(i, 0, indent + newLineText);
      return lines.join('\n');
    }
  }
  return null;
}

const edits = [
  {
    file: 'js/simJs/threads/guidance.worker.js',
    anchor: "'../guidance/guidance.js'",
    newLine: "'../guidance/guidance-blocks.js',",
  },
  {
    file: 'js/simJs/threads/fastforward.worker.js',
    anchor: "'../guidance/guidance.js'",
    newLine: "'../guidance/guidance-blocks.js',",
  },
  {
    file: 'headless/runner.js',
    anchor: "'js/simJs/guidance/guidance.js',",
    newLine: "'js/simJs/guidance/guidance-blocks.js',",
  },
  {
    file: 'guidance-numerical.html',
    anchor: 'src="js/simJs/guidance/guidance.js"',
    newLine: '<script src="js/simJs/guidance/guidance-blocks.js"></script>',
  },
  {
    file: 'guidance-tester.html',
    anchor: 'src="js/simJs/guidance/guidance.js"',
    newLine: '<script src="js/simJs/guidance/guidance-blocks.js"></script>',
  },
  {
    file: 'simulation.html',
    anchor: 'src="js/simJs/guidance/guidance.js"',
    newLine: '<script src="js/simJs/guidance/guidance-blocks.js"></script>',
  },
];

let okCount = 0, skipCount = 0, failCount = 0;

for (const edit of edits) {
  const full = path.join(ROOT, edit.file);
  if (!fs.existsSync(full)) {
    console.log('  MISS  ' + edit.file + '  (file not found)');
    failCount++;
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');

  if (src.indexOf('guidance-blocks.js') !== -1) {
    console.log('  SKIP  ' + edit.file + '  (already patched)');
    skipCount++;
    continue;
  }

  const patched = insertLineBefore(src, edit.anchor, edit.newLine);
  if (patched === null) {
    console.log('  FAIL  ' + edit.file + '  (anchor not found: ' + edit.anchor + ')');
    failCount++;
    continue;
  }

  fs.writeFileSync(full, patched);
  console.log('  OK    ' + edit.file);
  okCount++;
}

console.log('');
console.log('Done. ok=' + okCount + ' skip=' + skipCount + ' fail=' + failCount);
process.exit(failCount > 0 ? 1 : 0);