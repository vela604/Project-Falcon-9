#!/usr/bin/env node
/**
 * patch-guidance-tester.js
 * Patches ./guidance-tester.html in-place.
 *
 * Fixes / changes:
 *   1. maxG: hook.js gLoad() parity (bodies[0], thrust+gimbal+drag, ÷ (dry+fuel)*g0)
 *   2. Visuals ON/OFF toggle — pure numerical mode when off
 *   3. Compare-run perf: fixed bounds + previous-run drawn once (cached)
 *   4. Plot decimation 10 Hz (was every tick)
 *   5. __tickDump off by default (window.__DEBUG_TICKDUMP = true to enable)
 *   6. captureState uses b._geomCache (no redundant geometryOf)
 *   7. addUserPreset passes stackType (presets stop being "legacy")
 *   8. .invalid CSS (was referenced but never defined)
 *   9. Progress bar, blueprint backdrop, tabular numerals
 *
 * Usage:   node patch-guidance-tester.js
 * Restore: mv guidance-tester.html.bak guidance-tester.html
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'guidance-tester.html');
const BAK  = FILE + '.bak';

if (!fs.existsSync(FILE)) {
  console.error('❌ Not found: ' + FILE);
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes('let visualsEnabled = true;') && src.includes('function gLoad(b, Re)')) {
  console.error('⚠  File already patched (visualsEnabled + gLoad present).');
  console.error('   Restore first: mv guidance-tester.html.bak guidance-tester.html');
  process.exit(1);
}
if (!fs.existsSync(BAK)) {
  fs.copyFileSync(FILE, BAK);
  console.log('📦 Backup: ' + path.basename(BAK));
}

let changes = 0;

function count(h, n) { let c=0,i=0; while ((i=h.indexOf(n,i))>=0){c++;i+=n.length;} return c; }
function fail(msg) {
  console.error('\n❌ PATCH FAILED: ' + msg);
  console.error('   No changes written. Backup: ' + path.basename(BAK));
  process.exit(1);
}
function once(label, needle, repl) {
  const n = count(src, needle);
  if (n === 0) fail(`[${label}] anchor NOT FOUND.\n   ${JSON.stringify(needle.slice(0,120))}`);
  if (n > 1)   fail(`[${label}] anchor NOT UNIQUE (${n}×).`);
  src = src.replace(needle, repl);
  changes++; console.log('  ✓ ' + label);
}
function all(label, needle, repl) {
  const n = count(src, needle);
  if (n === 0) fail(`[${label}] anchor NOT FOUND.`);
  src = src.split(needle).join(repl);
  changes++; console.log(`  ✓ ${label} (${n}×)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CSS additions — insert before </style>
// ═══════════════════════════════════════════════════════════════════════════
const CSS = `
/* ═══════════════════════════════════════════════════════════════════
   Patch — blueprint backdrop, visuals toggle, progress bar,
   tabular numerals, .invalid state
   ═══════════════════════════════════════════════════════════════════ */

body::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    linear-gradient(rgba(53,214,255,0.020) 1px, transparent 1px),
    linear-gradient(90deg, rgba(53,214,255,0.020) 1px, transparent 1px);
  background-size: 44px 44px;
}
#app { position: relative; z-index: 1; }

.toggle-switch {
  display: inline-flex; align-items: center; gap: 7px;
  cursor: pointer; user-select: none;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--dim);
  padding: 2px 6px; border-radius: 4px; border: 1px solid transparent;
}
.toggle-switch:hover { border-color: var(--border); }
.toggle-switch input { display: none; }
.toggle-switch .track {
  position: relative; width: 30px; height: 16px;
  background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 999px; flex-shrink: 0;
}
.toggle-switch .thumb {
  position: absolute; top: 1px; left: 1px; width: 12px; height: 12px;
  background: var(--dim); border-radius: 50%;
}
.toggle-switch input:checked + .track {
  background: rgba(53,214,255,0.15); border-color: var(--cyan);
}
.toggle-switch input:checked + .track .thumb {
  left: 15px; background: var(--cyan);
}
.toggle-switch input:checked ~ .lbl { color: var(--cyan); }

#status { display: flex; align-items: center; gap: 16px; }
#statusText { flex: 1; white-space: pre-wrap; }

.progress-bar {
  width: 180px; height: 4px; background: var(--panel-2);
  border-radius: 2px; overflow: hidden; display: none; flex-shrink: 0;
}
.progress-bar.show { display: block; }
.progress-fill {
  height: 100%; background: var(--cyan); width: 0%;
  transition: width 0.15s linear;
}

.field-row input.invalid {
  border-color: var(--danger);
  background: rgba(255,95,126,0.06);
}

.run-summary .v,
.capture .body,
.compare-row .a,
.compare-row .b,
.compare-grid { font-variant-numeric: tabular-nums; }
`;
once('CSS block',
  '</style>',
  CSS + '\n</style>');

// ═══════════════════════════════════════════════════════════════════════════
// 2. topBar — visuals toggle before stack label
// ═══════════════════════════════════════════════════════════════════════════
once('topBar toggle',
  `    <div class="spacer"></div>
    <span class="stack-label" id="stackLabel">—</span>`,
  `    <div class="spacer"></div>
    <label class="toggle-switch" title="Off = pure numerical run, no plotting. Maximum speed.">
      <input type="checkbox" id="visualsToggle" checked>
      <span class="track"><span class="thumb"></span></span>
      <span class="lbl">Visuals</span>
    </label>
    <span class="stack-label" id="stackLabel">—</span>`);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Status bar — split into text span + progress bar
// ═══════════════════════════════════════════════════════════════════════════
once('status split',
  '  <div id="status">Ready.</div>',
  `  <div id="status">
    <span id="statusText">Ready.</span>
    <div class="progress-bar" id="progressBar"><div class="progress-fill" id="progressFill"></div></div>
  </div>`);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Element refs + gLoad + visualsEnabled
// ═══════════════════════════════════════════════════════════════════════════
once('refs',
  `  const statusEl      = $('status');
  const presetSel     = $('presetSelect');`,
  `  const statusEl      = $('status');
  const statusTextEl  = $('statusText');
  const progressBarEl = $('progressBar');
  const progressFillEl= $('progressFill');
  const presetSel     = $('presetSelect');`);

once('gLoad + visualsEnabled',
  `  // ============================================================================
  // Guide selection + config state
  // ============================================================================
  let currentGuide = '';`,
  `  // ============================================================================
  // Visuals flag + G-load helper (hook.js parity)
  // ============================================================================
  let visualsEnabled = true;

  // Proper acceleration (G-load) — 1:1 port from hook.js gLoad().
  // Thrust (with gimbal) + drag vector sum ÷ (dryMass + fuelMass) * g0.
  // NOTE: b.dryMass is the STALE cached scalar after fairing split
  // (~+1905 kg high). Kept as-is for exact parity with hook.js / headless.
  function gLoad(b, Re) {
    const m = (b.dryMass || 0) + (b.fuelMass || 0);
    if (!(m > 0)) return 0;
    const engs = b.engines || [];
    let Fa = 0, Fl = 0;
    for (let i = 0; i < engs.length; i++) {
      const en = engs[i];
      const f = en.currentF || 0;
      if (!f) continue;
      const g = (en.gimbalDeg || 0) * Math.PI / 180;
      Fa += f * Math.cos(g);
      Fl += f * Math.sin(g);
    }
    const ux = -Math.sin(b.theta), uy = Math.cos(b.theta);
    let fx = Fa * ux + Fl * (-uy);
    let fy = Fa * uy + Fl * ux;
    if (typeof airDensity === 'function' && Number.isFinite(CONFIG.DRAG_CD) && b.width > 0) {
      const r = Math.sqrt(b.rx * b.rx + b.ry * b.ry), alt = r - Re;
      const rho = airDensity(Math.max(0, alt));
      if (rho > 0) {
        const sv = earthSurfaceVelocity(b.rx, b.ry);
        const wv = windInertialVector(b.rx, b.ry);
        const rvx = b.vx - (sv.vx + wv.wx), rvy = b.vy - (sv.vy + wv.wy);
        const sp = Math.sqrt(rvx * rvx + rvy * rvy);
        if (sp > 0) {
          const area = Math.PI * (b.width / 2) * (b.width / 2);
          const cd = (typeof hullDragCoefficient === 'function')
            ? hullDragCoefficient(sp, Math.max(0, alt)) : CONFIG.DRAG_CD;
          const D = 0.5 * rho * sp * sp * cd * area;
          fx -= D * rvx / sp;
          fy -= D * rvy / sp;
        }
      }
    }
    return Math.sqrt(fx * fx + fy * fy) / (m * 9.80665);
  }

  // ============================================================================
  // Guide selection + config state
  // ============================================================================
  let currentGuide = '';`);

// ═══════════════════════════════════════════════════════════════════════════
// 5. captureState — use _geomCache
// ═══════════════════════════════════════════════════════════════════════════
once('captureState geom',
  '    const geom = (typeof geometryOf === \'function\') ? geometryOf(b) : { M: 0 };',
  `    const geom = (b._geomCache && Number.isFinite(b._geomCache.M))
      ? b._geomCache
      : ((typeof geometryOf === 'function') ? geometryOf(b) : { M: 0 });`);

// ═══════════════════════════════════════════════════════════════════════════
// 6. peakG declarations — add phase/time/ascent trackers
// ═══════════════════════════════════════════════════════════════════════════
once('peakG decl',
  `    let peakQ_kPa = -Infinity, peakQ_state = null;
    let peakG = -Infinity, peakG_state = null;
    let prevVrSign = 0;`,
  `    let peakQ_kPa = -Infinity, peakQ_state = null;
    let peakG = -Infinity, peakG_state = null;
    let peakG_phase = null, peakG_t = NaN, peakGAscent = 0;
    let prevVrSign = 0;`);

// ═══════════════════════════════════════════════════════════════════════════
// 7. peakG loop — replace _lastAccel with gLoad(bodies[0]) (hook.js parity)
// ═══════════════════════════════════════════════════════════════════════════
once('peakG loop',
  `        for (let _bi = 0; _bi < state.bodies.length; _bi++) {
          const _b = state.bodies[_bi];
          const ax = _b._lastAccelX || 0;
          const ay = _b._lastAccelY || 0;
          const g_proper = Math.hypot(ax, ay) / 9.80665;
          if (g_proper > peakG) {
            peakG = g_proper;
            peakG_state = captureState();
          }
        }`,
  `        // Proper G-load on bodies[0], 1:1 with hook.js gLoad().
        const b0 = state.bodies[0];
        if (b0) {
          const gL = gLoad(b0, CONFIG.EARTH_RADIUS);
          if (gL > peakG) {
            peakG = gL;
            peakG_phase = gs.phase || prevPhase || '—';
            peakG_t = state.simTime;
            peakG_state = captureState();
          }
          if ((gs.phase === 'ASCENT' || gs.phase === 'STAGE_BURN') && gL > peakGAscent) {
            peakGAscent = gL;
          }
        }`);

// ═══════════════════════════════════════════════════════════════════════════
// 8. tickDump + plot push — gate behind visuals / debug flag
// ═══════════════════════════════════════════════════════════════════════════
once('tickDump + plot gate',
  `      // TEMP DUMP — per-tick state JSON (schema matches numerical)
      window.__tickDump.push({
        i: i,
        t: state.simTime,
        activeBodyIndex: state.activeBodyIndex,
        bodies: state.bodies.map(b => ({
          rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy,
          theta: b.theta, omega: b.omega,
          fuelMass: b.fuelMass,
          memberFuel: (b.memberFuel || []).slice(),
          engines: (b.engines || []).map(e => ({
            massFlowRate: e.massFlowRate,
            gimbalDeg: e.gimbalDeg,
            currentF: e.currentF,
          })),
        })),
      });

      // Plot push — pure reads only (no geometryOf, no state mutations).
      pushPlotSample();`,
  `      // Debug-only — off by default. Set window.__DEBUG_TICKDUMP = true from console.
      if (window.__DEBUG_TICKDUMP === true) {
        window.__tickDump.push({
          i: i,
          t: state.simTime,
          activeBodyIndex: state.activeBodyIndex,
          bodies: state.bodies.map(b => ({
            rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy,
            theta: b.theta, omega: b.omega,
            fuelMass: b.fuelMass,
            memberFuel: (b.memberFuel || []).slice(),
            engines: (b.engines || []).map(e => ({
              massFlowRate: e.massFlowRate,
              gimbalDeg: e.gimbalDeg,
              currentF: e.currentF,
            })),
          })),
        });
      }

      // Plot push — pure reads only. Skipped entirely when visuals off.
      if (visualsEnabled) pushPlotSample();`);

// ═══════════════════════════════════════════════════════════════════════════
// 9. Chunk yield — progress bar + gated renderAll
// ═══════════════════════════════════════════════════════════════════════════
once('chunk yield + progress',
  `      if (i > 0 && i % CHUNK === 0) {
        const wall = (performance.now() - t0) / 1000;
        const tps = ticksRun / wall;
        const pct = ((i / maxTicks) * 100).toFixed(1);
        statusEl.textContent =
          \`Running… t=\${state.simTime.toFixed(1)}s / \${durationS}s  \` +
          \`(\${pct}%, \${ticksRun} ticks, \${tps.toFixed(0)} ticks/s, \${captures.length} captures)\`;
        Plots.renderAll();
        await yieldToBrowser();
      }`,
  `      if (i > 0 && i % CHUNK === 0) {
        const wall = (performance.now() - t0) / 1000;
        const tps = ticksRun / wall;
        const pct = (i / maxTicks) * 100;
        statusTextEl.textContent =
          \`Running… t=\${state.simTime.toFixed(1)}s / \${durationS}s  \` +
          \`(\${pct.toFixed(1)}%, \${ticksRun} ticks, \${tps.toFixed(0)} ticks/s, \${captures.length} captures)\`;
        progressBarEl.classList.add('show');
        progressFillEl.style.width = pct.toFixed(1) + '%';
        if (visualsEnabled) Plots.renderAll();
        await yieldToBrowser();
      }`);

// ═══════════════════════════════════════════════════════════════════════════
// 10. Pre-loop renderAll — gate
// ═══════════════════════════════════════════════════════════════════════════
once('pre-loop renderAll',
  `    Plots.renderAll();

    for (let i = 0; i < maxTicks; i++) {`,
  `    if (visualsEnabled) Plots.renderAll();

    for (let i = 0; i < maxTicks; i++) {`);

// ═══════════════════════════════════════════════════════════════════════════
// 11. Post-loop renderAll + hide progress
// ═══════════════════════════════════════════════════════════════════════════
once('post-loop renderAll',
  `    Plots.renderAll();

    const finalEndState = captureState();`,
  `    if (visualsEnabled) Plots.renderAll();
    progressBarEl.classList.remove('show');
    progressFillEl.style.width = '0%';

    const finalEndState = captureState();`);

// ═══════════════════════════════════════════════════════════════════════════
// 12. Plots.reset — pass duration for fixed t-bounds
// ═══════════════════════════════════════════════════════════════════════════
once('Plots.reset duration',
  `    resetState(0);
    applyEnvironment();
    applyFueling();
    Plots.reset();`,
  `    resetState(0);
    applyEnvironment();
    applyFueling();
    Plots.reset(Math.max(1, parseFloat(durInput.value) || 600));`);

// ═══════════════════════════════════════════════════════════════════════════
// 13. Plots object — replace entire block with cached-bounds version
// ═══════════════════════════════════════════════════════════════════════════
const NEW_PLOTS = `  const Plots = {
  data: { polar: {}, vr: {}, vt: {}, alt: {}, speed: {}, mass: {}, q: {} },
  previousData: null,
  _prevRendered: false,
  _fixedBounds: null,
  _lastPushTime: {},
  _DECIMATE_DT: 0.10,   // 10 Hz plot sample rate

  _hasAnyData(d) {
    if (!d) return false;
    for (const k in d) if (d[k] && Object.keys(d[k]).length) return true;
    return false;
  },

  // Called at start of each run. Archives current -> previous, and locks
  // bounds ONCE so subsequent renderAll() calls skip O(n) recompute.
  reset(durationS) {
    if (this._hasAnyData(this.data)) {
      this.previousData = this.data;
      this._prevRendered = false;
      this._fixedBounds = this._computeFixedBounds(this.previousData, durationS);
    }
    this.data = { polar: {}, vr: {}, vt: {}, alt: {}, speed: {}, mass: {}, q: {} };
    this._lastPushTime = {};
  },

  clear() {
    this.data = { polar: {}, vr: {}, vt: {}, alt: {}, speed: {}, mass: {}, q: {} };
    this.previousData = null;
    this._prevRendered = false;
    this._fixedBounds = null;
    this._lastPushTime = {};
  },

  _computeFixedBounds(prev, durationS) {
    // Polar: prev-run bounds + 30% margin. If current run flies wildly
    // further, points may clip — cheap tradeoff for cached bounds.
    const polarB = _computePolarBounds([prev.polar]);
    if (polarB && polarB.hasAny) {
      const mX = (polarB.maxX - polarB.minX) * 0.30;
      const mY = (polarB.maxY - polarB.minY) * 0.30;
      polarB.minX -= mX; polarB.maxX += mX;
      polarB.minY -= mY; polarB.maxY += mY;
    }
    const out = { polar: polarB };
    for (const k of ['vr', 'vt', 'alt', 'speed', 'mass', 'q']) {
      let vMin = Infinity, vMax = -Infinity, tMax = 0;
      for (const bodyKey in prev[k]) {
        const arr = prev[k][bodyKey];
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (p.v < vMin) vMin = p.v;
          if (p.v > vMax) vMax = p.v;
          if (p.t > tMax) tMax = p.t;
        }
      }
      if (!isFinite(vMin)) { vMin = 0; vMax = 1; }
      if (vMin > 0) vMin = 0;
      if (vMax < 0) vMax = 0;
      const pad = (vMax - vMin) * 0.20 || 1;
      out[k] = {
        tMin: 0,
        tMax: Math.max(tMax, durationS || 0) * 1.02,
        vMin: vMin - pad,
        vMax: vMax + pad,
      };
    }
    return out;
  },

  _push(store, key, val) {
    if (!store[key]) store[key] = [];
    store[key].push(val);
  },

  push(bodyIdx, s) {
    const key = 'b' + bodyIdx;
    const last = this._lastPushTime[key];
    if (last != null && s.t - last < this._DECIMATE_DT) return;
    this._lastPushTime[key] = s.t;
    this._push(this.data.polar, key, { rx: s.rx, ry: s.ry, t: s.t });
    this._push(this.data.vr,    key, { t: s.t, v: s.vr });
    this._push(this.data.vt,    key, { t: s.t, v: s.vt });
    this._push(this.data.alt,   key, { t: s.t, v: s.altKm });
    this._push(this.data.speed, key, { t: s.t, v: s.speed });
    this._push(this.data.mass,  key, { t: s.t, v: s.mass_t });
    this._push(this.data.q,     key, { t: s.t, v: s.q_kPa });
  },

  renderAll() {
    const hasPrev = this._hasAnyData(this.previousData);
    const fixed = this._fixedBounds;

    // Previous run drawn ONCE, then cached as canvas pixels.
    if (hasPrev && !this._prevRendered) {
      drawPolarPlot(this.previousData.polar, { faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.polar });
      drawTimeSeries('vrCanvas',    this.previousData.vr,    { forceZero: true, faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.vr });
      drawTimeSeries('vtCanvas',    this.previousData.vt,    { forceZero: true, faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.vt });
      drawTimeSeries('altCanvas',   this.previousData.alt,   { forceZero: true, faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.alt });
      drawTimeSeries('speedCanvas', this.previousData.speed, { forceZero: true, faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.speed });
      drawTimeSeries('massCanvas',  this.previousData.mass,  { forceZero: true, faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.mass });
      drawTimeSeries('qCanvas',     this.previousData.q,     { forceZero: true, faded: true, suppressEmptyMessage: true, bounds: fixed && fixed.q });
      this._prevRendered = true;
    }

    const skip = hasPrev && this._prevRendered;
    drawPolarPlot(this.data.polar, { skipClear: skip, skipBackground: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.polar });
    drawTimeSeries('vrCanvas',    this.data.vr,    { forceZero: true, skipClear: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.vr });
    drawTimeSeries('vtCanvas',    this.data.vt,    { forceZero: true, skipClear: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.vt });
    drawTimeSeries('altCanvas',   this.data.alt,   { forceZero: true, skipClear: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.alt });
    drawTimeSeries('speedCanvas', this.data.speed, { forceZero: true, skipClear: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.speed });
    drawTimeSeries('massCanvas',  this.data.mass,  { forceZero: true, skipClear: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.mass });
    drawTimeSeries('qCanvas',     this.data.q,     { forceZero: true, skipClear: skip, suppressEmptyMessage: skip, bounds: fixed && fixed.q });
  },
};`;

const pStart = src.indexOf('  const Plots = {');
if (pStart < 0) fail('[Plots] start not found.');
if (src.indexOf('  const Plots = {', pStart + 1) >= 0) fail('[Plots] start not unique.');
const pComment = src.indexOf('  // Pure-read plot sampler. Called once per tick', pStart);
if (pComment < 0) fail('[Plots] end comment not found.');
const pEnd = src.lastIndexOf('};', pComment);
if (pEnd < 0) fail('[Plots] closing }; not found.');
src = src.slice(0, pStart) + NEW_PLOTS + src.slice(pEnd + 2);
changes++; console.log('  ✓ Plots object replaced');

// ═══════════════════════════════════════════════════════════════════════════
// 14. drawTimeSeries — accept fixed bounds
// ═══════════════════════════════════════════════════════════════════════════
once('drawTimeSeries bounds',
  `    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const key in seriesMap) {
      const arr = seriesMap[key];
      if (!arr || !arr.length) continue;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
        if (p.v < vMin) vMin = p.v;
        if (p.v > vMax) vMax = p.v;
      }
    }
    if (!isFinite(tMin)) { tMin = 0; tMax = 1; vMin = 0; vMax = 1; }`,
  `    let tMin, tMax, vMin, vMax;
    if (opts.bounds) {
      tMin = opts.bounds.tMin; tMax = opts.bounds.tMax;
      vMin = opts.bounds.vMin; vMax = opts.bounds.vMax;
    } else {
      tMin = Infinity; tMax = -Infinity; vMin = Infinity; vMax = -Infinity;
      for (const key in seriesMap) {
        const arr = seriesMap[key];
        if (!arr || !arr.length) continue;
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (p.t < tMin) tMin = p.t;
          if (p.t > tMax) tMax = p.t;
          if (p.v < vMin) vMin = p.v;
          if (p.v > vMax) vMax = p.v;
        }
      }
      if (!isFinite(tMin)) { tMin = 0; tMax = 1; vMin = 0; vMax = 1; }
    }`);

// ═══════════════════════════════════════════════════════════════════════════
// 15. Visuals toggle listener — append after clearPlots handler
// ═══════════════════════════════════════════════════════════════════════════
once('visuals toggle listener',
  `  clearPlotsBtn.addEventListener('click', () => {
  Plots.clear();
  Plots.renderAll();
  statusEl.textContent = 'Plots cleared (both current and previous).';
});`,
  `  clearPlotsBtn.addEventListener('click', () => {
  Plots.clear();
  Plots.renderAll();
  statusEl.textContent = 'Plots cleared (both current and previous).';
});

  // Visuals ON/OFF — off means pure numerical, no plotting (max speed).
  $('visualsToggle').addEventListener('change', (e) => {
    visualsEnabled = !!e.target.checked;
    if (!visualsEnabled) {
      Plots.clear();
      try { Plots.renderAll(); } catch (_) {}
      statusEl.textContent = 'Visuals OFF — pure numerical mode (no plotting).';
    } else {
      statusEl.textContent = 'Visuals ON — plotting enabled.';
    }
  });`);

// ═══════════════════════════════════════════════════════════════════════════
// 16. Resize handler — invalidate prev-run cache + gate
// ═══════════════════════════════════════════════════════════════════════════
once('resize handler',
  `  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => Plots.renderAll(), 120);
  });`,
  `  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (!visualsEnabled) return;
      // Canvas pixels are wiped on resize — must redraw previous run.
      Plots._prevRendered = false;
      Plots.renderAll();
    }, 120);
  });`);

// ═══════════════════════════════════════════════════════════════════════════
// 17. addUserPreset — pass stackType
// ═══════════════════════════════════════════════════════════════════════════
once('addUserPreset stackType',
  `      stackId: stack ? stack.id : '',
      stackName: stack ? stack.name : '',
      tags: [],`,
  `      stackId: stack ? stack.id : '',
      stackName: stack ? stack.name : '',
      stackType: stack ? stack.type : '',
      tags: [],`);

// ═══════════════════════════════════════════════════════════════════════════
// 18. Boot renderAll — gate
// ═══════════════════════════════════════════════════════════════════════════
once('boot renderAll',
  `    Plots.renderAll();

    try {
      const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;`,
  `    if (visualsEnabled) Plots.renderAll();

    try {
      const stk = (typeof getActiveStack === 'function') ? getActiveStack() : null;`);

// ═══════════════════════════════════════════════════════════════════════════
// 19. Global — statusEl.textContent -> statusTextEl.textContent
// ═══════════════════════════════════════════════════════════════════════════
all('statusEl -> statusTextEl',
  'statusEl.textContent',
  'statusTextEl.textContent');

// ═══════════════════════════════════════════════════════════════════════════
// Write
// ═══════════════════════════════════════════════════════════════════════════
fs.writeFileSync(FILE, src, 'utf8');
console.log(`\n✅ Done. ${changes} patches applied to ${path.basename(FILE)}.`);
console.log(`   Backup: ${path.basename(BAK)}`);
console.log(`\n   Restore: mv ${path.basename(BAK)} ${path.basename(FILE)}`);