// lighting-patch.js — run from repo root:  node lighting-patch.js
// Idempotent. Each edit asserts its match count, so a mismatch aborts loudly.
const fs = require('fs'), path = require('path');
const FLAT = !!process.env.FLAT;               // test mode: all files in cwd
const P = f => (FLAT ? path.basename(f) : f);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const R = s => new RegExp(esc(s).replace(/\s+/g, '\\s+'), 'g');
let bad = 0;

function edit(file, list) {
  const p = P(file);
  let s = fs.readFileSync(p, 'utf8');
  for (const e of list) {
    if (e.marker && s.includes(e.marker)) { console.log('skip  ', p, '-', e.name); continue; }
    const re = e.find instanceof RegExp ? e.find : R(e.find);
    const n = (s.match(re) || []).length;
    if (n !== (e.count || 1)) { console.error('FAIL  ', p, '-', e.name, '(matches: ' + n + ')'); bad++; continue; }
    s = s.replace(re, () => e.repl);
    console.log('ok    ', p, '-', e.name);
  }
  fs.writeFileSync(p, s);
}
const L = (...a) => a.join('\n');

// ---------------------------------------------------------------- lighting.js
edit('js/simJs/view/lighting.js', [
  { name: 'atmosphere undefined in worker', marker: "=== 'undefined' || atmosphereEnabled",
    find: "(typeof atmosphereEnabled !== 'undefined' && atmosphereEnabled)",
    repl: "(typeof atmosphereEnabled === 'undefined' || atmosphereEnabled)" },
  { name: 'DOM guard (worker has no document)', marker: "typeof document !== 'undefined'",
    find: "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);\n  else initUI();",
    repl: L("if (typeof document !== 'undefined') {",
      "    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);",
      "    else initUI();", "  }") },
  { name: 'getState/setState (main -> worker sync)', marker: 'getState:',
    find: 'enabled: () => S.enabled, assist: () => S.assist,',
    repl: L('enabled: () => S.enabled, assist: () => S.assist,',
      '    getState: () => ({ enabled: S.enabled, assist: S.assist, hour0: S.hour0 }),',
      '    setState: o => { if (!o) return; if (Number.isFinite(o.hour0)) S.hour0 = o.hour0; S.enabled = !!o.enabled; S.assist = !!o.assist; },') },
]);

// ---------------------------------------------------------------- render.js
edit('js/simJs/view/render.js', [
  { name: 'drawSky -> day/night colours + backdrop', marker: 'SimLighting.skyColors',
    find: L('grad.addColorStop(0, `rgb(${c[0]*0.6},${c[1]*0.6},${c[2]*0.6})`);',
      'grad.addColorStop(1, `rgb(${c[0]},${c[1]},${c[2]})`);',
      'ctx.fillStyle = grad;', 'ctx.fillRect(0, 0, canvas.width, canvas.height);'),
    repl: L('let top = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], bot = [c[0], c[1], c[2]];',
      "  if (typeof SimLighting !== 'undefined' && SimLighting.enabled()) {",
      '    const sc = SimLighting.skyColors(c, densityFrac); top = sc.top; bot = sc.bot;',
      '  }',
      '  grad.addColorStop(0, `rgb(${top[0]},${top[1]},${top[2]})`);',
      '  grad.addColorStop(1, `rgb(${bot[0]},${bot[1]},${bot[2]})`);',
      '  ctx.fillStyle = grad;',
      '  ctx.fillRect(0, 0, canvas.width, canvas.height);',
      "  if (typeof SimLighting !== 'undefined') SimLighting.drawBackdrop(ctx, canvas, altitude);") },
  { name: 'shadeEarth between drawEarth and drawGrid (both branches)', marker: 'SimLighting.shadeEarth',
    find: 'drawEarth();\ndrawGrid();', count: 2,
    repl: "drawEarth();\n  if (typeof SimLighting !== 'undefined') SimLighting.shadeEarth(ctx, canvas);\n  drawGrid();" },
  { name: 'planet-view locator', marker: 'SimLighting.drawLocator',
    find: 'const speed = Math.hypot(body.vx, body.vy);',
    repl: "const speed = Math.hypot(body.vx, body.vy);\n  if (typeof SimLighting !== 'undefined') SimLighting.drawLocator(ctx, px, py, isActive, body);" },
  { name: 'per-body rocket light wrapper', marker: '_drawBodyRocketInner',
    find: 'function drawBodyRocket(body, isActive, bodyIdx) {',
    repl: L('function drawBodyRocket(body, isActive, bodyIdx) {',
      "  globalThis._ROCKET_LIGHT = (typeof SimLighting !== 'undefined' && camera.mode !== 'planet') ? SimLighting.rocketLight(body) : null;",
      '  try { _drawBodyRocketInner(body, isActive, bodyIdx); }',
      '  finally { globalThis._ROCKET_LIGHT = null; }',
      '}',
      '',
      'function _drawBodyRocketInner(body, isActive, bodyIdx) {') },
]);

// ---------------------------------------------------------------- rocketArt.js
edit('js/simJs/view/rocketArt.js', [
  { name: 'sun-aware body shading', marker: '_cylShadeGradientBase',
    find: 'function _cylShadeGradient(ctx, W) {',
    repl: L(
'// Sun-aware body shading. globalThis._ROCKET_LIGHT = {lx,ly,lit,amb,tint} is set by',
'// render.js per body; absent (previews, figure panel) -> the original neutral gradient.',
'// The cache key carries every light input (quantised), so bodies never share a stale one.',
'function _cylShadeGradient(ctx, W) {',
'  const RL = globalThis._ROCKET_LIGHT;',
'  if (!RL) return _cylShadeGradientBase(ctx, W);',
"  const sig = [Math.round(W), Math.round(RL.lx * 12), Math.round(RL.lit * 12), Math.round(RL.amb * 24), Math.round(RL.tint * 12)].join('|');",
"  return cachedGradient(ctx, 'cylLit', sig, () => {",
'    const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);',
'    const ll = Math.hypot(RL.lx, 0.5) || 1, lx = RL.lx / ll, lz = 0.5 / ll;',
'    const N = 16;',
'    for (let i = 0; i <= N; i++) {',
'      const u = i / N, x = u * 2 - 1, nz = Math.sqrt(Math.max(0, 1 - x * x));',
'      const d = Math.max(0, x * lx + nz * lz);',
'      const t = RL.amb + RL.lit * d * (1 - RL.amb);',
'      const dark = Math.min(0.85, (1 - Math.min(1, t)) * 0.62 + 0.20 * Math.pow(Math.abs(x), 4));',
'      const hl = RL.lit * Math.pow(d, 10) * 0.18 * ROCKET_FX.spec;',
'      const warm = RL.tint * RL.lit * d * 0.16;',
'      let col;',
"      if (hl > dark) col = 'rgba(255,' + Math.round(255 - 60 * RL.tint) + ',' + Math.round(255 - 150 * RL.tint) + ',' + hl.toFixed(3) + ')';",
"      else if (warm > dark && warm > 0.03) col = 'rgba(255,150,70,' + warm.toFixed(3) + ')';",
"      else col = 'rgba(0,0,0,' + dark.toFixed(3) + ')';",
'      g.addColorStop(u, col);',
'    }',
'    return g;',
'  });',
'}',
'',
'function _cylShadeGradientBase(ctx, W) {') },
  { name: 'ogive highlight follows sun side', marker: 'const _RL = globalThis',
    find: 'const s = ROCKET_FX.spec;\n  ctx.save();\n  silhouette();',
    repl: L('const _RL = globalThis._ROCKET_LIGHT;',
      '  const sl = _RL ? (_RL.lx >= 0 ? 1 : -1) : -1;                       // lit side',
      '  const s = ROCKET_FX.spec * (_RL ? _RL.lit * Math.min(1, 0.35 + Math.abs(_RL.lx)) : 1);',
      '  ctx.save();', '  silhouette();') },
  { name: 'specular side', marker: 'stroke(sl, 0.46',
    find: 'stroke(-1, 0.46,', count: 3, repl: 'stroke(sl, 0.46,' },
  { name: 'terminator 0.80', marker: 'stroke(-sl, 0.80',
    find: 'stroke(1, 0.80,', count: 2, repl: 'stroke(-sl, 0.80,' },
  { name: 'terminator 0.86', marker: 'stroke(-sl, 0.86',
    find: 'stroke(1, 0.86,', repl: 'stroke(-sl, 0.86,' },
  { name: 'bounce 0.97', marker: 'stroke(-sl, 0.97',
    find: 'stroke(1, 0.97,', repl: 'stroke(-sl, 0.97,' },
]);

// ---------------------------------------------------------------- render.worker.js
edit('js/simJs/threads/render.worker.js', [
  { name: 'importScripts lighting.js', marker: 'view/lighting.js',
    find: "'../view/predictedTrajectory.js',", repl: "'../view/predictedTrajectory.js',\n  '../view/lighting.js'," },
  { name: "'lighting' message", marker: "case 'lighting'",
    find: "case 'camera': {",
    repl: L("case 'lighting': {",
      "      if (typeof SimLighting !== 'undefined') SimLighting.setState(msg.state);",
      '      break;', '    }', "    case 'camera': {") },
]);

// ---------------------------------------------------------------- main.js
edit('js/simJs/main.js', [
  { name: 'push lighting state to render worker', marker: "type: 'lighting'",
    find: 'requestAnimationFrame(pushRenderContext);',
    repl: L("if (typeof SimLighting !== 'undefined') {",
      '        const _ls = SimLighting.getState(), _lk = JSON.stringify(_ls);',
      "        if (_lk !== globalThis.__lastLightKey) { globalThis.__lastLightKey = _lk; renderWorker.postMessage({ type: 'lighting', state: _ls }); }",
      '      }',
      '      requestAnimationFrame(pushRenderContext);') },
  { name: 'tick time-slider UI', marker: 'SimLighting.tickUI',
    find: 'updateStatusBar();\n  updateFuelAvailability();',
    repl: "updateStatusBar();\n  if (typeof SimLighting !== 'undefined') SimLighting.tickUI();\n  updateFuelAvailability();" },
]);

// ---------------------------------------------------------------- simulation.html
edit('simulation.html', [
  { name: 'time chip', marker: 'btnTimeEdit',
    find: '<span class="tb-clock" id="missionClock">T+00:00.0</span>',
    repl: L('<span class="tb-clock" id="missionClock">T+00:00.0</span>',
      '            <button class="btn" id="btnTimeEdit" title="Pad local time — click to change"><span id="padTimeIcon">☀</span><span id="padTimeLabel">--:--</span></button>') },
  { name: 'checkboxes', marker: 'toggleSunLight',
    find: '<label class="chip-toggle"><input type="checkbox" id="toggleImu"><span>IMU noise</span></label>',
    repl: L('<label class="chip-toggle"><input type="checkbox" id="toggleImu"><span>IMU noise</span></label>',
      '            <label class="chip-toggle"><input type="checkbox" id="toggleSunLight" checked><span>Sun light</span></label>',
      '            <label class="chip-toggle"><input type="checkbox" id="toggleNightAssist" checked><span>Night assist</span></label>') },
  { name: 'time panel', marker: 'id="timeBar"',
    find: '<canvas id="simCanvas"></canvas>',
    repl: L('<canvas id="simCanvas"></canvas>',
      '',
      '      <!-- Pad local-time panel (SimLighting) -->',
      '      <div id="timeBar">',
      '        <div class="tbar-head"><span class="tbar-title">☀ PAD LOCAL TIME</span><span id="timeBarValue">10:00</span><button class="tbar-close" id="timeBarClose">✕</button></div>',
      '        <input type="range" id="timeSlider" min="0" max="1439" step="1" value="600">',
      '        <div class="tbar-presets">',
      '          <button class="btn" data-hour="6">🌅 06:00</button><button class="btn" data-hour="12">☀ 12:00</button>',
      '          <button class="btn" data-hour="18">🌇 18:00</button><button class="btn" data-hour="21">🌙 21:00</button>',
      '        </div>',
      '        <div class="tbar-info"><span id="timeBarPhase">—</span><span id="timeBarLaunch">—</span></div>',
      '      </div>') },
  { name: 'load lighting.js', marker: 'view/lighting.js',
    find: '<script src="js/simJs/view/telemetry.js"></script>',
    repl: '<script src="js/simJs/view/telemetry.js"></script>\n<script src="js/simJs/view/lighting.js"></script>' },
]);

// ---------------------------------------------------------------- simulation.css (append)
{
  const p = P('styles/simulation.css');
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('#timeBar')) console.log('skip  ', p, '- css');
  else {
    s += L('', '/* ===== Pad local-time panel (SimLighting) ===== */',
'#timeBar{position:absolute;top:8px;left:50%;transform:translate(-50%,-150%);opacity:0;pointer-events:none;z-index:50;',
'  width:min(340px,calc(100vw - 24px));background:rgba(13,20,36,.94);backdrop-filter:blur(10px);',
'  border:1px solid var(--panel-border);border-radius:10px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.5);',
'  font-family:var(--font-mono);transition:transform .28s ease-out,opacity .28s;}',
'#timeBar.open{transform:translate(-50%,0);opacity:1;pointer-events:auto;}',
'#timeBar .tbar-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;}',
'#timeBar .tbar-title{color:var(--cyan);font-weight:700;font-size:11px;letter-spacing:.6px;flex:1;}',
'#timeBar #timeBarValue{color:var(--orange);font-weight:700;font-size:15px;}',
'#timeBar .tbar-close{background:var(--panel-2);border:1px solid var(--panel-border);color:var(--dim);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:11px;}',
'#timeBar .tbar-close:hover{color:var(--danger);border-color:var(--danger);}',
'#timeBar input[type=range]{width:100%;margin:4px 0 8px;}',
'#timeBar .tbar-presets{display:flex;gap:6px;}',
'#timeBar .tbar-presets .btn{flex:1;justify-content:center;padding:5px 4px;font-size:11px;}',
'#timeBar .tbar-info{display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:var(--dim);}', '');
    fs.writeFileSync(p, s); console.log('ok    ', p, '- css');
  }
}
if (bad) { console.error('\n' + bad + ' edit(s) failed — nothing silently skipped.'); process.exit(1); }
console.log('\nAll lighting edits applied.');
