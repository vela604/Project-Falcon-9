// ============================================================================
// tuner-ui.js — Step 9: inputs, live progress, ranked leaderboard (sort tabs),
// expandable result blocks, Copy / Download JSON (Guidance.applyGuideConfig format).
//
//   TunerUI.mount(rootEl)         build the panels into rootEl and wire events
//   TunerUI.render(res, opts)     (re)render a runTuner() result into the result panel
// Pure helpers (no DOM, unit-tested in node): rowJson, rowsJson, rowBlockHtml, boardHtml,
//   tabsHtml, parseLogLine, summaryLine, esc, fmt
//
// Needs (globals): TunerConfig, TunerUtils, TunerCore, TunerHook (stats only).
// The sim is a singleton: one run at a time (Run disabled while running).
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const U = () => root.TunerUtils, C = () => root.TunerConfig;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const TAB_LABEL = { score: 'Score', accuracy: 'Accuracy', fuel: 'Fuel', time: 'Time' };

  // ---- pure helpers ---------------------------------------------------------
  // Full config for one row (tunables + fixed set): shallow-merge safe for applyGuideConfig.
  function rowJson(row, altKm) {
    return U().toValues(row.point, { targetAltKm: altKm != null ? altKm : C().fixed.targetAltKm });
  }
  function rowsJson(res, rows, altKm) {
    return {
      meco: res.meco, band: res.band, targetAltKm: altKm,
      rows: rows.map((r, i) => ({ rank: i + 1, src: r.src, tag: r.tag, ok: r.ok, score: r.score, orbitErrKm: r.orbitErrKm, ecc: r.ecc,
        fuelKg: r.fuelKg, deployS: r.deployS, residualKg: r.residualKg, config: rowJson(r, altKm) })),
    };
  }

  // value highlighted for the active sort key
  function keyValue(r, key) {
    if (key === 'accuracy') return fmt(r.orbitErrKm, 3) + ' km';
    if (key === 'fuel') return fmt(r.fuelKg, 0) + ' kg';
    if (key === 'time') return fmt(r.deployS, 2) + ' s';
    return fmt(r.score, 3);
  }

  function rowBlockHtml(r, rank, key, idx, open) {
    const d = r.desc || {};
    const sum = '<span class="tui-rank">#' + rank + '</span> <span class="tui-key">' + esc(keyValue(r, key)) + '</span>' +
      ' <span class="tui-dim">' + esc(r.src + ' ' + r.tag) + '</span>' +
      (r.ok ? '' : ' <span class="tui-badge">REJECTED</span>');
    const kv = [
      ['score', fmt(r.score, 3)], ['orbit err', fmt(r.orbitErrKm, 3) + ' km'], ['apo / peri', fmt(r.apoKm, 3) + ' / ' + fmt(r.periKm, 3)],
      ['ecc', Number.isFinite(r.ecc) ? r.ecc.toExponential(2) : '–'], ['E@coast', fmt(r.E, 4)], ['fuel', fmt(r.fuelKg, 0) + ' kg'],
      ['deploy', fmt(r.deployS, 2) + ' s'], ['residual', fmt(r.residualKg, 1) + ' kg'],
    ].map((x) => '<span class="tui-k">' + x[0] + '</span><span>' + esc(x[1]) + '</span>').join('');
    const pr = [
      ['G', d.G], ['T', d.T], ['A_eff', d.A_eff], ['bias', d.bias], ['lead', d.lead + ' (' + d.leadTicks + 't)'], ['MECO', d.meco],
    ].map((x) => '<span class="tui-k">' + x[0] + '</span><span>' + esc(x[1]) + '</span>').join('');
    const parts = r.parts ? '<div class="tui-dim">parts: ' + esc(Object.keys(r.parts).map((k) => k + ' ' + fmt(r.parts[k], 2)).join(' · ')) + '</div>' : '';
    const why = (r.reasons && r.reasons.length) ? '<div class="tui-bad">' + esc(r.reasons.join(', ')) + '</div>' : '';
    return '<details class="tui-row' + (r.ok ? '' : ' tui-rej') + '"' + (open ? ' open' : '') + '><summary>' + sum + '</summary>' +
      '<div class="tui-grid">' + pr + '</div><div class="tui-grid">' + kv + '</div>' + parts + why +
      '<div class="tui-btns"><button data-act="copy" data-idx="' + idx + '">Copy JSON</button>' +
      '<button data-act="dl" data-idx="' + idx + '">Download JSON</button></div></details>';
  }

  function tabsHtml(active) {
    return '<div class="tui-tabs">' + U().SORT_KEYS.map((k) =>
      '<button class="tui-tab' + (k === active ? ' on' : '') + '" data-act="sort" data-key="' + k + '">' + TAB_LABEL[k] + '</button>').join('') + '</div>';
  }

  function summaryLine(res) {
    const a = res.phaseA, b = res.phaseB;
    return 'status=' + res.status + ' · MECO ' + (res.meco != null ? res.meco : '–') + ' · band [' + (res.band || []).join(',') + '] kg · evals ' + res.evals +
      (a && b ? ' (A ' + a.evals + ' + B ' + b.evals + ')' : '') + ' · wall ' + fmt(res.wallMs / 1000, 1) + ' s';
  }

  function boardHtml(res, sortKey) {
    const rows = U().sortRows(res.leaderboard || [], sortKey);
    let h = '<div class="tui-sum ' + (res.ok ? 'tui-ok' : 'tui-bad') + '">' + (res.ok ? 'OK' : 'FAILED') + ' — ' + esc(summaryLine(res)) + '</div>';
    if (!rows.length) return h + '<div class="tui-dim">No leaderboard rows (Phase A failed or aborted).</div>';
    h += tabsHtml(sortKey);
    h += rows.map((r, i) => rowBlockHtml(r, i + 1, sortKey, i, i === 0)).join('');
    h += '<div class="tui-btns"><button data-act="copyall">Copy all JSON</button><button data-act="dlall">Download all JSON</button></div>';
    return h;
  }

  // progress info from a runTuner log line
  function parseLogLine(line, st) {
    st = st || {};
    if (/^=== Phase A/.test(line)) st.phase = 'Phase A (MECO search)';
    else if (/^=== Phase B/.test(line)) st.phase = 'Phase B (A,bias,lead lanes)';
    let m = /^#(\d+) MECO=(\d+)/.exec(line);
    if (m) { st.iter = +m[1]; st.meco = +m[2]; }
    m = /^verify \[([^\]]+)\]/.exec(line);
    if (m) st.lane = m[1];
    return st;
  }

  // ---- DOM part -------------------------------------------------------------
  const CSS = `
.tui{font-family:var(--font-mono,monospace);font-size:12px}
.tui .row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:6px 0}
.tui label{display:inline-flex;gap:4px;align-items:center;color:var(--dim,#6b7d9c)}
.tui select,.tui input[type=number]{background:var(--panel-2,#101a30);color:var(--text,#dbe6f5);border:1px solid var(--border,#1c2b45);padding:4px;font-family:inherit;width:auto}
.tui input[type=number]{width:70px}
.tui button.go{background:#12351f;border-color:#2a7a47;color:var(--green,#4ade80)}
.tui button.stop{background:#3a1520;border-color:#8a2a45;color:var(--danger,#ff5f7e)}
.tui-stat{color:var(--yellow,#ffd23f);margin:4px 0}.tui-dim{color:var(--dim,#6b7d9c)}.tui-bad{color:var(--danger,#ff5f7e)}.tui-ok{color:var(--green,#4ade80)}
.tui-sum{margin:4px 0 8px;word-break:break-word}
.tui-tabs{display:flex;gap:4px;margin:6px 0}.tui-tab.on{background:#0f3a4a;border-color:var(--cyan,#35d6ff);color:var(--cyan,#35d6ff)}
.tui-row{border:1px solid var(--border,#1c2b45);border-radius:4px;margin:4px 0;padding:4px 8px;background:var(--panel-2,#101a30)}
.tui-row summary{cursor:pointer;word-break:break-word}.tui-rej{opacity:.55}
.tui-rank{color:var(--orange,#ff9248);font-weight:700}.tui-key{color:var(--cyan,#35d6ff);font-weight:700}
.tui-badge{background:#3a1520;color:var(--danger,#ff5f7e);padding:0 4px;border-radius:3px}
.tui-grid{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:2px 10px;margin:6px 0}.tui-k{color:var(--dim,#6b7d9c)}
.tui-btns{display:flex;gap:6px;margin:6px 0;flex-wrap:wrap}
.tui pre{white-space:pre-wrap;max-height:30vh;overflow:auto;font-size:11px;margin:4px 0}`;

  function copyText(txt) {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) return root.navigator.clipboard.writeText(txt);
    return new Promise((res, rej) => {
      try { const ta = root.document.createElement('textarea'); ta.value = txt; root.document.body.appendChild(ta); ta.select();
        root.document.execCommand('copy'); ta.remove(); res(); } catch (e) { rej(e); }
    });
  }
  function download(name, txt) {
    const a = root.document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' }));
    a.download = name; root.document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function mount(el, opts) {
    opts = opts || {};
    const doc = root.document, cfg = C();
    if (!doc.getElementById('tuiStyle')) { const s = doc.createElement('style'); s.id = 'tuiStyle'; s.textContent = CSS; doc.head.appendChild(s); }
    const refs = cfg.references.map((r, i) => '<option value="' + i + '"' + (r.meco === cfg.meco.start ? ' selected' : '') + '>ref MECO ' + r.meco + '</option>').join('');
    el.innerHTML =
      '<div class="panel tui"><h3>Tuner · Phase A + B</h3>' +
      '<div class="row"><label>alt km <input type="number" id="tuiAlt" value="' + cfg.fixed.targetAltKm + '" step="1" min="150"></label>' +
      '<label>start <select id="tuiStart">' + refs + '</select></label>' +
      '<label>B mode <select id="tuiMode"><option value="fast">fast</option><option value="fine" selected>fine</option><option value="accurate">accurate</option></select></label>' +
      '<label><input type="checkbox" id="tuiDeorbit"> deorbit ON (band 500-600 kg)</label></div>' +
      '<div class="row"><label><input type="checkbox" id="tuiAtm" checked> atmosphere</label><label><input type="checkbox" id="tuiSlosh" checked> slosh</label>' +
      '<label><input type="checkbox" id="tuiImu"> IMU</label><label><input type="checkbox" id="tuiWind"> wind</label>' +
      '<label>m/s <input type="number" id="tuiWindSpd" value="0" step="1" min="0"></label><label>dir° <input type="number" id="tuiWindDir" value="0" step="5"></label>' +
      '<label>booster % <input type="number" id="tuiBoost" value="100" min="0" max="100"></label><label>stage % <input type="number" id="tuiStage" value="100" min="0" max="100"></label></div>' +
      '<div class="row"><button class="go" id="tuiRun">Run tuner</button><button class="stop" id="tuiStop" disabled>Stop</button>' +
      '<span class="tui-dim" id="tuiNote"></span></div></div>' +
      '<div class="panel tui"><h3>Progress</h3><div class="tui-stat" id="tuiStat">idle</div><div class="tui-dim" id="tuiLast"></div>' +
      '<details><summary class="tui-dim">log</summary><pre id="tuiLog"></pre></details></div>' +
      '<div class="panel tui" id="tuiResPanel" hidden><h3>Result · leaderboard</h3><div id="tuiRes"></div></div>';

    const $ = (id) => el.querySelector('#' + id);
    const S = { res: null, sort: 'score', alt: cfg.fixed.targetAltKm, rows: [], running: false, abortRef: { aborted: false } };
    const logBuf = [];

    function note() { $('tuiNote').textContent = (+$('tuiAlt').value !== 320) ? 'warm-start refs are tuned for 320 km: expect more evals' : ''; }
    $('tuiAlt').addEventListener('input', note);

    function renderResult() {
      $('tuiResPanel').hidden = false;
      $('tuiRes').innerHTML = boardHtml(S.res, S.sort);
      S.rows = U().sortRows(S.res.leaderboard || [], S.sort);
    }
    function flash(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = o; }, 1200); }

    $('tuiRes').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-act]'); if (!b || !S.res) return;
      const act = b.dataset.act, row = S.rows[+b.dataset.idx];
      if (act === 'sort') { S.sort = b.dataset.key; renderResult(); return; }
      if (act === 'copy' && row) copyText(JSON.stringify(rowJson(row, S.alt), null, 1)).then(() => flash(b, 'Copied'), () => flash(b, 'Copy failed'));
      else if (act === 'dl' && row) download('leoV3-' + row.tag.replace(/[^\w.=+-]+/g, '_') + '.json', JSON.stringify(rowJson(row, S.alt), null, 1));
      else if (act === 'copyall') copyText(JSON.stringify(rowsJson(S.res, S.rows, S.alt), null, 1)).then(() => flash(b, 'Copied'), () => flash(b, 'Copy failed'));
      else if (act === 'dlall') download('leoV3-leaderboard-' + S.sort + '.json', JSON.stringify(rowsJson(S.res, S.rows, S.alt), null, 1));
    });

    $('tuiStop').addEventListener('click', () => { S.abortRef.aborted = true; $('tuiStat').textContent = 'stopping after the current eval…'; });

    $('tuiRun').addEventListener('click', async () => {
      if (S.running) return;
      S.running = true; S.abortRef = { aborted: false }; logBuf.length = 0; $('tuiLog').textContent = '';
      $('tuiRun').disabled = true; $('tuiStop').disabled = false; $('tuiResPanel').hidden = true;
      const alt = +$('tuiAlt').value || cfg.fixed.targetAltKm, mode = $('tuiMode').value, deorbit = $('tuiDeorbit').checked;
      const ref = cfg.references[+$('tuiStart').value];
      const env = { atmosphere: $('tuiAtm').checked, slosh: $('tuiSlosh').checked, imu: $('tuiImu').checked,
        wind: { enabled: $('tuiWind').checked, speed: +$('tuiWindSpd').value || 0, directionDeg: +$('tuiWindDir').value || 0 },
        boosterPct: +$('tuiBoost').value, stagePct: +$('tuiStage').value };
      const prevDeorbit = cfg.fixed.deorbitEnabled; cfg.fixed.deorbitEnabled = deorbit;   // band + DEORBIT_ENABLED stay consistent
      S.alt = alt;
      const st = { phase: 'starting' }, t0 = performance.now(), hs0 = Object.assign({}, root.TunerHook ? root.TunerHook.stats : {});
      let simInfo = '';
      const tick = () => {
        const hs = root.TunerHook ? root.TunerHook.stats : { evals: 0, ticks: 0, wallMs: 0 };
        const evals = hs.evals - (hs0.evals || 0), tps = (hs.ticks - (hs0.ticks || 0)) / Math.max(1e-9, (hs.wallMs - (hs0.wallMs || 0)) / 1000);
        $('tuiStat').textContent = st.phase + (st.iter ? ' · iter ' + st.iter + ' MECO ' + st.meco : '') + (st.lane ? ' · lane ' + st.lane : '') +
          ' · evals ' + evals + ' · ' + fmt((performance.now() - t0) / 1000, 0) + ' s · ' + fmt(tps, 0) + ' t/s' + simInfo;
        $('tuiLast').textContent = logBuf.length ? logBuf[logBuf.length - 1] : '';
        $('tuiLog').textContent = logBuf.slice(-300).join('\n');
      };
      const timer = setInterval(tick, 500);
      try {
        const p = U().fromRaw({ G: ref.G, T: cfg.T0, bias: ref.bias, lead: ref.lead, meco: ref.meco });
        const res = await root.TunerCore.runTuner(p, { mode, deorbit, env, targetAltKm: alt, abortRef: S.abortRef,
          onLog: (l) => { logBuf.push(l); parseLogLine(l, st); if (opts.log) opts.log(l); },
          onProgress: (q) => { simInfo = ' · t=' + fmt(q.simTime, 0) + 's ' + (q.phase || ''); } });
        S.res = res; S.sort = 'score'; renderResult();
        st.phase = res.ok ? 'done' : 'finished: ' + res.status;
      } catch (e) {
        st.phase = 'ERROR: ' + e.message; logBuf.push('ERROR: ' + e.message); console.error(e);
      } finally {
        clearInterval(timer); tick();
        cfg.fixed.deorbitEnabled = prevDeorbit;
        S.running = false; $('tuiRun').disabled = false; $('tuiStop').disabled = true;
      }
    });
    note();
    return { state: S, render: renderResult };
  }

  root.TunerUI = { mount, rowJson, rowsJson, rowBlockHtml, tabsHtml, boardHtml, summaryLine, parseLogLine, keyValue, esc, fmt };
})();
