#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# find_env_refs.sh
#
# Finds every place in the project that touches the atmosphere, air density,
# pressure, speed of sound, drag coefficient or the "env" data handed to the
# guidance worker. Run it from anywhere:
#
#     bash find_env_refs.sh /path/to/project
#
# (no argument = current folder). It writes env_refs.txt in the folder you
# ran it from, and prints a per-file summary at the end. Upload env_refs.txt
# and every place that needs a patch can be found from it.
#
# Needs only bash and grep (Linux, macOS, or Git Bash / WSL on Windows).
# ---------------------------------------------------------------------------

ROOT="${1:-.}"
OUT="env_refs.txt"
: > "$OUT"

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
          --exclude-dir=build --exclude-dir=.next --exclude-dir=coverage
          --exclude=env_refs.txt --exclude=*.min.js --exclude=*.map
          --exclude=package-lock.json)
CODE=(--include=*.js --include=*.mjs --include=*.cjs --include=*.ts
      --include=*.jsx --include=*.tsx --include=*.html --include=*.htm)
DOCS=(--include=*.md --include=*.txt)

# group <title> <why it matters> <regex> [docs]
group () {
  local title="$1" why="$2" regex="$3" kind="${4:-code}"
  local -a inc
  if [ "$kind" = "docs" ]; then inc=("${DOCS[@]}"); else inc=("${CODE[@]}"); fi
  {
    echo
    echo "=================================================================="
    echo "## $title"
    echo "## $why"
    echo "=================================================================="
  } >> "$OUT"
  grep -rnE "${EXCLUDES[@]}" "${inc[@]}" -e "$regex" "$ROOT" 2>/dev/null \
    | cut -c1-230 >> "$OUT"
}

group "1. ATMOSPHERE FUNCTIONS" \
  "Callers of the atmosphere API. Any file that calls these needs environment.js loaded in the same context (main thread / physics worker / guidance worker)." \
  'airDensity|airPressure|airTemperature|speedOfSound|atmosphereEnabled|setAtmosphere'

group "2. OLD EXPONENTIAL-MODEL CONSTANTS" \
  "These belonged to the old rho0*exp(-h/H) model. Anything still reading them is using the OLD atmosphere and must switch to airDensity()/airPressure()." \
  'SCALE_HEIGHT|SEA_LEVEL_DENSITY|SEA_LEVEL_PRESSURE|[sS]caleHeight|seaLevelDensity|seaLevelPressure'

group "3. HAND-WRITTEN EXPONENTIAL ATMOSPHERE" \
  "Copies of the old formula written inline (rendering, telemetry, predictors, guidance)." \
  'Math\.exp\(\s*-\s*[A-Za-z_.()]*([aA]lt|[hH]eight|\bh\b)|exp\(-[^;]*(/|\*)\s*(8500|8\.5e3|H\b)'

group "4. MAGIC NUMBERS FROM STANDARD ATMOSPHERES" \
  "Hard-coded sea-level values, ISA temperatures and sound speed. Each one is a private atmosphere that will disagree with the new model." \
  '\b1\.225\b|\b101325\b|\b101\.325\b|\b8500\b|8\.5e3|\b0\.0065\b|\b288\.15\b|\b216\.65\b|\b340\.29\b|\b343\b|1\.4 *\* *287|\b287\.05'

group "5. DRAG COEFFICIENT AND DRAG FORCE" \
  "Every drag calculation. All of them must use hullDragCoefficient() (physics side) or _hullCd() (guidance worker) instead of a constant Cd." \
  'DRAG_CD|dragCd|DRAG_CD_FREE|hullDragCoefficient|hullCdMachFactor|_hullCd|computeDragAero|bodyAeroProfile|effectiveArea|dragMag|[cC]dHull'

group "6. ENV DATA HANDED TO THE GUIDANCE WORKER" \
  "The guidance worker cannot load environment.js; it gets an env object. Find where that object is BUILT so the new keys (DRAG_CD_FREE_MOLECULAR, DRAG_FM_ALT_START_M, DRAG_FM_ALT_FULL_M) can be added." \
  'setStackData|getEnv\b|stackData[^;]*env|\benv *: *\{|\benv *= *\{|bootData|EARTH_RADIUS *:|GM_EARTH *:'

group "7. WHICH CONTEXTS LOAD environment.js / config.js / guidance files" \
  "Shows every <script> and importScripts. A context that uses airDensity() but never loads environment.js (or loads an old copy) will break or disagree." \
  'importScripts|<script[^>]*src|new Worker\(|environment\.js|derivation\.js|guidance\.worker'

group "8. DYNAMIC PRESSURE, MACH AND MAX-Q" \
  "Anything computing q = 0.5*rho*v^2, Mach or max-Q. The numbers change with the new atmosphere and the transonic Cd." \
  '0\.5 *\* *rho|dynamicPressure|[mM]ax-?Q|maxQ|[mM]ach|\bq *= *0\.5'

group "9. PRESSURE-DEPENDENT ENGINE PERFORMANCE" \
  "Nozzle exhaust velocity depends on ambient pressure. Thrust and Isp shift slightly because pressure now follows US76 (lower than before at 11-30 km)." \
  'atmosphericPenalty|veVacuum|_updateEngineVe|airPressure|\bPa\b *='

group "10. RENDERING / UI / TELEMETRY OF THE ATMOSPHERE" \
  "Sky colour, atmosphere fade, density readouts, toggles. These should read the same atmosphere (or be updated if they use their own)." \
  '[aA]tmosph|[sS]ky|[aA]ir *[dD]ensity|rho\b|dens(ity)?[A-Z_a-z]*\(|atmosphereCheck|atmoToggle'

group "11. DOCUMENTS THAT DESCRIBE THE OLD MODEL" \
  "Markdown/text that still says exponential atmosphere, scale height 8500 m or constant Cd." \
  '[eE]xponential atmosphere|[sS]cale height|8 ?500 ?m|constant (hull )?Cd|ρ₀|rho0' docs

# ---------------------------------------------------------------- summary
{
  echo
  echo "=================================================================="
  echo "## SUMMARY: matching lines per file (all groups combined)"
  echo "=================================================================="
} >> "$OUT"
grep -E '^[^=#[:space:]].*:[0-9]+:' "$OUT" \
  | sed -E 's/:[0-9]+:.*//' | sort | uniq -c | sort -rn >> "$OUT"

echo "Done. Wrote $OUT ($(wc -l < "$OUT") lines)."
echo
echo "Files with the most matches:"
grep -E '^[^=#[:space:]].*:[0-9]+:' "$OUT" | sed -E 's/:[0-9]+:.*//' \
  | sort | uniq -c | sort -rn | head -25
