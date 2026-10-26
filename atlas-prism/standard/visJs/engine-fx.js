/* ==========================================================================
   ENGINE FX — visuals only. Event-driven (MutationObserver): no timers, no rAF loops.
   Reads the DOM the engine already renders; never calls engine code or touches workers.
   Page works without this file; it only adds: log colours + level gutter, status chips,
   telemetry (run strip, worker boxes, phase cells), keyboard shortcuts, title font. Every hook is optional.
   Worker boxes: observes TunerCore.WorkerPool (prototype wrappers that only READ and then call the original).
   ========================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  body.classList.add('fx');
  // optional page hooks: window.FXHooks = { logTags:[], onProgress(msg), onReset(), tm:{ phaseKey:{ labels:[4], values(ctx)->[4] } }, describe(job, parts) }
  var HK = window.FXHooks || {};
  var EXTRA_TAGS = (HK.logTags && HK.logTags.length) ? HK.logTags.join('|') + '|' : '';
  var T = { evals: 0, evalTs: [], lead: '—', margin: '—' };          // per-phase counters (reset on tab change)
  var W = { pool: null, n: 0, slots: [], rate: 0, evalRate: 0, last: 0, lastT: 0, timer: 0, ran: false, raf: 0, active: false, t0: 0, t1: 0 };

  // title font (user's szadFont.js, wordmark only). Safe if the file is absent.
  try { if (typeof loadSzadFont === 'function') loadSzadFont(); } catch (e) {}

  /* ---------- 1. log: level + token colours ---------- */
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  // one pass, so inserted tags / entities are never re-matched
  var TOK = new RegExp([
    '(&#?\\w+;)',                                                                   // 1 entity: skip
    '(^\\[\\d\\d:\\d\\d:\\d\\d\\])',                                                // 2 timestamp
    '(' + EXTRA_TAGS + 'ZETA\\[batch \\d+\\]|OPT-MECO|FIND RANGE|CONVO-LEAD|CONVO|ZETA|setupSA|PHASE [A-D]|bootstrap)', // 3 phase tag
    '([A-Za-z_][A-Za-z_0-9]*)(?==)',                                                // 4 key=
    '(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)',                                          // 5 number
    '(✓|\\bok\\b|\\bready\\b|\\bdone\\b|\\bcomplete\\b|\\bverified\\b)',            // 6 good
    '(✗|\\bfail\\w*|\\berror\\w*|\\bexception\\b)'                                  // 7 bad
  ].join('|'), 'gi');
  function hl(raw) {
    return esc(raw).replace(TOK, function (m, ent, ts, tag, key, num, good, bad) {
      if (ent) return m;
      if (ts) return '<i class="lg-t">' + m + '</i>';
      if (tag) return '<i class="lg-tag">' + m + '</i>';
      if (key) return '<i class="lg-k">' + m + '</i>';
      if (good) return '<i class="lg-ok">' + m + '</i>';
      if (bad) return '<i class="lg-bad">' + m + '</i>';
      return '<i class="lg-n">' + m + '</i>';
    });
  }
  function level(raw) {
    if (/^\[[\d:]+\]\s+(---|PHASE [A-D])/i.test(raw)) return 'lv-sec';
    if (/✗|\bfail|error|exception|all failed/i.test(raw) && !/\b0 fail/i.test(raw)) return 'lv-err';
    if (/warn|rescue|retry|unverified|refresh/i.test(raw)) return 'lv-warn';
    if (/\bdone\b|\bready\b|complete|✓|\bok\b|verified|LOCKED/i.test(raw)) return 'lv-ok';
    return '';
  }
  var logEl = $('logFeed'), logQueued = false, logObs = null;
  function paintLog() {
    logQueued = false;
    if (!logEl) return;
    if (logObs) logObs.disconnect();
    var kids = logEl.children, workers = null;
    for (var i = 0; i < kids.length; i++) {
      var d = kids[i];
      if (d.getAttribute('data-h')) continue;
      var raw = d.textContent, lv = level(raw);
      if (lv) d.className = lv;
      d.innerHTML = hl(raw);
      d.setAttribute('data-h', '1');
      var m = /pool ready \((\d+) workers?\)/.exec(raw);
      if (m) workers = m[1];
      var c = /CONVO OK: lead=(\S+) margin=(\S+)/.exec(raw);
      if (c) { T.lead = c[1]; T.margin = c[2] + 's'; requestPaint(); }
    }
    if (workers) setText('stWorkersN', workers);
    if (logObs) logObs.observe(logEl, { childList: true });
  }
  if (logEl) {
    logObs = new MutationObserver(function () {
      if (!logQueued) { logQueued = true; requestAnimationFrame(paintLog); }
    });
    logObs.observe(logEl, { childList: true });
    paintLog();
  }

  function setText(id, v) { var el = $(id); if (el && el.textContent !== v) el.textContent = v; }

  /* ---------- 2. status chips ---------- */
  var main = $('main'), prog = $('progressBar');
  var PHASE = { optmeco: 'OPT-MECO', zeta: 'ZETA-HELIX', convo: 'CONVO-LEAD' };
  var baseTitle = document.title;
  function setState() {
    var locked = main && main.style.display !== 'none';
    var running = !!(locked && prog && prog.firstElementChild && !prog.firstElementChild.classList.contains('dim'));
    var st = !locked ? 'idle' : running ? 'running' : 'ready';
    if (body.getAttribute('data-state') !== st) {
      body.setAttribute('data-state', st);
      setText('stStateN', st);
      document.title = running ? '▶ ' + baseTitle : baseTitle;
      setText('tmFlag', running ? 'WAIT' : st === 'ready' ? 'READY' : 'IDLE');
    }
  }
  function setPhase() {
    var a = document.querySelector('.big-tab.active');
    var k = a ? a.getAttribute('data-tab') : '';
    setText('stPhaseN', a ? (PHASE[k] || '—') : '—');
    setText('tmPhaseLbl', ({ optmeco: 'meco', zeta: 'zeta', convo: 'convo' }[k] || 'run') + ' elapsed');
    if (k !== phaseKey) { phaseKey = k; T.evals = 0; T.evalTs = []; T.lead = '—'; T.margin = '—'; if (HK.onReset) { try { HK.onReset(); } catch (x) {} } }
    requestPaint();
  }
  var phaseKey = '';

  /* ---------- 3. telemetry: run strip (elapsed · ops/s · total ops) + phase cells ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtBig(n) {   // 1.2K · 3.45M · 12.3B · 1.00T
    if (!isFinite(n) || n < 0) return '—';
    var U = [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]];
    for (var i = 0; i < U.length; i++) if (n >= U[i][1]) {
      var v = n / U[i][1];
      return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + U[i][0];
    }
    return String(Math.round(n));
  }
  function setHTML(id, v) { var el = $(id); if (el && el.getAttribute('data-v') !== v) { el.setAttribute('data-v', v); el.innerHTML = v; } }
  function tmElapsed() {
    var m = /elapsed (\d+)s/.exec(prog ? prog.textContent : '');
    if (!m) return;
    var s = +m[1];
    setText('tmElapsed', pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60));
  }
  function onProg() { setState(); tmElapsed(); checkFinal(); }

  function totalSim() { var t = 0; for (var i = 0; i < W.slots.length; i++) t += W.slots[i].sim; return t; }
  function fmtDur(sec) {
    if (!isFinite(sec)) return '—';
    if (sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + 's';
    var m = Math.floor(sec / 60), sc = Math.floor(sec % 60);
    if (m < 60) return m + 'm ' + pad(sc) + 's';
    var h = Math.floor(m / 60); m %= 60;
    if (h < 24) return h + 'h ' + pad(m) + 'm';
    return Math.floor(h / 24) + 'd ' + pad(h % 24) + 'h';
  }
  function busyCount() { var c = 0; for (var i = 0; i < W.slots.length; i++) if (W.slots[i].state === 'busy' || W.slots[i].state === 'setup') c++; return c; }
  function totalTicks() { var t = 0; for (var i = 0; i < W.slots.length; i++) t += W.slots[i].ticks; return t; }

  var PHASE_TM = {
    optmeco: ['evals done', 'queued', 'evals / s', 'workers busy'],
    zeta:    ['zeta rows', 'best score', 'batches', 'workers busy'],
    convo:   ['probes done', 'lead', 'margin', 'workers busy']
  };
  function paintTm() {
    var k = PHASE_TM[phaseKey] ? phaseKey : 'zeta', L = PHASE_TM[k], v;
    var rs = ($('runStats') || {}).textContent || '';
    var mr = /(\d+) rows/.exec(rs), mb = /(\d+) batches/.exec(rs);
    var bt = document.querySelector('#tableHost tr.best td:nth-child(7)');
    var busy = W.slots.length ? busyCount() + ' / ' + W.n : '—';
    var q = W.pool && W.pool.queue ? W.pool.queue.length : 0;
    if (k === 'optmeco') v = [T.evals, q, W.evalRate.toFixed(2), busy];
    else if (k === 'zeta') v = [mr ? mr[1] : '0', bt ? bt.textContent : '—', mb ? mb[1] : '0', busy];
    else v = [T.evals, T.lead, T.margin, busy];
    if (HK.tm && HK.tm[k]) { try { var hv = HK.tm[k].values({ busy: busy, evals: T.evals }); L = HK.tm[k].labels; v = hv; } catch (x) {} }
    for (var i = 0; i < 4; i++) { setText('tmL' + (i + 1), L[i]); setText('tmV' + (i + 1), String(v[i])); }
  }

  /* ---------- 3b. worker boxes (read-only observer on TunerCore.WorkerPool) ---------- */
  var JL = { setupSA: 'SETUP-SA', probeBiasCheckpoint: 'PROBE', saRun: 'SA-RUN', runEval: 'EVAL', runEvalValues: 'EVAL',
             tuneLead: 'TUNE-LEAD', ladderBuild: 'LADDER', ladderGet: 'LADDER', runScratch: 'SCRATCH', runFromSnap: 'RESUME',
             verifyChain: 'VERIFY', ping: 'PING' };
  var EVAL_T = { runEval: 1, runEvalValues: 1, saRun: 1, probeBiasCheckpoint: 1, tuneLead: 1 };
  var ST = { boot: 'BOOT', ready: 'READY', setup: 'SETUP', busy: 'BUSY', idle: 'IDLE', fail: 'FAIL' };
  function num(x) { var v = +x; return isFinite(v) ? String(+v.toPrecision(5)) : String(x); }
  function describe(job) {
    var p = job.payload || {}, pt = p.point || {}, a = [];
    if (job.type === 'saRun') a.push(p.build ? 'build checkpoint' : 'resume checkpoint');
    if (pt.meco != null) a.push('MECO ' + Math.round(pt.meco));
    if (pt.Gi != null) a.push('G ' + num(pt.Gi));
    if (pt.Tn != null) a.push('T ' + num(pt.Tn));
    if (p.bias != null) a.push('bias ' + (+p.bias).toFixed(4));
    if (HK.describe) { try { HK.describe(job, a); } catch (x) {} }
    return a.join(' · ') || job.type;
  }
  function newSlot() { return { state: 'boot', job: '', desc: '', detail: '', dts: 0, t0: 0, done: 0, ticks: 0, sim: 0, busyMs: 0, share: 0, res: false, el: null, c: {}, p: {}, bench: null }; }

  function attach(pool) {
    W.pool = pool; W.n = pool.n || (pool.workers && pool.workers.length) || 0;
    W.slots = []; W.ran = false; W.active = false; W.t0 = W.t1 = 0; W.rate = 0; W.evalRate = 0; W.last = 0; W.lastT = Date.now();
    T.evals = 0; T.evalTs = [];
    var grid = $('wkGrid'); if (!grid) return;
    grid.innerHTML = '';
    grid.className = 'wkgrid' + (W.n > 12 ? ' dense' : '');
    for (var i = 0; i < W.n; i++) {
      var s = newSlot(), el = document.createElement('div');
      el.className = 'wk s-boot';
      el.innerHTML = '<div class="h"><b>W' + pad(i + 1) + '</b><em></em><u>BOOT</u></div><div class="d"></div><div class="n"></div>';
      s.el = el; s.r = { em: el.children[0].children[1], u: el.children[0].children[2], d: el.children[1], n: el.children[2] };
      grid.appendChild(el); W.slots.push(s);
    }
    requestPaint();
  }
  function detach() { W.pool = null; W.active = false; W.slots = []; W.n = 0; W.rate = 0; var g = $('wkGrid'); if (g) g.innerHTML = ''; stopTimer(); requestPaint(); }

  function obsMsg(pool, i, msg) {
    if (pool !== W.pool) return;
    var s = W.slots[i]; if (!s) return;
    if (msg.type === 'progress') { s.detail = String(msg.detail == null ? '' : msg.detail); s.dts = Date.now(); if (HK.onProgress) { try { HK.onProgress(msg); } catch (x) {} } }
    else if (msg.type === 'ops') { s.ticks += +msg.n || 0; s.sim += +msg.s || 0; }
    else if (msg.type === 'prof') {   // telemetry from worker-sim.js (timers + bench); read-only
      if (msg.d) for (var pk in msg.d) s.p[pk] = (s.p[pk] || 0) + (+msg.d[pk] || 0);
      if (msg.bench) s.bench = msg.bench;
    }
    else if (msg.type === 'ready') { s.state = msg.error ? 'fail' : 'ready'; if (msg.error) s.desc = String(msg.error); }
    else if (msg.id != null) {   // job finished (the pool has not removed it from pending yet)
      var job = pool.pending && pool.pending.get(msg.id);
      s.done++; s.detail = ''; s.state = W.ran ? 'idle' : 'ready';
      if (W.active && s.t0) s.busyMs += Date.now() - s.t0;
      if (job && EVAL_T[job.type]) { T.evals++; T.evalTs.push(Date.now()); }
      if (job) s.desc = 'last: ' + (JL[job.type] || job.type) + (msg.ok === false ? ' (failed)' : '');
      s.job = '';
    } else return;
    if (msg.id != null) checkFinal();
    requestPaint();
  }
  function runBtnBusy() { return ['oRun', 'zRun', 'cRun'].some(function (id) { var b = $(id); return !!(b && b.disabled); }); }
  /* a run starts when work is dispatched while an engine's Run button is disabled (lock warm-up is not a run) */
  function startRun() {
    W.active = true; W.t0 = Date.now(); W.t1 = 0; W.rate = 0; W.evalRate = 0; W.last = 0; W.lastT = W.t0;
    T.evals = 0; T.evalTs = []; if (HK.onReset) { try { HK.onReset(); } catch (x) {} }
    for (var i = 0; i < W.slots.length; i++) { var s = W.slots[i]; s.ticks = 0; s.sim = 0; s.done = 0; s.busyMs = 0; s.share = 0; s.res = false; s.p = {}; }
    var sm = $('wkSum'); if (sm) sm.textContent = '';
  }
  /* run is over when the Run button is enabled again and every worker is idle -> freeze result */
  function med(a) { a = a.filter(isFinite).sort(function (x, y) { return x - y; }); return a.length ? a[a.length >> 1] : NaN; }
  function f1(x, d) { return isFinite(x) ? x.toFixed(d) : '—'; }
  /* PROF line: where worker busy time goes (restore / capture / prepare / rest = ticks + polling), per-section us/tick, bench per worker */
  function profLine() {
    var S = {}, busy = 0, i, k, any = false;
    for (i = 0; i < W.slots.length; i++) {
      var s = W.slots[i]; busy += s.busyMs;
      for (k in s.p) { S[k] = (S[k] || 0) + s.p[k]; any = true; }
    }
    var out = '';
    if (any && busy > 0) {
      var pc = function (v) { return '<b>' + f1((v || 0) / busy * 100, 0) + '%</b>'; };
      var rest = busy - (S.restore || 0) - (S.capture || 0) - (S.prep || 0);
      out += '<br><span class="k">PROF</span>of busy: restore ' + pc(S.restore) + ' · capture ' + pc(S.capture) + ' · prepare ' + pc(S.prep) + ' · rest (ticks+polling) ' + pc(rest);
      var us = function (ms, t) { return t > 0 ? '<b>' + f1(ms * 1000 / t, 0) + '</b>' : '—'; };
      if (S.chT || S.circT || S.fullT) out += '<br>µs/tick: coast ' + us(S.ch, S.chT) + ' (' + fmtBig(S.chT || 0) + ' ticks) · circ-eval ' + us(S.circ, S.circT) + ' (' + fmtBig(S.circT || 0) + ') · full ' + us(S.full, S.fullT) + ' (' + fmtBig(S.fullT || 0) + ')';
    }
    var bs = [], tk = [], tg = [], gs = [], cp = [], rs = [], kb = [];
    for (i = 0; i < W.slots.length; i++) { var b = W.slots[i].bench; if (!b || b.err) continue; bs.push(b); tk.push(b.tickUs); tg.push(b.tickGsUs); gs.push(b.gsUs); cp.push(b.capMs); rs.push(b.resMs); kb.push(b.snapKB); }
    if (bs.length) {
      var mn = Math.min.apply(null, tk), mx = Math.max.apply(null, tk);
      out += '<br>bench (' + bs.length + ' workers, median): tick <b>' + f1(med(tk), 0) + 'µs</b> (min ' + f1(mn, 0) + ' · max ' + f1(mx, 0) + ') · tick+getGuideStatus <b>' + f1(med(tg), 0) + 'µs</b> · getGuideStatus <b>' + f1(med(gs), 1) + 'µs</b> · capture <b>' + f1(med(cp), 1) + 'ms</b> · restore <b>' + f1(med(rs), 1) + 'ms</b> · snap <b>' + f1(med(kb), 0) + 'KB</b>';
    }
    return out;
  }
  function checkFinal() {
    var p = W.pool; if (!W.active || !p || runBtnBusy() || busyCount()) return;
    if ((p.pending && p.pending.size) || (p.queue && p.queue.length)) return;
    W.active = false; W.t1 = Date.now(); W.rate = 0; W.evalRate = 0; stopTimer();
    var tot = totalTicks(), avg = W.n ? tot / W.n : 0;
    for (var i = 0; i < W.slots.length; i++) { var s = W.slots[i]; s.share = avg ? s.ticks / avg * 100 : 0; s.res = tot > 0; if (s.state !== 'fail') s.state = 'idle'; }
    if (tot > 0) {
      var wall = Math.max(0.001, (W.t1 - W.t0) / 1000), sim = totalSim();
      var el = $('wkSum');
      if (el) el.innerHTML = '<span class="k">RESULT</span>total <b>' + fmtBig(tot) + '</b> ops · avg <b>' + fmtBig(avg) +
        '</b> ops/worker · avg speed <b>' + fmtBig(avg / wall) + '</b> ops/s/worker (<b>' + fmtBig(tot / wall) + '</b> total) · wall <b>' + fmtDur(wall) +
        '</b> · sim <b>' + fmtDur(sim) + '</b> (<b>×' + fmtBig(sim / wall) + '</b>)' + profLine();
    }
    requestPaint();
  }
  function obsDispatch(pool, avBefore, pendBefore) {
    if (pool !== W.pool) return;
    if (!W.active && runBtnBusy()) startRun();
    var took = avBefore.filter(function (x) { return pool.available.indexOf(x) < 0; }), k = 0;
    pool.pending.forEach(function (job, id) {
      if (pendBefore.has(id)) return;
      var s = W.slots[took[k++]]; if (!s) return;
      var setup = job.type === 'setupSA';
      s.state = setup ? 'setup' : 'busy'; s.job = JL[job.type] || job.type; s.desc = describe(job); s.detail = ''; s.t0 = Date.now();
      if (!setup) W.ran = true;
      s.res = false;
    });
    ensureTimer(); requestPaint();
  }
  function hookPool() {
    var WP = window.TunerCore && window.TunerCore.WorkerPool;
    if (!WP || WP.prototype.__fx) return !!WP;
    var P = WP.prototype, oInit = P._init, oMsg = P._onMessage, oDisp = P._dispatch, oTerm = P.terminate;
    P.__fx = 1;
    if (oInit) P._init = function () { var r = oInit.apply(this, arguments); try { attach(this); } catch (e) {} return r; };
    if (oMsg) P._onMessage = function (i, e) { try { obsMsg(this, i, (e && e.data) || {}); } catch (x) {} return oMsg.apply(this, arguments); };
    if (oDisp) P._dispatch = function () {
      var av = [], pk = null;
      try { av = this.available.slice(); pk = new Set(this.pending.keys()); } catch (x) {}
      var r = oDisp.apply(this, arguments);
      try { if (pk) obsDispatch(this, av, pk); } catch (x) {}
      return r;
    };
    if (oTerm) P.terminate = function () { var me = this; try { if (me === W.pool) detach(); } catch (x) {} return oTerm.apply(this, arguments); };
    return true;
  }
  if (!hookPool()) window.addEventListener('load', hookPool);

  /* paint: coalesced to one rAF; the 1 s timer exists only while workers are busy */
  function requestPaint() { if (!W.raf) W.raf = requestAnimationFrame(paintAll); }
  function paintAll() {
    W.raf = 0;
    var now = Date.now();
    for (var i = 0; i < W.slots.length; i++) {
      var s = W.slots[i], st = s.state, c = s.c, r = s.r, d;
      if (c.st !== st) { c.st = st; r.u.textContent = ST[st] || st; }
      var cls = 'wk s-' + st + (s.res ? ' s-done ' + (s.share >= 90 ? 'r-a' : s.share >= 60 ? 'r-b' : 'r-c') : '');
      if (c.cls !== cls) { c.cls = cls; s.el.className = cls; }
      var fill = s.res ? Math.min(100, s.share).toFixed(0) + '%' : '';
      if (c.fill !== fill) { c.fill = fill; if (fill) s.el.style.setProperty('--fill', fill); else s.el.style.removeProperty('--fill'); }
      var em = (st === 'busy' || st === 'setup') ? s.job : '';
      if (c.em !== em) { c.em = em; r.em.textContent = em; }
      if (st === 'busy' || st === 'setup') {
        d = (s.dts >= s.t0 && s.detail ? s.detail : s.desc) + ' · ' + Math.floor((now - s.t0) / 1000) + 's';
      } else if (s.res) d = s.share.toFixed(0) + '% of avg';
      else d = st === 'ready' ? 'awaiting job' : st === 'boot' ? 'starting sim…' : (s.desc || '');
      if (c.d !== d) { c.d = d; r.d.textContent = d; }
      var n = s.res ? fmtBig(s.ticks) + ' ops · ' + fmtBig(s.busyMs ? s.ticks / (s.busyMs / 1000) : 0) + '/s' : 'jobs ' + s.done + ' · ' + fmtBig(s.ticks) + ' ops';
      if (c.n !== n) { c.n = n; r.n.textContent = n; }
    }
    var tot = totalTicks();
    setHTML('tmOps', fmtBig(W.rate) + '<small>ops/s</small>');
    setHTML('tmTotal', fmtBig(tot) + '<small>ops</small>');
    var simT = totalSim(), wall = W.t0 ? ((W.t1 || now) - W.t0) / 1000 : 0;
    setHTML('tmSim', simT > 0 ? fmtDur(simT) + (wall > 0.5 ? '<small class="x">×' + fmtBig(simT / wall) + '</small>' : '') : '—');
    paintTm();
  }
  function tick() {
    var now = Date.now(), tot = totalTicks(), dt = (now - W.lastT) / 1000;
    if (dt > 0) W.rate = Math.max(0, (tot - W.last) / dt);
    W.last = tot; W.lastT = now;
    while (T.evalTs.length && now - T.evalTs[0] > 10000) T.evalTs.shift();
    W.evalRate = T.evalTs.length / 10;
    if (!busyCount()) { W.rate = 0; W.evalRate = 0; stopTimer(); }
    paintAll();
  }
  function ensureTimer() { if (!W.timer) { W.last = totalTicks(); W.lastT = Date.now(); W.timer = setInterval(tick, 1000); } }
  function stopTimer() { if (W.timer) { clearInterval(W.timer); W.timer = 0; } }

  if (main) new MutationObserver(setState).observe(main, { attributes: true, attributeFilter: ['style'] });
  if (prog) new MutationObserver(onProg).observe(prog, { childList: true });
  var tabs = document.querySelector('.big-tabs');
  if (tabs) new MutationObserver(setPhase).observe(tabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
  var rs = $('runStats'); if (rs) new MutationObserver(requestPaint).observe(rs, { childList: true, characterData: true, subtree: true });
  var th = $('tableHost'); if (th) new MutationObserver(requestPaint).observe(th, { childList: true });
  setState(); setPhase(); requestPaint();

  /* ---------- 3c. ideal slider: bipolar fill (CSS vars --a/--b = fill span as 0..1 of the track) ---------- */
  function paintIdeal(el) {
    if (!el || el.id !== 'oIdeal') return;
    var lo = +el.min || 0, hi = +el.max || 1, p = (+el.value - lo) / ((hi - lo) || 1), c = 0.5;
    el.style.setProperty('--a', String(Math.min(p, c)));
    el.style.setProperty('--b', String(Math.max(p, c)));
  }
  document.addEventListener('input', function (e) { paintIdeal(e.target); }, true);
  var tp = $('tabPanel');
  if (tp) new MutationObserver(function () { paintIdeal($('oIdeal')); }).observe(tp, { childList: true });
  paintIdeal($('oIdeal'));

  /* ---------- 4. keyboard: 1/2/3 = phase, Ctrl/Cmd+Enter = run current ---------- */
  var ORDER = ['optmeco', 'zeta', 'convo'], RUN = { optmeco: 'oRun', zeta: 'zRun', convo: 'cRun' };
  document.addEventListener('keydown', function (e) {
    var t = e.target, typing = t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
    var st = body.getAttribute('data-state');
    if (st === 'idle') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      var a = document.querySelector('.big-tab.active');
      var b = a && $(RUN[a.getAttribute('data-tab')]);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || st !== 'ready') return;
    var k = ORDER[parseInt(e.key, 10) - 1];
    if (k) { var tab = document.querySelector('.big-tab[data-tab="' + k + '"]'); if (tab) tab.click(); }
  });
})();
