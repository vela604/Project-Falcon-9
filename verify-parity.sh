#!/usr/bin/env bash
# ============================================================================
# verify-parity.sh — confirm guidance-numerical.html produces byte-identical
# results to headless/runner.js under the same constants + environment.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

DURATION=1500
while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2; ;;
    *) echo "unknown arg: $1"; exit 1; ;;
  esac
done

GUIDE="leoInsertionV2"
STACK="stk_falcon9-b5"
VEHICLE="falcon9-b5-booster"
ENV_JSON='{"atmosphere":true,"slosh":true,"imu":false,"wind":{"enabled":false,"speed":0,"directionDeg":0}}'
FUEL_JSON='{"boosterPct":100,"stagePct":100}'

echo "=============================================================="
echo " PARITY VERIFY — guidance-numerical.html vs headless/runner.js"
echo "=============================================================="
echo " guide      : $GUIDE"
echo " stack      : $STACK"
echo " vehicle    : $VEHICLE"
echo " duration   : ${DURATION}s"
echo " env        : atmosphere=on slosh=on imu=off wind=off"
echo " fueling    : booster=100% stage=100%"
echo ""

TMP_JSON="$(mktemp -t parity.XXXXXX.json)"
TMP_ERR="$(mktemp -t parity.XXXXXX.err)"
trap 'rm -f "$TMP_JSON" "$TMP_ERR"' EXIT

echo "→ running headless (quiet mode, JSON only on stdout)…"
# --quiet is REQUIRED: without it, the guide's own console.log calls
# ("[leoInsertionV2] started", phase transitions, etc.) are written to
# stdout alongside the JSON and corrupt the parse.
# stderr is captured separately so a real crash is still visible.
if ! node headless/run.js \
      --guide    "$GUIDE" \
      --duration "$DURATION" \
      --stack    "$STACK" \
      --vehicle  "$VEHICLE" \
      --env      "$ENV_JSON" \
      --fueling  "$FUEL_JSON" \
      --quiet \
      --json > "$TMP_JSON" 2>"$TMP_ERR"; then
  echo "✗ headless run failed."
  echo "--- stderr ---"
  cat "$TMP_ERR"
  exit 1
fi

# Sanity: make sure stdout really is JSON (first non-whitespace char = '{')
first_char=$(tr -d ' \t\n\r' < "$TMP_JSON" | head -c 1)
if [[ "$first_char" != "{" ]]; then
  echo "✗ headless stdout is not JSON (got: '${first_char}')."
  echo "--- first 400 bytes of stdout ---"
  head -c 400 "$TMP_JSON"
  echo ""
  echo "--- stderr ---"
  cat "$TMP_ERR"
  exit 1
fi

echo "→ extracting metrics + computing parity hash…"
echo ""

node - "$TMP_JSON" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const file = process.argv[2];
const r = JSON.parse(fs.readFileSync(file, 'utf8'));

const st  = r.status;
const gs  = st.guideStatus || {};
const b   = st.bodies.find(x => x.isActive) || st.bodies[0];

const R  = 6371000;
const GM = 3.986004418e14;
const rr = Math.hypot(b.rx, b.ry) || 1;
const ux = b.rx / rr, uy = b.ry / rr;
const ex = b.ry / rr, ey = -b.rx / rr;
const vr = b.vx * ux + b.vy * uy;
const vt = b.vx * ex + b.vy * ey;
const E  = 0.5 * (vr * vr + vt * vt) - GM / rr;
let apo = Infinity, peri = Infinity;
if (E < 0) {
  const a  = -GM / (2 * E);
  const hh = rr * vt;
  const e  = Math.sqrt(Math.max(0, 1 + 2 * E * hh * hh / (GM * GM)));
  apo  = (a * (1 + e) - R) / 1000;
  peri = (a * (1 - e) - R) / 1000;
}

const f = (n, d) => Number.isFinite(n) ? n.toFixed(d) : '—';
const fuelLeft_t = (b.fuelMass / 1000);

console.log('--- HEADLESS RESULT ---');
console.log('simTime          : ' + st.simTime.toFixed(3));
console.log('guide phase      : ' + (gs.phase || '?'));
console.log('crashed          : ' + (st.crashed ? 'YES' : 'no'));
console.log('landed           : ' + (st.landed ? 'YES' : 'no'));
console.log('circ achieved    : ' + (gs.circAchieved ? 'YES' : 'no'));
console.log('final apogee     : ' + f(apo, 3) + ' km');
console.log('final perigee    : ' + f(peri, 3) + ' km');
console.log('coast Δv         : ' + f(gs.coastDeltaV, 3) + ' m/s');
console.log('coast t_rem      : ' + f(gs.coastTRem, 3) + ' s');
console.log('fuel left        : ' + fuelLeft_t.toFixed(3) + ' t');
console.log('peak Q           : ' + r.tracker.maxQKPa.toFixed(3) + ' kPa');
console.log('peak G           : ' + r.tracker.maxG.toFixed(4));
console.log('ticks run        : ' + r.ticksRun);
console.log('bodies           : ' + st.bodies.length);

const sig = [
  st.simTime.toFixed(3),
  gs.phase || '',
  st.crashed ? '1' : '0',
  st.landed ? '1' : '0',
  gs.circAchieved ? '1' : '0',
  f(apo, 3),
  f(peri, 3),
  f(gs.coastDeltaV, 3),
  f(gs.coastTRem, 3),
  fuelLeft_t.toFixed(3),
  r.tracker.maxQKPa.toFixed(3),
  r.tracker.maxG.toFixed(4),
].join('|');

const hash = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
console.log('');
console.log('--- PARITY HASH ---');
console.log(hash);
console.log('');
console.log('Signature fields (pipe-separated):');
console.log('  ' + sig);
NODE

echo ""
echo "=============================================================="
echo " NOW: open guidance-numerical.html"
echo "      1) leave guide = leoInsertionV2, duration = ${DURATION}"
echo "      2) wind off, booster=100, stage=100,"
echo "         atmosphere ✓  slosh ✓  imu ✗"
echo "      3) click Run"
echo "      4) copy summary values, compare to table above"
echo ""
echo " If simTime / phase / apogee / perigee / coast Δv /"
echo " coast t_rem / fuel left / peak Q / peak G all match,"
echo " the two pipelines are numerically equivalent."
echo "=============================================================="