/* Guidance Tester — presentation layer ("Ascent").
   Touches only presentation. Sim logic stays in the HTML.
   - The page sky follows the rocket: dawn on the pad, black space in orbit.
   - Live flight readout, phase ribbon, Max Q call, result verdict, ignition flare.
   - Mobile dock with a thumb-reach Run button.
   Reads sim globals (state, CONFIG, Guidance) read-only, inside try/catch. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const visualsOff = () => { const v = $('visualsToggle'); return !!v && !v.checked; };
  const human = (s) => { s = String(s || '').replace(/_/g, ' ').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };

  /* ---------- Font + identity ---------- */
  (function identity() {
    if (!$('gt-font')) {
      const l = document.createElement('link'); l.id = 'gt-font'; l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap';
      document.head.appendChild(l);
    }
    const logo = document.querySelector('.logo');
    if (logo) logo.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 2c3 3 4.5 7 4.5 11l2 3.5-3 .8L14 20h-4l-1.5-2.7-3-.8 2-3.5C7.5 9 9 5 12 2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="9.5" r="1.6" fill="currentColor"/><path d="M12 21v2.4" stroke="#ff6b2c" stroke-width="2.2" stroke-linecap="round"/></svg>';
    const br = document.querySelector('.brand'); if (br) br.textContent = 'Guidance Numerical';
    const bs = document.querySelector('.brand-sub'); if (bs) bs.textContent = 'Headless-parity calibration bench';
    const mb = $('menuBtn'); if (mb) mb.textContent = 'Setup';
    const ctl = $('controls');
    if (ctl) { const h = document.createElement('div'); h.className = 'hint-row'; h.textContent = 'Press R to run, Esc to stop.'; ctl.appendChild(h); }
  })();

  /* ---------- Sky engine: background follows altitude ---------- */
  let skyTarget = 0; // km, fed by the live readout
  const stops = [
    { k: 0,   t: [27, 74, 134], m: [58, 106, 163], b: [240, 150, 92] },
    { k: 6,   t: [22, 56, 108], m: [44, 78, 128],  b: [190, 128, 110] },
    { k: 22,  t: [10, 28, 64],  m: [20, 44, 84],   b: [60, 84, 128] },
    { k: 55,  t: [4, 10, 28],   m: [8, 20, 44],    b: [24, 52, 98] },
    { k: 110, t: [1, 2, 8],     m: [2, 5, 16],     b: [10, 30, 70] },
  ];
  function skyAt(km) {
    let i = 0; while (i < stops.length - 2 && km > stops[i + 1].k) i++;
    const a = stops[i], b = stops[i + 1], f = clamp((km - a.k) / (b.k - a.k), 0, 1);
    const mix = (x, y) => x.map((v, j) => Math.round(lerp(v, y[j], f)));
    return { t: mix(a.t, b.t), m: mix(a.m, b.m), b: mix(a.b, b.b) };
  }
  const rgb = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';

  (function sky() {
    const c = $('fxCanvas'); if (!c) return;
    const g = c.getContext('2d'); let W = 0, H = 0, dpr = 1, last = 0;
    const size = () => { dpr = Math.min(devicePixelRatio || 1, 1.25); W = c.width = Math.round(innerWidth * dpr); H = c.height = Math.round(innerHeight * dpr); };
    size(); addEventListener('resize', size);
    const stars = [];
    for (let i = 0; i < 120; i++) stars.push({ x: Math.random(), y: Math.random() * .92, r: Math.random() * 1.3 + .3, p: Math.random() * 6.28, s: Math.random() * .0012 + .0004 });
    let alt = reduce ? 0 : 95; // page opens in space and settles to dawn
    function frame(t) {
      requestAnimationFrame(frame);
      const run = body.classList.contains('is-running');
      if (document.hidden || t - last < (run ? 50 : 33)) return; last = t;
      if (visualsOff()) { c.style.visibility = 'hidden'; body.classList.add('plain'); return; }
      c.style.visibility = 'visible'; body.classList.remove('plain');
      alt += (skyTarget - alt) * (run ? .25 : .06);
      const s = skyAt(alt), e = clamp(alt / 100, 0, 1);
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, rgb(s.t)); gr.addColorStop(.62, rgb(s.m)); gr.addColorStop(1, rgb(s.b));
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const sa = clamp((alt - 12) / 50, 0, 1) * .9;
      if (sa > .02) for (const st of stars) {
        const a = sa * (.55 + .45 * Math.sin(t * st.s + st.p));
        g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')'; g.fillRect(st.x * W, st.y * H, st.r * dpr, st.r * dpr);
      }
      const sunA = clamp(1 - alt / 45, 0, 1) * .6;
      if (sunA > .01) {
        const sg = g.createRadialGradient(W * .2, H * .97, 0, W * .2, H * .97, W * .8);
        sg.addColorStop(0, 'rgba(255,176,96,' + sunA.toFixed(3) + ')'); sg.addColorStop(1, 'rgba(255,176,96,0)');
        g.fillStyle = sg; g.fillRect(0, 0, W, H);
      }
      const R = W * lerp(7, 1.7, e), topY = H * lerp(.935, .80, e), cx = W / 2, cy = topY + R;
      const f = clamp(alt / 30, 0, 1), rr = Math.round(lerp(255, 110, f)), gg = Math.round(lerp(170, 185, f)), bb = Math.round(lerp(100, 255, f));
      const rimA = lerp(.55, .9, e);
      const hz = g.createLinearGradient(0, topY - H * .18, 0, topY + 4);
      hz.addColorStop(0, 'rgba(' + rr + ',' + gg + ',' + bb + ',0)'); hz.addColorStop(1, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (.28 * rimA).toFixed(3) + ')');
      g.fillStyle = hz; g.fillRect(0, topY - H * .18, W, H * .18 + 4);
      const eg = g.createLinearGradient(0, topY, 0, H); eg.addColorStop(0, 'rgb(6,14,26)'); eg.addColorStop(1, 'rgb(2,5,10)');
      g.fillStyle = eg; g.beginPath(); g.arc(cx, cy, R, 0, 6.2832); g.fill();
      [[26, .10], [12, .18], [4, .5], [1.5, .95]].forEach((w) => {
        g.strokeStyle = 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (w[1] * rimA).toFixed(3) + ')'; g.lineWidth = w[0] * dpr;
        g.beginPath(); g.arc(cx, cy, R, 0, 6.2832); g.stroke();
      });
    }
    requestAnimationFrame(frame);
  })();

  /* ---------- Thermal state — derived, main-thread only ---------- */
  const _tempState = new Map();
  const _THERMAL_TAU_S = 12;
  window.__tempState = _tempState;
  window.__THERMAL_TAU_S = _THERMAL_TAU_S;
  window.__thermalTickOne = function (b, simTime, dt) {
    if (!b || !b.id) return;
    if (typeof skinEquilibriumK !== 'function') return;
    let st = _tempState.get(b.id);
    if (!st) {
      st = { T: 288.15, peakK: 288.15 };
      _tempState.set(b.id, st);
    }
    const r = Math.hypot(b.rx, b.ry);
    if (!(r > 1)) return;
    const alt_m = r - CONFIG.EARTH_RADIUS;
    const sv = earthSurfaceVelocity(b.rx, b.ry);
    const wv = (typeof windInertialVector === 'function') ? windInertialVector(b.rx, b.ry) : { wx: 0, wy: 0 };
    const relVx = b.vx - (sv.vx + wv.wx);
    const relVy = b.vy - (sv.vy + wv.wy);
    const speedRel = Math.hypot(relVx, relVy);
    const Teq = skinEquilibriumK(alt_m, speedRel);
    const alpha = 1 - Math.exp(-dt / _THERMAL_TAU_S);
    st.T += (Teq - st.T) * alpha;
    // Peak = max instantaneous thermal environment (not lagged T) — see
    // telemetry.js for the full reasoning. Reentry T_eq peaks 1400+ K.
    if (Teq > st.peakK) st.peakK = Teq;
  };
  window.__thermalTickAll = function (dt) {
    if (typeof state === 'undefined' || !state || !state.bodies) return;
    for (const b of state.bodies) window.__thermalTickOne(b, state.simTime, dt);
  };

  /* ---------- Build the flight deck (hero) ---------- */
  (function buildDeck() {
    const pane = $('paneTele'); if (!pane) return;
    const card = pane.querySelector('.plot-card.main');
    const cell = (label, id, unit, bar) => '<div class="cell"><span class="lbl">' + label + '</span><span class="val"><b id="' + id + '">–</b><i>' + unit + '</i></span><span class="bar"><span id="' + bar + '"></span></span></div>';
    const cellBi = (label, id, unit, barL, barR, markL, markR) =>
      '<div class="cell"><span class="lbl">' + label + '</span><span class="val"><b id="' + id + '">–</b><i>' + unit + '</i></span>' +
      '<span class="bar bi">' +
      '<span class="sublbl sl">Apo <b id="hudApo">–</b></span>' +
      '<span class="sublbl sr">Peri <b id="hudPeri">–</b></span>' +
      '<span class="fill-l" id="' + barL + '"></span>' +
      '<span class="fill-r" id="' + barR + '"></span>' +
      '<span class="tmark-l" id="' + markL + '"></span>' +
      '<span class="tmark-r" id="' + markR + '"></span>' +
      '</span></div>';
    const cellT = (label, id, unit, bar, mark) =>
      '<div class="cell"><span class="lbl">' + label + '</span><span class="val"><b id="' + id + '">–</b><i>' + unit + '</i></span>' +
      '<span class="bar"><span class="tmark" id="' + mark + '"></span><span id="' + bar + '"></span></span></div>';
    const cellQ = (label, id, unit, bar) =>
      '<div class="cell"><span class="lbl">' + label + '</span>' +
      '<span class="val"><b id="' + id + '">–</b><i>' + unit + '</i><span class="sub" id="hudQPeak"></span></span>' +
      '<span class="bar"><span id="' + bar + '"></span></span></div>';
    const deck = document.createElement('section'); deck.className = 'deck'; deck.id = 'deck';
    const view = document.createElement('div'); view.className = 'deck-view';
    if (card) view.appendChild(card);
    view.insertAdjacentHTML('beforeend', '<div class="verdict" id="verdict" aria-live="polite"><div><span class="v-big" id="vBig"></span><span class="v-sub" id="vSub"></span></div></div>');
    const read = document.createElement('div'); read.className = 'deck-read';
    read.innerHTML =
      '<div class="met"><span class="lbl">Mission time</span><span class="met-val" id="hudMet">T+ 00:00:00</span></div>' +
      '<div class="phase"><span class="lbl">Flight phase</span><b id="hudPhase">Standing by</b></div>' +
      '<div class="inst">' +
      cellBi('Altitude', 'hudAlt', 'km', 'barAltL', 'barAltR', 'tmarkAltL', 'tmarkAltR') +
      cellT('Speed', 'hudVel', 'm/s', 'barVel', 'tmarkVel') +
      cell('Climb rate', 'hudVr', 'm/s', 'barVr') +
      cell('Horizontal speed', 'hudVt', 'm/s', 'barVt') +
      cellQ('Dynamic pressure', 'hudQ', 'kPa', 'barQ') +
      cellT('Orbital energy', 'hudEnergy', 'MJ/kg', 'barEnergy', 'tmarkEnergy') +
      '</div>';
    read.insertAdjacentHTML('beforeend',
      '<div class="temp-block"><div class="temp-title">Body temperatures</div><div id="hudTemps"></div></div>');
    deck.append(view, read);
    pane.insertBefore(deck, pane.firstChild);
    const rib = document.createElement('div'); rib.id = 'phaseRibbon';
    rib.innerHTML = '<span class="rib-empty">Phases appear here as the vehicle flies.</span>';
    pane.insertBefore(rib, deck.nextSibling);
  })();

  /* ---------- Mobile dock ---------- */
  const sb = $('startBtn'), stopB = $('stopBtn');
  const dock = document.createElement('div'); dock.id = 'dock';
  dock.innerHTML = '<button class="dock-menu" id="dockMenu" type="button">Setup</button><button class="dock-run" id="dockRun" type="button">Run</button><button class="dock-stop" id="dockStop" type="button" disabled>Stop</button>';
  document.getElementById('app').appendChild(dock);
  const dRun = $('dockRun'), dStop = $('dockStop');
  dRun.addEventListener('click', () => { if (sb && !sb.disabled) sb.click(); });
  dStop.addEventListener('click', () => { if (stopB && !stopB.disabled) stopB.click(); });
  $('dockMenu').addEventListener('click', () => body.classList.toggle('nav-open'));
  function syncDock() { if (sb) dRun.disabled = sb.disabled; if (stopB) dStop.disabled = stopB.disabled; }
  [sb, stopB].forEach((n) => n && new MutationObserver(syncDock).observe(n, { attributes: true, attributeFilter: ['disabled'] }));

  /* ---------- Ripple, tabs, drawer ---------- */
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) / 2;
    const s = document.createElement('span'); s.className = 'ripple';
    s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === t.dataset.pane));
    window.dispatchEvent(new Event('resize'));
  }));
  const mb = $('menuBtn');
  if (mb) mb.addEventListener('click', () => body.classList.toggle('nav-open'));
  document.addEventListener('click', (e) => { if (body.classList.contains('nav-open') && !e.target.closest('#sidebar,#menuBtn,#dockMenu')) body.classList.remove('nav-open'); });
  document.querySelectorAll('.reveal').forEach((n) => n.classList.add('in'));

  /* ---------- Toasts ---------- */
  function toast(msg) {
    const host = $('toasts'); if (!host) return;
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; host.appendChild(t);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3400);
  }
  const st = $('statusText'); let lastMsg = '';
  if (st) new MutationObserver(() => {
    const m = st.textContent;
    if (m !== lastMsg && /^(Done|Aborting|Constants reset|Plots cleared|Visuals)/.test(m)) toast(m);
    lastMsg = m;
    const tps = /(\d+)\s*ticks\/s/.exec(m); if (tps) setKpi('kTps', tps[1]);
  }).observe(st, { childList: true, characterData: true, subtree: true });
  const ps = $('presetStatus');
  if (ps) new MutationObserver(() => ps.textContent && toast(ps.textContent)).observe(ps, { childList: true });

  /* ---------- Live flight readout, phase ribbon, Max Q ---------- */
  let phases = [], phaseColors = {}, curPhase = '', qMax = 0, maxQDone = false, massMax = 0, lastSim = -1, ribAt = 0, ribDirty = false;
  const PAL = ['#8fe3ff', '#ffb454', '#6df0a0', '#ff8fb0', '#c3b2ff', '#ffe27a', '#6fb7ff', '#ff8a6b'];
  const set = (id, v) => { const n = $(id); if (n && n.textContent !== v) n.textContent = v; };
  const bar = (id, f) => { const n = $(id); if (n) n.style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%'; };
  const fx = (v, d) => Number.isFinite(v) ? v.toFixed(d) : '–';

  function _updateTempRows() {
    const host = $('hudTemps');
    if (!host) return;
    const bodies = (typeof state !== 'undefined' && state && state.bodies) ? state.bodies : [];
    const roles = { booster: null, stage: null, payload: null };
    for (const b of bodies) {
      const role = (b.members && b.members[0] && b.members[0].stageRole) || null;
      if (b.payloadBody && !roles.payload) roles.payload = b;
      else if (b.fairingHalf) continue;
      else if (role === 'booster' && !roles.booster) roles.booster = b;
      else if (role === 'stage' && !roles.stage) roles.stage = b;
    }
    const rowFor = (label, b) => {
      if (!b) return '<div class="temp-row"><span class="tr-lbl">' + label + '</span><span class="tr-val">—</span></div>';
      const st = _tempState.get(b.id);
      const T = st ? st.T : 288.15;
      const pk = st ? st.peakK : 288.15;
      return '<div class="temp-row"><span class="tr-lbl">' + label +
        '</span><span class="tr-val"><b>' + T.toFixed(0) + '</b> K <i>pk ' + pk.toFixed(0) + '</i></span></div>';
    };
    host.innerHTML =
      rowFor('Booster (I/S)', roles.booster) +
      rowFor('Stage', roles.stage) +
      rowFor('Payload', roles.payload);
  }

  function resetFlight() {
    phases = []; phaseColors = {}; curPhase = ''; qMax = 0; maxQDone = false; massMax = 0; lastSim = Infinity; ribDirty = true;
    const v = $('verdict'); if (v) v.className = 'verdict';
    set('hudPhase', 'Standing by');
  }
  function renderRibbon(t) {
    const rib = $('phaseRibbon'); if (!rib) return;
    if (!phases.length) { rib.innerHTML = '<span class="rib-empty">Phases appear here as the vehicle flies.</span>'; return; }
    let h = '';
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i], end = i + 1 < phases.length ? phases[i + 1].t0 : t;
      const dur = Math.max(end - p.t0, .5), live = i === phases.length - 1 && body.classList.contains('is-running');
      h += '<span class="seg' + (live ? ' live' : '') + '" style="flex:' + dur.toFixed(2) + ' 1 0;--pc:' + p.c + '" title="' + human(p.n) + ' from T+' + p.t0.toFixed(1) + ' s">' + human(p.n) + '</span>';
    }
    rib.innerHTML = h;
  }
  function liveBody() {
    try {
      if (typeof state === 'undefined' || !state || !state.bodies || !state.bodies.length) return null;
      const b = state.bodies[state.activeBodyIndex | 0] || state.bodies[0];
      return b && Number.isFinite(b.rx) ? b : null;
    } catch (e) { return null; }
  }
  function getTargetAltKm() {
    try {
      if (typeof window.__getGuideTargetAltKm === 'function') {
        const v = window.__getGuideTargetAltKm();
        if (Number.isFinite(v) && v > 0) return v;
      }
    } catch (e) {}
    try {
      const gs = (typeof Guidance !== 'undefined' && Guidance.getGuideStatus && Guidance.getGuideStatus()) || {};
      if (Number.isFinite(gs.coastVOrbital) && gs.coastVOrbital > 0) {
        const GM = CONFIG.GM_EARTH, Re = CONFIG.EARTH_RADIUS;
        const rr = GM / (gs.coastVOrbital * gs.coastVOrbital);
        const aalt = (rr - Re) / 1000;
        if (aalt > 10 && aalt < 5000) return aalt;
      }
    } catch (e) {}
    return 320;
  }

  function readout() {
    const b = liveBody(); if (!b) return;
    let Re, r;
    try { Re = CONFIG.EARTH_RADIUS; r = Math.hypot(b.rx, b.ry); } catch (e) { return; }
    if (!(r > 1) || !Number.isFinite(Re)) return;
    const t = state.simTime || 0;
    if (t < lastSim - .5) { const keep = lastSim === Infinity; resetFlight(); if (!keep) lastSim = t; }
    lastSim = t;
    const ux = b.rx / r, uy = b.ry / r, ex = b.ry / r, ey = -b.rx / r;
    const vr = b.vx * ux + b.vy * uy, vt = b.vx * ex + b.vy * ey, sp = Math.hypot(b.vx, b.vy), alt = (r - Re) / 1000;
    let q = 0;
    try {
      const rho = airDensity(Math.max(0, r - Re)), sv = earthSurfaceVelocity(b.rx, b.ry), wv = windInertialVector(b.rx, b.ry);
      const rx = b.vx - (sv.vx + wv.wx), ry = b.vy - (sv.vy + wv.wy);
      q = .5 * rho * (rx * rx + ry * ry) / 1000;
    } catch (e) { /* atmosphere helpers unavailable */ }
    skyTarget = Math.max(0, alt);

    // Max-Q tracking (must run before Q display).
    if (q > qMax) qMax = q;
    else if (!maxQDone && qMax > 3 && q < qMax * .92) {
      maxQDone = true;
      toast('Max Q passed at T+' + t.toFixed(1) + ' s, ' + qMax.toFixed(1) + ' kPa');
    }

    // Mission clock — HH:MM:SS, no decimals.
    // 1μs epsilon absorbs float accumulation drift from the tick loop
    // (48000 × dt can land at 599.9999999 instead of exactly 600, which
    // would display as "09:59" instead of "10:00"). Small enough not to
    // affect any normal boundary.
    const totalSec = Math.floor(t + 1e-6);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec - hh * 3600) / 60);
    const ss = totalSec - hh * 3600 - mm * 60;
    set('hudMet', 'T+ ' + String(hh).padStart(2, '0') + ':' +
      String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0'));

    // ---- Target orbit (constant per run) ----
    const GM = CONFIG.GM_EARTH;
    const targetAlt = getTargetAltKm();
    const targetVcirc = Math.sqrt(GM / (Re + targetAlt * 1000));

    // ---- Altitude: bidirectional apogee (left) / perigee (right) ----
    const E = 0.5 * (vr * vr + vt * vt) - GM / r;
    const hOrb = r * vt;
    let apo_km = null, peri_km = null;
    if (E < 0) {
      const a = -GM / (2 * E);
      const e = Math.sqrt(Math.max(0, 1 + 2 * E * hOrb * hOrb / (GM * GM)));
      apo_km = (a * (1 + e) - Re) / 1000;
      peri_km = (a * (1 - e) - Re) / 1000;
    } else {
      apo_km = Infinity;
      peri_km = -1;
    }
    const periClamped = Math.max(0, peri_km);
    const apoClamped  = Number.isFinite(apo_km) ? Math.max(0, apo_km) : 1e9;
    const altScale = Math.max(targetAlt * 1.20, apoClamped * 1.02, periClamped * 1.02);
    const apoFillPct  = Math.min(50, (apoClamped  / altScale) * 50);
    const periFillPct = Math.min(50, (periClamped / altScale) * 50);
    const altMarkPct  = (targetAlt / altScale) * 50;
    { const n = $('barAltL'); if (n) n.style.width = apoFillPct.toFixed(2) + '%'; }
    { const n = $('barAltR'); if (n) n.style.width = periFillPct.toFixed(2) + '%'; }
    { const n = $('tmarkAltL'); if (n) n.style.left = (50 - altMarkPct).toFixed(2) + '%'; }
    { const n = $('tmarkAltR'); if (n) n.style.left = (50 + altMarkPct).toFixed(2) + '%'; }
    set('hudApo',  Number.isFinite(apo_km) ? fx(apo_km, 1) : '∞');
    set('hudPeri', peri_km < 0 ? '0' : fx(peri_km, 1));
    set('hudAlt',  fx(alt, alt < 100 ? 1 : 0));

    // ---- Speed: fill toward target orbital speed, marker at target ----
    const speedScale = targetVcirc * 1.20;
    const speedFill  = Math.min(1, sp / speedScale);
    { const n = $('barVel'); if (n) n.style.width = (speedFill * 100).toFixed(2) + '%'; }
    { const n = $('tmarkVel'); if (n) n.style.left = (100 / 1.20).toFixed(2) + '%'; }
    set('hudVel', fx(sp, 0));

    // ---- Climb rate + horizontal speed (unchanged) ----
    set('hudVr', fx(vr, 0));   bar('barVr', Math.abs(vr) / 3000);
    set('hudVt', fx(vt, 0));   bar('barVt', Math.abs(vt) / 8000);

    // ---- Dynamic pressure: live value + peak label ----
    const qScale = Math.max(qMax * 1.10, 1);
    bar('barQ', q / qScale);
    set('hudQ', fx(q, 1));
    set('hudQPeak', qMax > 0.1 ? 'peak ' + qMax.toFixed(1) : '');

    // ---- Orbital energy: fill from sea-level ref toward target ----
    const eps = 0.5 * (vr * vr + vt * vt) - GM / r;
    // Pad reference: v=0 at surface → eps = -GM/Re, NOT -GM/(2Re).
    // (-GM/(2Re) is the circular-orbit energy at surface radius, which
    // is ~half as negative as the actual pad value and made the bar
    // stay at 0% through the entire ascent burn.)
    const epsSurface = -GM / Re;
    const epsTarget  = -GM / (2 * (Re + targetAlt * 1000));
    const epsRange = epsTarget - epsSurface;
    const energyFill = Math.max(0, Math.min(1, (eps - epsSurface) / (epsRange / 0.85)));
    { const n = $('barEnergy'); if (n) n.style.width = (energyFill * 100).toFixed(2) + '%'; }
    { const n = $('tmarkEnergy'); if (n) n.style.left = '85%'; }
    set('hudEnergy', (eps / 1e6).toFixed(2));

    try {
      const gs = (typeof Guidance !== 'undefined' && Guidance.getGuideStatus && Guidance.getGuideStatus()) || {};
      if (gs.phase && gs.phase !== curPhase) {
        curPhase = gs.phase;
        if (!phaseColors[curPhase]) phaseColors[curPhase] = PAL[Object.keys(phaseColors).length % PAL.length];
        phases.push({ n: curPhase, t0: t, c: phaseColors[curPhase] }); ribDirty = true;
        set('hudPhase', human(curPhase));
      }
    } catch (e) { /* guidance not ready */ }

    _updateTempRows();
    const now = performance.now();
    if (ribDirty || (body.classList.contains('is-running') && now - ribAt > 500)) { renderRibbon(t); ribAt = now; ribDirty = false; }
  }
  (function hudLoop() {
    let last = 0;
    (function tick(n) { requestAnimationFrame(tick); if (document.hidden || n - last < 100) return; last = n; try { readout(); } catch (e) { /* never break the page */ } })(0);
  })();

  /* ---------- Ignition flare + result verdict ---------- */
  const ig = document.createElement('div'); ig.id = 'ignite'; ig.innerHTML = '<span>Liftoff</span>'; body.appendChild(ig);
  function ignite() {
    if (reduce || visualsOff()) return;
    ig.classList.remove('on'); void ig.offsetWidth; ig.classList.add('on');
    const d = $('deck'); if (d) { d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }
  }
  if (sb) sb.addEventListener('click', () => { if (!sb.disabled) { resetFlight(); renderRibbon(0); ignite(); } });
  const clr = $('clearPlotsBtn'); if (clr) clr.addEventListener('click', () => { resetFlight(); renderRibbon(0); });

  function showVerdict(label, tone) {
    if (reduce || visualsOff()) return;
    const v = $('verdict'); if (!v) return;
    const num = (id) => { const n = $(id); const x = n && n.querySelector('.kv-num'); return x ? x.textContent.trim() : '—'; };
    const apo = num('kApo'), peri = num('kPeri'), fuel = num('kFuel');
    set('vBig', label);
    set('vSub', apo !== '—' ? 'Apogee ' + apo + ' km, perigee ' + peri + ' km, ' + fuel + ' t fuel left' : '');
    v.className = 'verdict'; void v.offsetWidth; v.className = 'verdict show ' + (tone || '');
  }

  /* ---------- Run state, elapsed timer, progress ---------- */
  let t0 = 0, timer = 0;
  const pill = $('monState'), el = $('monElapsed');
  function setRunning(on) {
    if (body.classList.contains('is-running') === on) return;
    body.classList.toggle('is-running', on);
    if (pill) pill.textContent = on ? 'RUNNING' : 'IDLE';
    clearInterval(timer);
    if (on) {
      t0 = performance.now();
      timer = setInterval(() => { const s = ((performance.now() - t0) / 1000).toFixed(1) + 's'; if (el) el.textContent = s; dRun.textContent = 'Running ' + s; }, 200);
    } else { dRun.textContent = 'Run'; ribDirty = true; }
    syncDock();
  }
  if (sb) new MutationObserver(() => setRunning(sb.disabled)).observe(sb, { attributes: true, attributeFilter: ['disabled'] });
  const pfill = $('progressFill');
  if (pfill) new MutationObserver(() => { const p = $('monProg'); if (p) p.textContent = pfill.style.width || '0%'; }).observe(pfill, { attributes: true, attributeFilter: ['style'] });

  /* ---------- Result ledger synced from the run summary ---------- */
  function setKpi(id, val, tone) {
    const k = $(id); if (!k) return;
    const v = k.querySelector('.kv-num'); if (!v || v.textContent === String(val)) return;
    v.textContent = val; k.classList.remove('flash', 'bad', 'good'); void k.offsetWidth; k.classList.add('flash');
    if (tone) k.classList.add(tone);
  }
  const sum = $('summaryBody');
  function syncSummary() {
    const m = {};
    sum.querySelectorAll(':scope > span').forEach((s) => { const k = s.querySelector('.k'), v = s.querySelector('.v'); if (k && v) m[k.textContent.trim()] = v.textContent.trim(); });
    if (!Object.keys(m).length) return;
    setKpi('kPhase', m['final phase'] || '—', m['crashed'] === 'YES' ? 'bad' : (m['circ achieved'] === 'YES' ? 'good' : ''));
    setKpi('kApo', m['final apogee (km)'] || '—'); setKpi('kPeri', m['final perigee (km)'] || '—');
    setKpi('kQ', m['peak Q (kPa)'] || '—'); setKpi('kG', m['peak G'] || '—'); setKpi('kFuel', m['fuel left (t)'] || '—');
    if (m['ticks/s']) setKpi('kTps', m['ticks/s']);
    const bad = m['crashed'] === 'YES', ok = m['circ achieved'] === 'YES', landed = m['landed'] === 'YES';
    setKpi('kOutcome', bad ? 'CRASHED' : ok ? 'ORBIT ✓' : landed ? 'LANDED' : 'DONE', bad ? 'bad' : ok ? 'good' : '');

    // Sync HUD phase label to the run's final phase. Guidance is stopped
    // by the time the summary fires, so the readout loop can never see the
    // last transition (e.g. COAST_HOLD_2 -> DONE) on its own -- it freezes
    // on whatever phase was last visible while the guide was still active.
    const finalPhase = m['final phase'];
    if (finalPhase && finalPhase !== '—' && finalPhase !== curPhase) {
      curPhase = finalPhase;
      if (!phaseColors[curPhase]) phaseColors[curPhase] = PAL[Object.keys(phaseColors).length % PAL.length];
      const endT = (typeof state !== 'undefined' && state && Number.isFinite(state.simTime)) ? state.simTime : 0;
      phases.push({ n: curPhase, t0: endT, c: phaseColors[curPhase] });
      ribDirty = true;
      set('hudPhase', human(curPhase));
      renderRibbon(endT);
    }

    showVerdict(bad ? 'Vehicle lost' : ok ? 'Orbit achieved' : landed ? 'Landed' : 'Run complete', bad ? 'bad' : ok ? 'good' : '');
  }
  if (sum) new MutationObserver(syncSummary).observe(sum, { childList: true });

  /* ---------- Monitors: FPS, heap, clock ---------- */
  (function monitors() {
    const fps = $('monFps'), mem = $('monMem'), clk = $('monClock'); let f = 0, t = performance.now();
    (function tick() {
      f++; const n = performance.now();
      if (n - t >= 1000) {
        if (fps) fps.textContent = Math.round(f * 1000 / (n - t)); f = 0; t = n;
        if (mem) mem.textContent = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a';
      }
      requestAnimationFrame(tick);
    })();
    const clock = () => { if (clk) clk.textContent = new Date().toLocaleTimeString([], { hour12: false }); };
    clock(); setInterval(clock, 1000);
  })();

  /* ---------- Shortcuts ---------- */
  document.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && sb && !sb.disabled) sb.click();
    if (e.key === 'Escape') { if (stopB && !stopB.disabled) stopB.click(); body.classList.remove('nav-open'); }
  });
})();
