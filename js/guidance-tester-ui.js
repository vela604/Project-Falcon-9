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

  /* ---------- Build the flight deck (hero) ---------- */
  (function buildDeck() {
    const pane = $('paneTele'); if (!pane) return;
    const card = pane.querySelector('.plot-card.main');
    const cell = (label, id, unit, bar) => '<div class="cell"><span class="lbl">' + label + '</span><span class="val"><b id="' + id + '">–</b><i>' + unit + '</i></span><span class="bar"><span id="' + bar + '"></span></span></div>';
    const deck = document.createElement('section'); deck.className = 'deck'; deck.id = 'deck';
    const view = document.createElement('div'); view.className = 'deck-view';
    if (card) view.appendChild(card);
    view.insertAdjacentHTML('beforeend', '<div class="verdict" id="verdict" aria-live="polite"><div><span class="v-big" id="vBig"></span><span class="v-sub" id="vSub"></span></div></div>');
    const read = document.createElement('div'); read.className = 'deck-read';
    read.innerHTML =
      '<div class="met"><span class="lbl">Mission time</span><span class="met-val" id="hudMet">T+ 00:00.0</span></div>' +
      '<div class="phase"><span class="lbl">Flight phase</span><b id="hudPhase">Standing by</b></div>' +
      '<div class="inst">' +
      cell('Altitude', 'hudAlt', 'km', 'barAlt') + cell('Speed', 'hudVel', 'm/s', 'barVel') +
      cell('Climb rate', 'hudVr', 'm/s', 'barVr') + cell('Horizontal speed', 'hudVt', 'm/s', 'barVt') +
      cell('Dynamic pressure', 'hudQ', 'kPa', 'barQ') + cell('Mass', 'hudMass', 't', 'barMass') +
      '</div>';
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
    const m = (b._geomCache && Number.isFinite(b._geomCache.M)) ? b._geomCache.M / 1000 : 0;
    if (m > massMax) massMax = m;
    skyTarget = Math.max(0, alt);

    const mm = Math.floor(t / 60), ss = t - mm * 60;
    set('hudMet', 'T+ ' + String(mm).padStart(2, '0') + ':' + (ss < 10 ? '0' : '') + ss.toFixed(1));
    set('hudAlt', fx(alt, alt < 100 ? 1 : 0)); bar('barAlt', alt / 200);
    set('hudVel', fx(sp, 0));  bar('barVel', sp / 8000);
    set('hudVr', fx(vr, 0));   bar('barVr', Math.abs(vr) / 3000);
    set('hudVt', fx(vt, 0));   bar('barVt', Math.abs(vt) / 8000);
    set('hudQ', fx(q, 1));     bar('barQ', q / 40);
    set('hudMass', fx(m, 1));  bar('barMass', massMax > 0 ? m / massMax : 0);

    try {
      const gs = (typeof Guidance !== 'undefined' && Guidance.getGuideStatus && Guidance.getGuideStatus()) || {};
      if (gs.phase && gs.phase !== curPhase) {
        curPhase = gs.phase;
        if (!phaseColors[curPhase]) phaseColors[curPhase] = PAL[Object.keys(phaseColors).length % PAL.length];
        phases.push({ n: curPhase, t0: t, c: phaseColors[curPhase] }); ribDirty = true;
        set('hudPhase', human(curPhase));
      }
    } catch (e) { /* guidance not ready */ }

    if (q > qMax) qMax = q;
    else if (!maxQDone && qMax > 3 && q < qMax * .92) { maxQDone = true; toast('Max Q passed at T+' + t.toFixed(1) + ' s, ' + qMax.toFixed(1) + ' kPa'); }

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
