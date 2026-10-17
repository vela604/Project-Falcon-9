/* ==========================================================================
   ENGINE FX — visuals only. Event-driven (MutationObserver): no timers, no rAF loops.
   Reads the DOM the engine already renders; never calls engine code or touches workers.
   Page works without this file; it only adds: log colours + level gutter, status chips,
   telemetry readout, keyboard shortcuts, title font. Every hook is optional.
   ========================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  body.classList.add('fx');

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
    '(ZETA\\[batch \\d+\\]|OPT-MECO|FIND RANGE|CONVO-LEAD|CONVO|ZETA|setupSA|PHASE [A-D]|bootstrap)', // 3 phase tag
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
    }
    if (workers) { setText('stWorkersN', workers); setText('tmWorkers', workers); }
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
    }
  }
  function setPhase() {
    var a = document.querySelector('.big-tab.active');
    setText('stPhaseN', a ? (PHASE[a.getAttribute('data-tab')] || '—') : '—');
  }

  /* ---------- 3. telemetry readout (parsed from what the engine already prints) ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tmElapsed() {
    var m = /elapsed (\d+)s/.exec(prog ? prog.textContent : '');
    if (!m) return;
    var s = +m[1];
    setText('tmElapsed', pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60));
  }
  function tmRows() {
    var m = /(\d+) rows/.exec(($('runStats') || {}).textContent || '');
    setText('tmRows', m ? m[1] : '0');
    var b = document.querySelector('#tableHost tr.best td:nth-child(7)');
    setText('tmBest', b ? b.textContent : '—');
  }
  function onProg() { setState(); tmElapsed(); }

  if (main) new MutationObserver(setState).observe(main, { attributes: true, attributeFilter: ['style'] });
  if (prog) new MutationObserver(onProg).observe(prog, { childList: true });
  var tabs = document.querySelector('.big-tabs');
  if (tabs) new MutationObserver(setPhase).observe(tabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
  var rs = $('runStats'); if (rs) new MutationObserver(tmRows).observe(rs, { childList: true, characterData: true, subtree: true });
  var th = $('tableHost'); if (th) new MutationObserver(tmRows).observe(th, { childList: true });
  setState(); setPhase(); tmRows();

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
