/* Guidance Tester — UI/FX layer. Touches only presentation; sim logic stays in the HTML. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Ambient starfield (light: ~70 dots, 30fps, pauses when hidden or running) ---------- */
  (function fx() {
    const c = $('fxCanvas'); if (!c || reduce) return;
    const g = c.getContext('2d'); let w, h, dpr = 1, stars = [], last = 0;
    const size = () => { dpr = Math.min(devicePixelRatio || 1, 1.5); w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr; };
    const cols = ['53,214,255', '167,139,250', '255,146,72'];
    size(); addEventListener('resize', size);
    for (let i = 0; i < 70; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + .3, s: Math.random() * .00006 + .00002, c: cols[i % 3], p: Math.random() * 6 });
    function frame(t) {
      requestAnimationFrame(frame);
      if (document.hidden || t - last < 33) return; last = t;
      g.clearRect(0, 0, w, h);
      const slow = document.body.classList.contains('is-running') ? .35 : 1;
      for (const s of stars) {
        s.y -= s.s * slow * 33; if (s.y < 0) { s.y = 1; s.x = Math.random(); }
        const a = .25 + .35 * Math.sin(t / 900 + s.p);
        g.fillStyle = `rgba(${s.c},${a})`; g.beginPath(); g.arc(s.x * w, s.y * h, s.r * dpr, 0, 6.283); g.fill();
      }
    }
    requestAnimationFrame(frame);
  })();

  /* ---------- Button ripple ---------- */
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) / 2;
    const s = document.createElement('span'); s.className = 'ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  });

  /* ---------- Tabs + mobile drawer ---------- */
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === t.dataset.pane));
    window.dispatchEvent(new Event('resize'));
  }));
  const mb = $('menuBtn');
  if (mb) mb.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.addEventListener('click', (e) => { if (document.body.classList.contains('nav-open') && !e.target.closest('#sidebar,#menuBtn')) document.body.classList.remove('nav-open'); });

  /* ---------- Toasts ---------- */
  function toast(msg) {
    const host = $('toasts'); if (!host) return;
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; host.appendChild(t);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3200);
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

  /* ---------- Run state, elapsed timer, progress ---------- */
  let t0 = 0, timer = 0;
  const pill = $('monState'), el = $('monElapsed'), pbar = $('progressBar'), pfill = $('progressFill');
  function setRunning(on) {
    if (document.body.classList.contains('is-running') === on) return;
    document.body.classList.toggle('is-running', on);
    if (pill) pill.textContent = on ? 'RUNNING' : 'IDLE';
    clearInterval(timer);
    if (on) { t0 = performance.now(); timer = setInterval(() => { el.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's'; }, 200); }
  }
  const sb = $('startBtn');
  if (sb) new MutationObserver(() => setRunning(sb.disabled)).observe(sb, { attributes: true, attributeFilter: ['disabled'] });
  if (pfill) new MutationObserver(() => { const p = $('monProg'); if (p) p.textContent = pfill.style.width || '0%'; }).observe(pfill, { attributes: true, attributeFilter: ['style'] });

  /* ---------- KPI cards synced from the run summary ---------- */
  function setKpi(id, val, tone) {
    const k = $(id); if (!k) return;
    const v = k.querySelector('.kv-num'); if (!v || v.textContent === String(val)) return;
    v.textContent = val; k.classList.remove('flash', 'bad', 'good'); void k.offsetWidth; k.classList.add('flash');
    if (tone) k.classList.add(tone);
  }
  const sum = $('summaryBody');
  function syncSummary() {
    const m = {}; sum.querySelectorAll(':scope > span').forEach((s) => { const k = s.querySelector('.k'), v = s.querySelector('.v'); if (k && v) m[k.textContent.trim()] = v.textContent.trim(); });
    if (!Object.keys(m).length) return;
    setKpi('kPhase', m['final phase'] || '—', m['crashed'] === 'YES' ? 'bad' : (m['circ achieved'] === 'YES' ? 'good' : ''));
    setKpi('kApo', m['final apogee (km)'] || '—'); setKpi('kPeri', m['final perigee (km)'] || '—');
    setKpi('kQ', m['peak Q (kPa)'] || '—'); setKpi('kG', m['peak G'] || '—'); setKpi('kFuel', m['fuel left (t)'] || '—');
    if (m['ticks/s']) setKpi('kTps', m['ticks/s']);
    const out = $('kOutcome'); if (out) { const bad = m['crashed'] === 'YES'; const ok = m['circ achieved'] === 'YES';
      setKpi('kOutcome', bad ? 'CRASHED' : ok ? 'ORBIT ✓' : m['landed'] === 'YES' ? 'LANDED' : 'DONE', bad ? 'bad' : ok ? 'good' : ''); }
  }
  if (sum) new MutationObserver(syncSummary).observe(sum, { childList: true });

  /* ---------- Monitors: FPS, heap, clock ---------- */
  (function monitors() {
    const fps = $('monFps'), mem = $('monMem'), clk = $('monClock'); let f = 0, t = performance.now();
    (function tick() { f++; const n = performance.now(); if (n - t >= 1000) { if (fps) fps.textContent = Math.round(f * 1000 / (n - t)); f = 0; t = n;
      if (mem) mem.textContent = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a'; }
      requestAnimationFrame(tick); })();
    const clock = () => { if (clk) clk.textContent = new Date().toLocaleTimeString([], { hour12: false }); };
    clock(); setInterval(clock, 1000);
  })();

  /* ---------- Stack label chip, scroll reveal, shortcuts ---------- */
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .08 });
    document.querySelectorAll('.reveal').forEach((n) => io.observe(n));
  } else document.querySelectorAll('.reveal').forEach((n) => n.classList.add('in'));
  document.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && sb && !sb.disabled) sb.click();
    if (e.key === 'Escape') { const s = $('stopBtn'); if (s && !s.disabled) s.click(); document.body.classList.remove('nav-open'); }
  });
})();
