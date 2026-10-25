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

  // __TEMP_SMOOTH__ — wall-clock exponential smoother. Any lighting change
  // (slider drag, START, day/night crossing) fades in over ~0.5 s instead of
  // snapping. Per-key so slow consumers don't drag fast ones down; first
  // call seeds directly (no startup fade). Rate 0.12 ≈ 95% convergence in
  // ~25 frames (0.42 s at 60 fps).
  const _tsmooth = Object.create(null);
  function _tsm(key, target, rate) {
    if (!Number.isFinite(target)) return target;
    const prev = _tsmooth[key];
    if (prev === undefined) { _tsmooth[key] = target; return target; }
    const r = (rate != null) ? rate : 0.12;
    const next = prev + (target - prev) * r;
    _tsmooth[key] = next;
    return next;
  }

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

  // ---- Moon (lighting model only — NOT a gravity body) ---------------------
  // The Moon is a second parallel light source in the same inertial 2-D frame.
  // Its elongation from the Sun (psi: 0 = new, PI = full) advances with the
  // synodic month, starting from CONFIG.MOON_PHASE0_DEG at T+0:
  //        psi(t) = psi0 + 2*PI * t / (MOON_SYNODIC_DAYS * 86400)
  // Illuminated fraction k = (1 - cos psi) / 2. Moonlight strength follows an
  // opposition-surge-like k^2 law (a half moon is far dimmer than a full one).
  // Like the Sun it sits out of the orbital plane by MOON_DECLINATION_DEG.
  const _cfg = (k, d) => (typeof CONFIG !== 'undefined' && CONFIG[k] != null) ? CONFIG[k] : d;
  function moonElong() {
    const T = _cfg('MOON_SYNODIC_DAYS', 29.530589) * 86400;
    return _cfg('MOON_PHASE0_DEG', 135) * Math.PI / 180 + TAU * simT() / T;
  }
  function moonPhi() { return sunPhi() + moonElong(); }
  function moonDir() { const p = moonPhi(); return { x: Math.sin(p), y: Math.cos(p) }; }
  function moonIllum() { return (1 - Math.cos(moonElong())) / 2; }
  function moonSinElev(x, y) {
    const r = Math.hypot(x, y) || 1, m = moonDir();
    return (x * m.x + y * m.y) / r;
  }
  function moonPhaseName() {
    const k = moonIllum(), e = ((moonElong() % TAU) + TAU) % TAU, waxing = e < Math.PI;
    if (k < 0.04) return 'New';
    if (k > 0.96) return 'Full';
    if (Math.abs(k - 0.5) < 0.06) return waxing ? 'First quarter' : 'Last quarter';
    return (k < 0.5 ? (waxing ? 'Waxing crescent' : 'Waning crescent') : (waxing ? 'Waxing gibbous' : 'Waning gibbous'));
  }
  function setMoonPhase(deg) {    // set the CURRENT elongation (deg); T+0 value is adjusted to match
    if (!Number.isFinite(deg) || typeof CONFIG === 'undefined') return;
    const T = _cfg('MOON_SYNODIC_DAYS', 29.530589) * 86400;
    CONFIG.MOON_PHASE0_DEG = deg - (TAU * simT() / T) * 180 / Math.PI;
  }

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
    const se = _tsm('skySE', camSE());
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
    // Replaced floating sun disc with a directional arrow so the planet
    // view reads as a compass, not a UI icon. Arrow points from off-screen
    // edge toward Earth, ending just above the planet's surface.
    const dir = sunScreenDir();
    const earthPx = CONFIG.EARTH_RADIUS / metersPerPixel();
    const earthCenter = worldToScreen(0, 0);
    const ang = Math.atan2(dir[1], dir[0]);
    const edgeDist = Math.hypot(cv.width, cv.height) * 1.5;
    const sx = earthCenter[0] + dir[0] * edgeDist;
    const sy = earthCenter[1] + dir[1] * edgeDist;
    const ex = earthCenter[0] + dir[0] * (earthPx + 20);
    const ey = earthCenter[1] + dir[1] * (earthPx + 20);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 210, 100, 0.45)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([12, 8]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    const headLen = 14;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - headLen * Math.cos(ang - 0.35), ey - headLen * Math.sin(ang - 0.35));
    ctx.lineTo(ex - headLen * Math.cos(ang + 0.35), ey - headLen * Math.sin(ang + 0.35));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 210, 100, 0.65)';
    ctx.fill();
    const labelDist = earthPx + 105;
    const tx = earthCenter[0] + dir[0] * labelDist;
    const ty = earthCenter[1] + dir[1] * labelDist;
    ctx.fillStyle = 'rgba(255, 220, 140, 0.85)';
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4;
    ctx.fillText('SUNLIGHT', tx, ty);
    ctx.restore();
  }

  // Planet view: moon disc with its true phase, at the screen edge in the moon's direction.
  function drawMoon(ctx, cv) {
    const cam = cameraWorldPosition(), m = moonDir(), K = 1000;
    const a = worldToScreen(cam.x, cam.y), b = worldToScreen(cam.x + m.x * K, cam.y + m.y * K);
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const ec = worldToScreen(0, 0), earthPx = CONFIG.EARTH_RADIUS / metersPerPixel();
    const x = ec[0] + dx * (earthPx + 70), y = ec[1] + dy * (earthPx + 70), r = 11;
    if (x < -r || y < -r || x > cv.width + r || y > cv.height + r) return;
    // Phase: lit side faces the Sun. Terminator is an ellipse of half-width r*|cos psi|.
    const sd = sunScreenDir(), sx = sd[0], sy = sd[1];   // parallel rays: Sun direction as seen on screen
    const psi = moonElong(), c = Math.cos(psi);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(Math.atan2(sy, sx));
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(30,34,48,0.9)'; ctx.fillRect(-r, -r, 2 * r, 2 * r);       // dark limb
    ctx.fillStyle = '#e4e6ec';
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);                            // lit half (toward +x = Sun)
    ctx.ellipse(0, 0, Math.abs(c) * r, r, 0, Math.PI / 2, -Math.PI / 2, c > 0);    // terminator
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(190,200,225,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,235,0.8)'; ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('MOON ' + Math.round(moonIllum() * 100) + '%', x, y + r + 4);
    ctx.restore();
  }

  // Called right after drawSky().
  function drawBackdrop(ctx, cv, altitude) {
    if (!S.enabled) return;
    const dens = clamp01(airDensity(Math.max(0, altitude)) / CONFIG.SEA_LEVEL_DENSITY);
    const se = _tsm('backdropSE', camSE());
    const day = isPlanet() ? 0 : groundDay(se);
    const starA = clamp01(1 - dens * day * 1.2);
    if (starA > 0.02) drawStars(ctx, cv, starA);
    // Sun icon: planet view only. In local view, the sun is either
    // overhead, behind the vehicle, or at a sky angle the camera cannot
    // point at (locked to local vertical). Drawing a sun icon there
    // reads as a UI element, gets clipped at screen edges, and appears
    // to orbit as the user drags the time slider. Sky color + body
    // shading already convey sun direction correctly in local view.
    if (isPlanet()) { drawSun(ctx, cv, dens, se); drawMoon(ctx, cv); }
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
      const se = _tsm('earthSE', camSE()), day = groundDay(se), tw = twilight(se);
      const cw = cameraWorldPosition(), cp = Math.hypot(cw.x, cw.y) < 1000 ? launchSiteWorldPosition(simT()) : cw;
      const mlit = moonIllum() * moonIllum() * clamp01(moonSinElev(cp.x, cp.y) * 4 + 0.3);   // moonlit night ground
      ctx.fillStyle = `rgba(2,5,14,${(0.62 * (1 - day) * (1 - 0.40 * mlit)).toFixed(3)})`;
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
      // City lights removed per user request.
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
  function litFactor(body, dirOverride) {
    const s = dirOverride || sunDir(), R = CONFIG.EARTH_RADIUS;
    const along = body.rx * s.x + body.ry * s.y;
    if (along > 0) return 1;
    const perp = Math.abs(body.rx * s.y - body.ry * s.x);        // distance from Earth-centre to sun ray
    return smooth(R - 15000, R + 25000, perp);                   // soft edge = atmospheric refraction
  }
  const _bodyL = new WeakMap();
  function _smBody(o, key, target, rate) {
    if (!Number.isFinite(target)) return target;
    const prev = o.sm[key];
    if (prev === undefined) { o.sm[key] = target; return target; }
    const next = prev + (target - prev) * (rate != null ? rate : 0.12);
    o.sm[key] = next;
    return next;
  }
  // Per-BODY light object (never shared between bodies). lx/ly/lz = unit sun
  // vector in the body frame (x across +right, y along nose, z toward the viewer).
  // The Sun sits out of the 2-D orbital plane by the physical declination
  // CONFIG.SUN_DECLINATION_DEG, so lz = sin(decl) and the in-plane part is
  // scaled by cos(decl) — a real 3-D sun instead of a fudge constant.
  function rocketLight(body) {
    if (!S.enabled || !body) return null;
    let o = _bodyL.get(body);
    if (!o) {
      o = { lx: 0, ly: 1, lz: 0.4, mx: 0, my: 1, mz: 0.3, moon: 0, lit: 1, amb: 0.3, tint: 0, sm: Object.create(null), reg: new Map(), regPrev: new Map() };
      _bodyL.set(body, o);
    }
    o.regPrev = o.reg; o.reg = new Map();      // profile registry rolls over once per body per frame
    const s = sunDir(), th = body.theta || 0, R = CONFIG.EARTH_RADIUS;
    const r = Math.hypot(body.rx, body.ry) || 1;
    const se = (body.rx * s.x + body.ry * s.y) / r;
    const lit = _smBody(o, 'lit', litFactor(body));
    const dens = clamp01(airDensity(Math.max(0, r - R)) / CONFIG.SEA_LEVEL_DENSITY);
    const day = groundDay(se);
    let amb = 0.10 + 0.38 * dens * day;
    if (S.assist) amb += 0.26 * (1 - lit) * (1 - dens * day);
    let decl = (CONFIG.SUN_DECLINATION_DEG != null ? CONFIG.SUN_DECLINATION_DEG : 23.44) * Math.PI / 180;
    decl = Math.max(0, Math.min(1.2, decl));
    const cd = Math.cos(decl);
    o.lx = (s.x * Math.cos(th) + s.y * Math.sin(th)) * cd;
    o.ly = (-s.x * Math.sin(th) + s.y * Math.cos(th)) * cd;
    o.lz = Math.sin(decl);
    // Moon: same frame transform, own declination; blocked by Earth like the Sun
    // (litFactor with the moon direction) and washed out by daylight in-atmosphere.
    const md = moonDir();
    let mdecl = _cfg('MOON_DECLINATION_DEG', 18) * Math.PI / 180;
    mdecl = Math.max(0, Math.min(1.2, mdecl));
    const mcd = Math.cos(mdecl), k = moonIllum();
    o.mx = (md.x * Math.cos(th) + md.y * Math.sin(th)) * mcd;
    o.my = (-md.x * Math.sin(th) + md.y * Math.cos(th)) * mcd;
    o.mz = Math.sin(mdecl);
    const mvis = _smBody(o, 'mvis', litFactor(body, md));
    o.moon = _smBody(o, 'moon', 0.24 * k * k * mvis * (1 - dens * day));
    o.lit = lit;
    o.amb = _smBody(o, 'amb', Math.min(0.75, amb));
    o.tint = _smBody(o, 'tint', (1 - smooth(0.02, 0.40, se)) * smooth(0.01, 0.25, dens));
    return o;
  }

  // ==========================================================================
  // SHADE ENGINE — real per-pixel lighting for axisymmetric hull parts.
  //
  // Every hull section (cylinder, fairing ogive, cone, engine bell) is a
  // surface of revolution about the rocket axis. The silhouette radius r(a)
  // (a = height along the axis) is sampled once from the member's own canvas
  // path (isPointInPath bisection, cached by a cheap path fingerprint), so the
  // shading follows whatever the drawer actually draws — no duplicated
  // geometry. For each pixel of a small map we compute the true surface
  // normal  N = (u, -dr/da, v)  (u = x/r, v = sqrt(1-u^2)), then
  //    diffuse  = N . L          (L = body-frame sun, incl. sun declination)
  //    specular = Blinn(N, L, V=+z)
  //    shadow   = 14-step ray march toward the sun through the radius
  //               profiles of every member of the body (fairing -> tank,
  //               hull -> engine bells).
  // The result is a straight-alpha black/warm/white overlay, clipped to the
  // member's path and drawn once. Maps are cached (LRU) by profile + light.
  // ==========================================================================
  const _mkCv = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    return null;
  };
  const _profCache = new Map();      // path fingerprint -> radius profile
  const _mapCache = new Map();       // light/profile key -> { cv, w, h }
  const _cvPool = [];
  const MAP_LRU = 48, PROF_LRU = 96, PROF_ROWS = 40;
  const _fx = () => (typeof ROCKET_FX !== 'undefined' && Number.isFinite(ROCKET_FX.spec)) ? ROCKET_FX.spec : 1;

  function _probe(ctx, m, x, y) { return ctx.isPointInPath(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f); }

  // Radius profile of the CURRENT path between local heights aLo..aHi (a = -y).
  function sampleProfile(ctx, ext, aLo, aHi, tag) {
    if (!(ext > 0.5) || !(aHi - aLo > 0.5) || typeof ctx.isPointInPath !== 'function' || typeof ctx.getTransform !== 'function') return null;
    const m = ctx.getTransform(), span = aHi - aLo;
    let bits = '';
    for (let j = 0; j < 8; j++) {
      const y = -(aLo + (j + 0.5) / 8 * span);
      let b = 0;
      for (let k = 0; k < 4; k++) b |= (_probe(ctx, m, ext * (0.3 + 0.2 * k + (k === 3 ? 0.07 : 0)), y) ? 1 : 0) << k;
      bits += b.toString(16);
    }
    const key = tag + '|' + ext.toFixed(1) + '|' + aLo.toFixed(1) + '|' + aHi.toFixed(1) + '|' + bits;
    let p = _profCache.get(key);
    if (p) { _profCache.delete(key); _profCache.set(key, p); return p; }
    const r = new Float32Array(PROF_ROWS);
    let rmax = 0;
    for (let j = 0; j < PROF_ROWS; j++) {
      const y = -(aLo + (j + 0.5) / PROF_ROWS * span);
      if (!_probe(ctx, m, 0, y)) { r[j] = 0; continue; }
      let lo = 0, hi = ext;
      if (_probe(ctx, m, ext * 0.999, y)) lo = ext;
      else for (let it = 0; it < 7; it++) { const mid = (lo + hi) / 2; if (_probe(ctx, m, mid, y)) lo = mid; else hi = mid; }
      r[j] = lo; if (lo > rmax) rmax = lo;
    }
    p = { key, r, aLo, aHi, ext, rmax };
    _profCache.set(key, p);
    if (_profCache.size > PROF_LRU) _profCache.delete(_profCache.keys().next().value);
    return p;
  }

  function _rAt(p, a) {
    const t = (a - p.aLo) / (p.aHi - p.aLo) * PROF_ROWS - 0.5;
    if (t < -0.5 || t > PROF_ROWS - 0.5) return 0;
    const i0 = Math.floor(t), f = t - i0;
    const r0 = p.r[i0 < 0 ? 0 : i0], r1 = p.r[i0 + 1 > PROF_ROWS - 1 ? PROF_ROWS - 1 : i0 + 1];
    return r0 + (r1 - r0) * f;
  }
  function _slope(p, a) {                       // dr/da, one-sided at the ends
    const h = (p.aHi - p.aLo) / PROF_ROWS * 1.5;
    const rp = _rAt(p, a + h), rm = _rAt(p, a - h), r0 = _rAt(p, a);
    let s = 0;
    if (rp > 0.01 && rm > 0.01) s = (rp - rm) / (2 * h);
    else if (rp > 0.01) s = (rp - r0) / h;
    else if (rm > 0.01) s = (r0 - rm) / h;
    return s > 6 ? 6 : s < -6 ? -6 : s;
  }

  function _occluders(RL) {
    const list = [], seen = new Set();
    const add = mp => { if (!mp) return; mp.forEach((v, k) => { if (!seen.has(k)) { seen.add(k); list.push(v); } }); };
    add(RL.reg); add(RL.regPrev);
    let sig = '', aTop = -Infinity, aBase = Infinity, rmax = 0;
    const ks = Array.from(seen).sort();
    for (let i = 0; i < ks.length; i++) sig += ks[i] + ';';
    for (const o of list) {
      const t = o.A0 + o.prof.aHi, b = o.A0 + o.prof.aLo;
      if (t > aTop) aTop = t; if (b < aBase) aBase = b; if (o.prof.rmax > rmax) rmax = o.prof.rmax;
    }
    let h = 2166136261;
    for (let i = 0; i < sig.length; i++) { h ^= sig.charCodeAt(i); h = Math.imul(h, 16777619); }
    return { list, hash: (h >>> 0).toString(36), aTop, aBase, rmax };
  }

  // 14-step march from surface point (px,A,pz) toward light (lx,ly,lz). true = occluded.
  function _shadowed(occ, px, A, pz, lx, ly, lz) {
    if (!occ.list.length) return false;
    let tEnd = Infinity;
    if (ly > 1e-4) tEnd = (occ.aTop - A) / ly; else if (ly < -1e-4) tEnd = (A - occ.aBase) / -ly;
    const qa = lx * lx + lz * lz, qb = 2 * (px * lx + pz * lz), qc = px * px + pz * pz - occ.rmax * occ.rmax;
    if (qa > 1e-9) {
      const disc = qb * qb - 4 * qa * qc;
      if (qc > 0 && (qb >= 0 || disc < 0)) return false;     // already outside the stack envelope, moving away
      const tl = (-qb + Math.sqrt(disc < 0 ? 0 : disc)) / (2 * qa);
      if (tl < tEnd) tEnd = tl;
    }
    if (!(tEnd > 0.6)) return false;
    const S = 14, t0 = 0.4, L = occ.list;
    for (let k = 1; k <= S; k++) {
      const f = k / S, t = t0 + (tEnd - t0) * f * f;
      const x = px + lx * t, z = pz + lz * t, aa = A + ly * t, rr = x * x + z * z;
      for (let i = 0; i < L.length; i++) {
        const o = L[i], r = _rAt(o.prof, aa - o.A0) - 0.3;
        if (r > 0 && rr < r * r) return true;
      }
    }
    return false;
  }

  // Bell-to-bell shadow: siblings = [{x,z}] axis positions (px, hull-axis frame) of the OTHER bells.
  // Each is treated as a vertical solid of revolution with the same radius profile as the bell being shaded.
  function _sibShadowed(sibs, prof, A0, px, A, pz, lx, ly, lz) {
    const hz = Math.hypot(lx, lz);
    let tEnd = 4 * prof.ext / (hz + 1e-3);
    if (ly > 1e-4) { const t = (A0 + prof.aHi - A) / ly; if (t < tEnd) tEnd = t; }
    else if (ly < -1e-4) { const t = (A - (A0 + prof.aLo)) / -ly; if (t < tEnd) tEnd = t; }
    if (!(tEnd > 0.6)) return false;
    for (let k = 1; k <= 9; k++) {
      const t = 0.4 + (tEnd - 0.4) * (k / 9);
      const x = px + lx * t, z = pz + lz * t, aa = A + ly * t - A0;
      const r = _rAt(prof, aa) - 0.3;
      if (!(r > 0)) continue;
      for (let i = 0; i < sibs.length; i++) {
        const dx = x - sibs[i].x, dz = z - sibs[i].z;
        if (dx * dx + dz * dz < r * r) return true;
      }
    }
    return false;
  }

  const EXPOSURE = 1.22;   // camera exposure: a white hull face-on to a ~23deg-declination sun reads white, not grey

  function _renderMap(sp) {
    const { prof, C, R, RL, occ, cx, cz, A0, sibs } = sp;
    const cv = _cvPool.pop() || _mkCv(C, R);
    if (!cv) return null;
    if (cv.width !== C) cv.width = C;
    if (cv.height !== R) cv.height = R;
    const g = cv.getContext('2d');
    const img = g.createImageData(C, R), d = img.data;
    const q = sp.q, ext = prof.ext, span = prof.aHi - prof.aLo;
    const lx = q.lx, ly = q.ly, lz = q.lz, lit = q.lit, amb = q.amb, tint = q.tint, spec = _fx();
    // half vector (V = +z)
    const hl = Math.hypot(lx, ly, lz + 1) || 1, hx = lx / hl, hy = ly / hl, hz = (lz + 1) / hl;
    const mx = q.mx, my = q.my, mz = q.mz, moon = q.moon > 0.01 ? q.moon : 0;
    const wr = 255, wg = Math.round(255 - 60 * tint), wb = Math.round(255 - 150 * tint);
    for (let j = 0; j < R; j++) {
      const a = prof.aHi - (j + 0.5) / R * span;
      let r = _rAt(prof, a);
      if (r < 0.5) r = Math.max(0.5, _rAt(prof, a + span / R) || _rAt(prof, a - span / R) || 0.5);
      const sl = _slope(prof, a);
      const nyRaw = -sl;
      for (let i = 0; i < C; i++) {
        const x = ((i + 0.5) / C * 2 - 1) * ext;
        let u = x / r; u = u > 1 ? 1 : u < -1 ? -1 : u;
        const v = Math.sqrt(1 - u * u);
        const inv = 1 / Math.hypot(u, nyRaw, v);
        const nx = u * inv, ny = nyRaw * inv, nz = v * inv;
        let D = nx * lx + ny * ly + nz * lz; if (D < 0) D = 0;
        let sh = 1;
        if (D > 0 && lit > 0.02 && ((occ.list.length && _shadowed(occ, cx + u * r, A0 + a, cz + v * r, lx, ly, lz)) ||
          (sibs && _sibShadowed(sibs, prof, A0, cx + u * r, A0 + a, cz + v * r, lx, ly, lz)))) sh = 0;
        D *= sh;
        let Dm = 0;
        if (moon > 0) {
          Dm = nx * mx + ny * my + nz * mz; if (Dm < 0) Dm = 0;
          if (Dm > 0 && ((occ.list.length && _shadowed(occ, cx + u * r, A0 + a, cz + v * r, mx, my, mz)) ||
            (sibs && _sibShadowed(sibs, prof, A0, cx + u * r, A0 + a, cz + v * r, mx, my, mz)))) Dm = 0;
        }
        const B = Math.min(1, (amb + lit * (1 - amb) * D) * EXPOSURE + moon * Dm * (1 - amb));
        let ab = 1 - B; ab = ab < 0 ? 0 : ab > 0.82 ? 0.82 : ab;
        let NH = nx * hx + ny * hy + nz * hz; if (NH < 0) NH = 0;
        let ah = D > 0 ? lit * sh * 0.30 * spec * Math.pow(NH, 28) : 0; if (ah > 0.6) ah = 0.6;
        const aw = tint * lit * D * 0.16;
        const ac = moon * Dm * 0.45 * (1 - Math.min(1, lit * D * 2));      // cool moonlight sheen, only where the Sun isn't
        // straight-alpha "over": black, then cool (moon), warm, then white
        let ca = ab, cr = 0, cg = 0, cb = 0;
        if (ac > 0.004) { const oa = ac + ca * (1 - ac); cr = (150 * ac) / oa; cg = (185 * ac) / oa; cb = (255 * ac) / oa; ca = oa; }
        if (aw > 0.004) { const oa = aw + ca * (1 - aw); cr = (255 * aw + cr * ca * (1 - aw)) / oa; cg = (150 * aw + cg * ca * (1 - aw)) / oa; cb = (70 * aw + cb * ca * (1 - aw)) / oa; ca = oa; }
        if (ah > 0.004) { const oa = ah + ca * (1 - ah); cr = (wr * ah + cr * ca * (1 - ah)) / oa; cg = (wg * ah + cg * ca * (1 - ah)) / oa; cb = (wb * ah + cb * ca * (1 - ah)) / oa; ca = oa; }
        const o = (j * C + i) * 4;
        d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = ca * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  function _quant(RL) {
    const lx = Math.round(RL.lx * 24) / 24, ly = Math.round(RL.ly * 24) / 24, lz = RL.lz;
    const n = Math.hypot(lx, ly, lz) || 1;
    const mx = Math.round(RL.mx * 24) / 24, my = Math.round(RL.my * 24) / 24, mz = RL.mz;
    const mn = Math.hypot(mx, my, mz) || 1;
    return { mx: mx / mn, my: my / mn, mz: mz / mn, moon: Math.round(RL.moon * 48) / 48,
             lx: lx / n, ly: ly / n, lz: lz / n, lit: Math.round(RL.lit * 12) / 12,
             amb: Math.round(RL.amb * 24) / 24, tint: Math.round(RL.tint * 12) / 12 };
  }

  function _getMap(ctx, prof, RL, cx, cz, A0, sibs, sibKey) {
    const m = ctx.getTransform(), sw = 2 * prof.ext * Math.hypot(m.a, m.b);
    const C = sw < 28 ? 12 : sw < 80 ? 24 : 44;
    const span = prof.aHi - prof.aLo;
    const R = Math.max(6, Math.min(96, Math.round(C * span / (2 * prof.ext))));
    const q = _quant(RL), occ = _occluders(RL);
    const key = [prof.key, C, R, Math.round(cx * 2), Math.round(cz * 2), Math.round(A0 * 2),
      Math.round(q.lx * 24), Math.round(q.ly * 24), Math.round(q.lit * 12), Math.round(q.amb * 24), Math.round(q.tint * 12),
      q.moon > 0.01 ? Math.round(q.mx * 24) + ',' + Math.round(q.my * 24) + ',' + Math.round(q.moon * 48) : 'nm', occ.hash, sibKey || ''].join('~');
    let e = _mapCache.get(key);
    if (e) { _mapCache.delete(key); _mapCache.set(key, e); return e; }
    const cv = _renderMap({ prof, C, R, RL, occ, cx, cz, A0, q, sibs: sibs || null });
    if (!cv) return null;
    e = { cv };
    _mapCache.set(key, e);
    if (_mapCache.size > MAP_LRU) {
      const k0 = _mapCache.keys().next().value, old = _mapCache.get(k0);
      _mapCache.delete(k0);
      if (old && old.cv && _cvPool.length < 16) _cvPool.push(old.cv);
    }
    return e;
  }

  // Shade the CURRENT path of a hull member. W,H in member px; A0 = height of the
  // member base above the stack base (px, up). Returns false if the caller should fall back.
  function drawShadeSlice(ctx, W, H, A0, tag) {
    const RL = globalThis._ROCKET_LIGHT;
    if (!RL || !RL.reg || !(W > 0) || !(H > 0)) return false;
    const prof = sampleProfile(ctx, W / 2, 0, H, tag || 'm');
    if (!prof) return false;
    RL.reg.set(prof.key + '@' + Math.round(A0 * 2), { prof, A0 });
    const e = _getMap(ctx, prof, RL, 0, 0, A0);
    if (!e) return false;
    ctx.save();
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(e.cv, -W / 2, -H, W, H);
    ctx.restore();
    return true;
  }

  // Engine bell: CURRENT path is the bell wall (origin = attach point on the hull
  // base, y down). cx/cz = bell axis offset from the hull axis; A0 = hull-base height.
  function drawBellShade(ctx, sR, wallH, cx, cz, A0, gimbalRad, sibs) {
    let RL = globalThis._ROCKET_LIGHT;
    if (!RL || !RL.reg || !(sR > 0.5) || !(wallH > 0.5)) return false;
    const prof = sampleProfile(ctx, sR, -wallH, 0, 'bell');
    if (!prof) return false;
    // The bell is drawn in a gimbal-rotated frame, so rotate the light into that frame
    // (0.5 deg steps keep the map cache small). Shadows still march in the hull frame.
    if (gimbalRad && Math.abs(gimbalRad) > 0.004) {
      const q = Math.round(gimbalRad * 114.5916) / 114.5916, c = Math.cos(q), s = Math.sin(q);
      RL = Object.assign({}, RL, {
        lx: RL.lx * c - RL.ly * s, ly: RL.lx * s + RL.ly * c,
        mx: RL.mx * c - RL.my * s, my: RL.mx * s + RL.my * c,
      });
    }
    let sk = '';
    if (sibs && sibs.length) { let h = 0; for (const o of sibs) h += o.x * 3.1 + o.z * 7.3; sk = sibs.length + ':' + Math.round(h * 2); }
    const e = _getMap(ctx, prof, RL, cx, cz, A0, sibs && sibs.length ? sibs : null, sk);
    if (!e) return false;
    ctx.save();
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(e.cv, -sR, 0, sR * 2, wallH);
    ctx.restore();
    return true;
  }

  // Brightness (0.10..1) of a flat part (leg panel, grid-fin face, hinge pod) whose
  // outward normal is (nx right, ny toward nose, nz toward viewer) in the body frame.
  // Same lighting maths as the hull shade map (sun + ambient + exposure + moon), so
  // hardware and hull always agree. Returns 1 when there is no light object (previews).
  function partLight(nx, ny, nz) {
    const RL = globalThis._ROCKET_LIGHT;
    if (!RL) return 1;
    const n = Math.hypot(nx, ny, nz) || 1; nx /= n; ny /= n; nz /= n;
    let D = nx * RL.lx + ny * RL.ly + nz * RL.lz; if (D < 0) D = 0;
    let B = (RL.amb + RL.lit * (1 - RL.amb) * D) * EXPOSURE;
    if (RL.moon > 0.01) { const Dm = nx * RL.mx + ny * RL.my + nz * RL.mz; if (Dm > 0) B += RL.moon * Dm * (1 - RL.amb); }
    return B > 1 ? 1 : B < 0.10 ? 0.10 : B;
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
    if (_ui.phase) _ui.phase.textContent = `${ICON[ph]} ${ph} · sun ${(Math.asin(Math.max(-1, Math.min(1, se))) * 180 / Math.PI).toFixed(0)}° · ☾ ${Math.round(moonIllum() * 100)}% ${moonPhaseName()}`;
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
    moonDir, moonIllum, moonSinElev, moonPhaseName, setMoonPhase,
    drawShadeSlice, drawBellShade, partLight,
    skyColors, drawBackdrop, shadeEarth, drawLocator, tickUI: refreshUI,
  };
})();
