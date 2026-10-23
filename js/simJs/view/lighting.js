// ============================================================================
// lighting.js — Sun, time-of-day and day/night for the flight view.
//
// MODEL (2-D, same frame as physics): the Sun is a parallel light source
// fixed in INERTIAL space at angle phiSun (sunDir = (sin phiSun, cos phiSun),
// same (sin, cos) convention as launchSiteWorldPosition()). Earth spins under
// it at EARTH_OMEGA, so "time of day" is just the hour angle of the launch
// pad:
//        padHour(t) = 12 + (phi_pad(t) - phiSun) * 12/PI        (24 h clock)
// The user edits the CURRENT pad local time; internally we store hour0 =
// pad local time at T+0, so Reset always returns to the same launch time.
// (Sun's own orbital motion — ~1°/day — is ignored; day length = sidereal day.)
//
// Everything here is read-only w.r.t. physics. Public API: window.SimLighting.
// Needs (all globals): CONFIG, state, camera, worldToScreen, cameraWorldPosition,
// metersPerPixel, airDensity, atmosphereEnabled.
// ============================================================================
const SimLighting = (function () {
  'use strict';
  const TAU = Math.PI * 2;
  const S = { enabled: true, assist: true, hour0: 10 };

  const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const mixRGB = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
  const wrap24 = h => ((h % 24) + 24) % 24;

  // ---- persistence (best effort) -----------------------------------------
  try {
    const raw = JSON.parse(localStorage.getItem('rocketSim.lighting') || 'null');
    if (raw) {
      if (Number.isFinite(raw.hour0)) S.hour0 = wrap24(raw.hour0);
      if (typeof raw.assist === 'boolean') S.assist = raw.assist;
      if (typeof raw.enabled === 'boolean') S.enabled = raw.enabled;
    }
  } catch (e) { /* storage unavailable */ }
  function save() {
    try { localStorage.setItem('rocketSim.lighting', JSON.stringify(S)); } catch (e) { /* ignore */ }
  }

  // ---- time + sun geometry -----------------------------------------------
  const simT = () => (typeof state !== 'undefined' && state && Number.isFinite(state.simTime)) ? state.simTime : 0;
  const phi0 = () => CONFIG.LAUNCH_SITE_ANGLE_0 || 0;
  const hoursPerRad = 12 / Math.PI;

  function padHour() { return wrap24(S.hour0 + CONFIG.EARTH_OMEGA * simT() * hoursPerRad); }
  function setPadHour(h) { S.hour0 = wrap24(h - CONFIG.EARTH_OMEGA * simT() * hoursPerRad); }
  function sunPhi() { return phi0() - (S.hour0 - 12) * Math.PI / 12; }
  function sunDir() { const p = sunPhi(); return { x: Math.sin(p), y: Math.cos(p) }; }

  // sin(elevation) of the Sun at an inertial position (x,y), local horizontal.
  function sinElev(x, y) {
    const r = Math.hypot(x, y) || 1, s = sunDir();
    return (x * s.x + y * s.y) / r;
  }
  const groundDay = se => smooth(-0.14, 0.10, se);            // 0 night .. 1 day
  const twilight = se => Math.max(0, 1 - Math.abs(se + 0.02) / 0.16);

  function padSinElev() {
    const p = launchSiteWorldPosition(simT());
    return sinElev(p.x, p.y);
  }
  function phaseName() {
    const se = padSinElev(), h = padHour();
    if (se > 0.10) return 'Day';
    if (se < -0.14) return 'Night';
    return h < 12 ? 'Dawn' : 'Dusk';
  }

  // ---- view helpers ------------------------------------------------------
  const isPlanet = () => camera && camera.mode === 'planet';
  function camSE() {
    const c = cameraWorldPosition();
    if (Math.hypot(c.x, c.y) < 1000) return padSinElev();
    return sinElev(c.x, c.y);
  }
  // Sun direction expressed in SCREEN space (unit vector, y down).
  function sunScreenDir() {
    const cam = cameraWorldPosition(), s = sunDir(), K = 1000;
    const a = worldToScreen(cam.x, cam.y), b = worldToScreen(cam.x + s.x * K, cam.y + s.y * K);
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }
  // Screen angle of inertial "up" (+y), used to spin the star field with the view.
  function inertialUpAngle() {
    const cam = cameraWorldPosition(), K = 1000;
    const a = worldToScreen(cam.x, cam.y), b = worldToScreen(cam.x, cam.y + K);
    return Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;   // 0 when inertial up = screen up
  }

  // ---- sky ---------------------------------------------------------------
  // c = legacy altitude-based sky colour. Returns gradient end colours.
  function skyColors(c, dens) {
    const se = camSE();
    const day = isPlanet() ? 0 : groundDay(se);
    const night = [3, 4, 10];
    let bot = mixRGB(night, c, day);
    let top = bot.map(v => v * 0.6);
    const tw = isPlanet() ? 0 : twilight(se) * dens;
    if (tw > 0.01) {
      bot = mixRGB(bot, [225, 105, 55], tw * 0.55);
      top = mixRGB(top, [58, 38, 92], tw * 0.40);
    }
    return { top, bot };
  }

  // Stars: fixed in inertial space, so they turn with the camera.
  let _stars = null;
  function _rng(seed) {   // mulberry32
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function _initStars() {
    const r = _rng(1337); _stars = [];
    for (let i = 0; i < 280; i++) {
      const a = r() * TAU, d = Math.sqrt(r());
      _stars.push({ u: Math.cos(a) * d, v: Math.sin(a) * d, m: 0.35 + r() * 0.65, p: r() * TAU, big: r() > 0.93 });
    }
  }
  function drawStars(ctx, cv, alpha) {
    if (!_stars) _initStars();
    const cx = cv.width / 2, cy = cv.height / 2, D = Math.hypot(cx, cy);
    const ang = inertialUpAngle(), ca = Math.cos(ang), sa = Math.sin(ang);
    const t = performance.now() * 0.0015;
    ctx.save();
    ctx.fillStyle = '#dfe9ff';
    for (const s of _stars) {
      const x = s.u * D, y = s.v * D;
      const px = cx + x * ca - y * sa, py = cy + x * sa + y * ca;
      if (px < -2 || py < -2 || px > cv.width + 2 || py > cv.height + 2) continue;
      ctx.globalAlpha = alpha * s.m * (0.78 + 0.22 * Math.sin(t + s.p));
      const z = s.big ? 2 : 1.2;
      ctx.fillRect(px, py, z, z);
    }
    ctx.restore();
  }

  function drawSun(ctx, cv, dens, se) {
    const dir = sunScreenDir();
    const cx = cv.width / 2, cy = cv.height / 2, m = 34;
    let d = Math.min((cx - m) / (Math.abs(dir[0]) || 1e-6), (cy - m) / (Math.abs(dir[1]) || 1e-6));
    if (isPlanet()) {
      const w = worldToScreen(0, 0);
      const earthR = CONFIG.EARTH_RADIUS / metersPerPixel();
      d = Math.max(d, earthR + 30);
    }
    const x = cx + dir[0] * d, y = cy + dir[1] * d;
    const warm = clamp01(1 - smooth(0.02, 0.35, se)) * clamp01(dens * 1.5);
    const core = mixRGB([255, 250, 230], [255, 165, 90], warm);
    const R = isPlanet() ? 13 : 17, glowR = R * (isPlanet() ? 5 : 7 + 3 * dens);
    ctx.save();
    const g = ctx.createRadialGradient(x, y, R * 0.3, x, y, glowR);
    g.addColorStop(0, `rgba(${core[0] | 0},${core[1] | 0},${core[2] | 0},0.55)`);
    g.addColorStop(0.35, `rgba(${core[0] | 0},${core[1] | 0},${core[2] | 0},0.16)`);
    g.addColorStop(1, `rgba(${core[0] | 0},${core[1] | 0},${core[2] | 0},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, glowR, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgb(${core[0] | 0},${core[1] | 0},${core[2] | 0})`;
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
    // Planet view: a few parallel rays so the lighting angle is obvious.
    if (isPlanet()) {
      const c0 = worldToScreen(0, 0), earthR = CONFIG.EARTH_RADIUS / metersPerPixel();
      const nx = -dir[1], ny = dir[0];
      ctx.strokeStyle = 'rgba(255,225,150,0.22)'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 7]);
      for (let k = -2; k <= 2; k++) {
        const off = k * earthR * 0.34;
        const ex = c0[0] + nx * off + dir[0] * (earthR * 1.05) * Math.sqrt(Math.max(0, 1 - (k * 0.34) ** 2));
        const ey = c0[1] + ny * off + dir[1] * (earthR * 1.05) * Math.sqrt(Math.max(0, 1 - (k * 0.34) ** 2));
        const sx = x + nx * off * 0.55, sy = y + ny * off * 0.55;
        ctx.beginPath(); ctx.moveTo(sx - dir[0] * R * 1.6, sy - dir[1] * R * 1.6); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Called right after drawSky().
  function drawBackdrop(ctx, cv, altitude) {
    if (!S.enabled) return;
    const dens = clamp01(airDensity(Math.max(0, altitude)) / CONFIG.SEA_LEVEL_DENSITY);
    const se = camSE();
    const day = isPlanet() ? 0 : groundDay(se);
    const starA = clamp01(1 - dens * day * 1.2);
    if (starA > 0.02) drawStars(ctx, cv, starA);
    drawSun(ctx, cv, dens, se);
  }

  // ---- Earth: day / night -------------------------------------------------
  let _cities = null;
  function _initCities() {
    const r = _rng(77); _cities = [];
    for (let c = 0; c < 16; c++) {
      const base = r() * TAU, n = 4 + (r() * 7 | 0);
      for (let i = 0; i < n; i++) _cities.push({ a: base + (r() - 0.5) * 0.09, k: 0.4 + r() * 0.6 });
    }
  }

  // Called after the ground layers (earth fill / grid / zones), before pad+rocket.
  function shadeEarth(ctx, cv) {
    if (!S.enabled) return;
    const mpp = metersPerPixel();
    const [cx, cy] = worldToScreen(0, 0);
    const R = CONFIG.EARTH_RADIUS / mpp;
    if (R < 0.5) return;
    const dir = sunScreenDir();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    if (R > 2e4) {
      // Zoomed in: the terminator is far outside the view, colour is uniform.
      const se = camSE(), day = groundDay(se), tw = twilight(se);
      ctx.fillStyle = `rgba(2,5,14,${(0.62 * (1 - day)).toFixed(3)})`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (tw > 0.01) { ctx.fillStyle = `rgba(255,120,50,${(0.10 * tw).toFixed(3)})`; ctx.fillRect(0, 0, cv.width, cv.height); }
    } else {
      // Whole-planet view: sun is in-plane, so the terminator is a straight line.
      // Gradient axis = sun axis; t = (sin(elevation)+1)/2.
      const g = ctx.createLinearGradient(cx - dir[0] * R, cy - dir[1] * R, cx + dir[0] * R, cy + dir[1] * R);
      g.addColorStop(0.00, 'rgba(2,5,14,0.80)');
      g.addColorStop(0.44, 'rgba(2,5,14,0.76)');
      g.addColorStop(0.48, 'rgba(55,22,38,0.50)');
      g.addColorStop(0.505, 'rgba(255,120,50,0.22)');
      g.addColorStop(0.55, 'rgba(120,200,130,0.10)');
      g.addColorStop(0.78, 'rgba(120,205,135,0.20)');
      g.addColorStop(1.00, 'rgba(140,220,150,0.30)');
      ctx.fillStyle = g; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      // City lights on the night side (Earth-fixed, so they spin with the planet).
      if (!_cities) _initCities();
      const w = CONFIG.EARTH_OMEGA * simT();
      ctx.globalCompositeOperation = 'lighter';
      for (const c of _cities) {
        const a = c.a + w;
        const se = Math.cos(a - sunPhi());
        const night = 1 - smooth(-0.10, 0.06, se);
        if (night < 0.05) continue;
        const [px, py] = worldToScreen(CONFIG.EARTH_RADIUS * 0.992 * Math.sin(a), CONFIG.EARTH_RADIUS * 0.992 * Math.cos(a));
        ctx.fillStyle = `rgba(255,205,110,${(0.85 * night * c.k).toFixed(3)})`;
        ctx.fillRect(px - 1, py - 1, 2.2, 2.2);
      }
    }
    ctx.restore();
    // Atmosphere rim on the sunlit limb (planet view only).
    if (R < 2e4 && typeof atmosphereEnabled !== 'undefined' && atmosphereEnabled) {
      const base = Math.atan2(dir[1], dir[0]);
      ctx.save(); ctx.lineCap = 'butt';
      const N = 40, span = Math.PI * 0.62;
      for (let i = 0; i < N; i++) {
        const a0 = base - span + (2 * span) * i / N, a1 = base - span + (2 * span) * (i + 1) / N;
        const f = Math.cos((((i + 0.5) / N) * 2 - 1) * Math.PI / 2);
        ctx.strokeStyle = `rgba(120,175,255,${(0.34 * f).toFixed(3)})`;
        ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(cx, cy, R + 2.5, a0, a1 + 0.01); ctx.stroke();
        ctx.strokeStyle = `rgba(150,200,255,${(0.14 * f).toFixed(3)})`;
        ctx.lineWidth = 11; ctx.beginPath(); ctx.arc(cx, cy, R + 6, a0, a1 + 0.01); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---- rocket light ------------------------------------------------------
  // Light direction in the ROCKET frame (lx: across, +right; ly: along nose),
  // sun intensity on the body, and ambient fill. Consumed by rocketArt.js
  // through the global ROCKET_LIGHT.
  const _L = { lx: -1, ly: 0, lit: 1, amb: 0.3, tint: 0 };
  function litFactor(body) {
    const s = sunDir(), R = CONFIG.EARTH_RADIUS;
    const along = body.rx * s.x + body.ry * s.y;
    if (along > 0) return 1;
    const perp = Math.abs(body.rx * s.y - body.ry * s.x);        // distance from Earth-centre to sun ray
    return smooth(R - 15000, R + 25000, perp);                   // soft edge = atmospheric refraction
  }
  function rocketLight(body) {
    if (!S.enabled || !body) return null;
    const s = sunDir(), th = body.theta || 0, R = CONFIG.EARTH_RADIUS;
    const r = Math.hypot(body.rx, body.ry) || 1;
    const se = (body.rx * s.x + body.ry * s.y) / r;
    const lit = litFactor(body);
    const dens = clamp01(airDensity(Math.max(0, r - R)) / CONFIG.SEA_LEVEL_DENSITY);
    const day = groundDay(se);
    let amb = 0.10 + 0.38 * dens * day;
    if (S.assist) amb += 0.26 * (1 - lit) * (1 - dens * day);
    _L.lx = s.x * Math.cos(th) + s.y * Math.sin(th);
    _L.ly = -s.x * Math.sin(th) + s.y * Math.cos(th);
    _L.lit = lit;
    _L.amb = Math.min(0.75, amb);
    _L.tint = (1 - smooth(0.02, 0.40, se)) * smooth(0.01, 0.25, dens);
    return _L;
  }

  // Planet-view marker aid: glow + pulsing ring, stronger on the night side.
  function drawLocator(ctx, px, py, isActive, body) {
    if (!S.enabled || !S.assist) return;
    const shadow = 1 - litFactor(body);
    const t = (performance.now() / 1000) % 1.6 / 1.6;
    const a = (isActive ? 0.30 : 0.18) + 0.55 * shadow;
    const col = isActive ? '53,214,255' : '255,146,72';
    ctx.save();
    const g = ctx.createRadialGradient(px, py, 2, px, py, 26);
    g.addColorStop(0, `rgba(${col},${(0.45 * a + 0.10).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, 26, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(${col},${((1 - t) * a).toFixed(3)})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py, 9 + t * 24, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // ---- UI ----------------------------------------------------------------
  const fmt = h => {
    const m = Math.floor(((h % 24) + 24) % 24 * 60 + 1e-6);
    return String((m / 60) | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };
  const ICON = { Day: '☀', Dawn: '🌅', Dusk: '🌇', Night: '🌙' };
  let _ui = null, _dragging = false, _lastUi = 0;

  function refreshUI(force) {
    if (!_ui) return;
    const now = performance.now();
    if (!force && now - _lastUi < 200) return;
    _lastUi = now;
    const h = padHour(), ph = phaseName(), se = padSinElev();
    const txt = fmt(h);
    if (_ui.chipTime) _ui.chipTime.textContent = txt;
    if (_ui.chipIcon) _ui.chipIcon.textContent = ICON[ph] || '☀';
    if (_ui.value) _ui.value.textContent = txt;
    if (_ui.phase) _ui.phase.textContent = `${ICON[ph]} ${ph} · sun ${(Math.asin(Math.max(-1, Math.min(1, se))) * 180 / Math.PI).toFixed(0)}°`;
    if (_ui.launch) _ui.launch.textContent = 'T+0 = ' + fmt(S.hour0);
    if (_ui.slider && !_dragging) _ui.slider.value = Math.round(h * 60) % 1440;
  }

  function initUI() {
    const $ = id => document.getElementById(id);
    _ui = {
      chip: $('btnTimeEdit'), chipTime: $('padTimeLabel'), chipIcon: $('padTimeIcon'),
      bar: $('timeBar'), slider: $('timeSlider'), value: $('timeBarValue'),
      phase: $('timeBarPhase'), launch: $('timeBarLaunch'),
    };
    if (!_ui.chip || !_ui.bar || !_ui.slider) { _ui = null; return; }
    const setOpen = open => {
      _ui.bar.classList.toggle('open', open);
      _ui.chip.classList.toggle('active', open);
      setTimeout(() => window.dispatchEvent(new Event('resize')), 0);   // viewport height changed
    };
    _ui.chip.addEventListener('click', () => setOpen(!_ui.bar.classList.contains('open')));
    const close = $('timeBarClose'); if (close) close.addEventListener('click', () => setOpen(false));
    _ui.slider.addEventListener('pointerdown', () => { _dragging = true; });
    ['pointerup', 'pointercancel', 'change', 'blur'].forEach(ev =>
      _ui.slider.addEventListener(ev, () => { _dragging = false; }));
    _ui.slider.addEventListener('input', () => { setPadHour(_ui.slider.value / 60); save(); refreshUI(true); });
    _ui.bar.querySelectorAll('[data-hour]').forEach(b =>
      b.addEventListener('click', () => { setPadHour(parseFloat(b.dataset.hour)); save(); refreshUI(true); }));
    const assist = $('toggleNightAssist');
    if (assist) { assist.checked = S.assist; assist.addEventListener('change', e => { S.assist = e.target.checked; save(); }); }
    const en = $('toggleSunLight');
    if (en) { en.checked = S.enabled; en.addEventListener('change', e => { S.enabled = e.target.checked; save(); }); }
    refreshUI(true);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
    else initUI();
  }

  return {
    enabled: () => S.enabled, assist: () => S.assist,
    getState: () => ({ enabled: S.enabled, assist: S.assist, hour0: S.hour0 }),
    setState: o => { if (!o) return; if (Number.isFinite(o.hour0)) S.hour0 = o.hour0; S.enabled = !!o.enabled; S.assist = !!o.assist; },
    padHour, setPadHour, sunDir, sinElev, litFactor, rocketLight,
    skyColors, drawBackdrop, shadeEarth, drawLocator, tickUI: refreshUI,
  };
})();
