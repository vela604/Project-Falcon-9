// ============================================================================
// host.js — Step 9: inputs, live progress, ranked leaderboard (sort tabs),
// expandable result blocks, Copy / Download JSON, config panel.
// Refs come from saved presets (guidancePresets.js), default preset first + fallback.
// Strategy dropdown from TunerCore.listStrategies(); run dispatches to the selected strategy.
// ============================================================================
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const U = () => root.TunerUtils, C = () => root.TunerConfig;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  function fmtBig(n) {   // 1.2K · 3.45M · 12.3B · 1.00T
    if (!Number.isFinite(n) || n < 0) return '–';
    const U2 = [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]];
    for (let i = 0; i < U2.length; i++) if (n >= U2[i][1]) { const v = n / U2[i][1]; return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + U2[i][0]; }
    return String(Math.round(n));
  }
  function fmtDur(sec) {
    if (!Number.isFinite(sec)) return '–';
    if (sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + 's';
    let m = Math.floor(sec / 60); const sc = Math.floor(sec % 60);
    if (m < 60) return m + 'm ' + pad2(sc) + 's';
    let h = Math.floor(m / 60); m %= 60;
    if (h < 24) return h + 'h ' + pad2(m) + 'm';
    return Math.floor(h / 24) + 'd ' + pad2(h % 24) + 'h';
  }
  const fmtClock = (s) => { s = Math.max(0, Math.floor(s)); return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s % 3600 / 60)) + ':' + pad2(s % 60); };
  const TAB_LABEL = { score: 'Score', accuracy: 'Accuracy', fuel: 'Fuel', time: 'Time' };

  function rowJson(row, altKm) { return U().toValues(row.point, { targetAltKm: altKm != null ? altKm : C().fixed.targetAltKm }); }
  function rowsJson(res, rows, altKm) {
    return { meco: res.meco, band: res.band, targetAltKm: altKm,
      rows: rows.map((r, i) => ({ rank: i + 1, src: r.src, tag: r.tag, ok: r.ok, score: r.score, orbitErrKm: r.orbitErrKm, ecc: r.ecc,
        fuelKg: r.fuelKg, deployS: r.deployS, residualKg: r.residualKg, config: rowJson(r, altKm) })) };
  }
  function keyValue(r, key) {
    if (key === 'accuracy') return fmt(r.orbitErrKm, 3) + ' km';
    if (key === 'fuel') return fmt(r.fuelKg, 0) + ' kg';
    if (key === 'time') return fmt(r.deployS, 2) + ' s';
    return fmt(r.score, 3);
  }
  function rowBlockHtml(r, rank, key, idx, open) {
    const d = r.desc || {};
    const sum = '<span class="tui-rank">#' + rank + '</span> <span class="tui-key">' + esc(keyValue(r, key)) + '</span>' +
      ' <span class="tui-dim">' + esc(r.src + ' ' + r.tag) + '</span>' + (r.ok ? '' : ' <span class="tui-badge">REJECTED</span>');
    const kv = [['score', fmt(r.score, 3)], ['orbit err', fmt(r.orbitErrKm, 3) + ' km'], ['apo / peri', fmt(r.apoKm, 3) + ' / ' + fmt(r.periKm, 3)],
  ['ecc', Number.isFinite(r.ecc) ? r.ecc.toExponential(2) : '–'], ['Δv', fmt(r.deltaV, 0) + ' m/s'], ['fuel', fmt(r.fuelKg, 0) + ' kg'],
  ['deploy', fmt(r.deployS, 2) + ' s'], ['residual', fmt(r.residualKg, 1) + ' kg']].map((x) => '<span class="tui-k">' + x[0] + '</span><span>' + esc(x[1]) + '</span>').join('');
    const pr = [['G', d.G], ['T', d.T], ['A_eff', d.A_eff], ['bias', d.bias], ['lead', d.lead + ' (' + d.leadTicks + 't)'], ['MECO', d.meco]]
      .map((x) => '<span class="tui-k">' + x[0] + '</span><span>' + esc(x[1]) + '</span>').join('');
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
    let s = 'status=' + res.status + ' · MECO ' + (res.meco != null ? res.meco : '–') + ' · band [' + (res.band || []).join(',') + '] kg · evals ' + res.evals +
      (a && b ? ' (A ' + a.evals + ' + B ' + b.evals + ')' : '') + ' · wall ' + fmt(res.wallMs / 1000, 1) + ' s';
    if (res.probe) s += ' · probe ' + (res.probe.probedKg != null ? res.probe.probedKg : res.probe.triedKg) + ' kg → ' + (res.probe.ok ? 'used' : 'fell back to ' + res.probe.usedKg + ' kg');
    return s;
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
  function parseLogLine(line, st) {
    st = st || {};
    if (/^=== Phase A/.test(line)) st.phase = 'Phase A (MECO search)';
    else if (/^=== Phase B/.test(line)) st.phase = 'Phase B (A,bias,lead lanes)';
    else if (/^=== MECO probe/.test(line)) st.phase = 'MECO probe';
    else if (/^=== Phase A: SKIPPED/.test(line)) st.phase = 'Phase A skipped';
    let m = /^#(\d+) MECO=(-?\d+)/.exec(line);
    if (m) { st.iter = +m[1]; st.meco = +m[2]; }
    m = /^verify \[([^\]]+)\]/.exec(line);
    if (m) { st.lane = m[1]; }
    m = /▶ eval #(\d+) \[([^\]]+)\]/.exec(line);
    if (m) { st.evalId = +m[1]; st.evalStop = m[2]; st.evalWaiting = true; st.evalError = null; }
    m = /◀ eval #(\d+) /.exec(line);
    if (m && st.evalId === +m[1]) { st.evalWaiting = false; }
    m = /✗ eval #(\d+) ERROR: (.*)$/.exec(line);
    if (m) { st.evalError = m[2]; st.evalWaiting = false; }
    return st;
  }

  const CSS = `
/* tuner UI — pro-alpha look (uses engine-theme.css tokens; fallbacks keep it usable standalone) */
.tui{font-family:var(--mono,monospace);font-size:12px}
.tui-cols{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;align-items:start;margin-bottom:14px}
.tui-col{min-width:0}.tui-col>.panel{margin-bottom:14px}.tui-col>.panel:last-child{margin-bottom:0}
@media (max-width:1100px){.tui-cols{grid-template-columns:minmax(0,1fr)}}
.tui .row{margin:10px 0}
.tui .row label input[type=number]{width:var(--fld-w,96px);height:var(--fld-h,32px);box-sizing:border-box}
.tui select{height:var(--fld-h,32px);min-width:140px;max-width:100%}
.tui #tuiStart,.tui #tuiStrategy{min-width:220px}
.tui input[type=number]:disabled{opacity:.4}
.tui button.go{background:#fff;color:#000;border-color:#fff}
.tui button.go:hover:not(:disabled){background:var(--ph,#a78bfa);border-color:var(--ph,#a78bfa);color:#000}
.tui button.stop{color:var(--red,#ff4d5e);border-color:rgba(255,77,94,.55)}
.tui button.stop:hover:not(:disabled){background:var(--red,#ff4d5e);border-color:var(--red,#ff4d5e);color:#000}
.tui .row button{height:var(--fld-h,32px);padding-top:0;padding-bottom:0}
.tui-dim{color:var(--dim,#8a8a8a)}.tui-bad{color:var(--red,#ff4d5e)}.tui-ok{color:var(--green,#4ade80)}
.tui .row > .tui-dim{align-self:center;font-size:11px}

/* config */
.tui .cfgsec{display:flex;align-items:center;gap:10px;margin:14px 0 10px;color:var(--ph,#a78bfa);font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;font-weight:700}
.tui .cfgsec::after{content:"";flex:1;height:1px;background:var(--line,#333)}
.tui .cfgwrap{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 18px;margin:6px 0 12px}
.tui .cfgwrap label{display:flex;flex-direction:column;gap:3px;min-width:0;justify-content:flex-end;font:400 9.5px var(--mono,monospace);letter-spacing:.16em;text-transform:uppercase;color:var(--dim,#8a8a8a)}
.tui .cfgwrap label input[type=number]{width:100%;height:var(--fld-h,32px);box-sizing:border-box}
@media (max-width:700px){.tui .cfgwrap{grid-template-columns:repeat(2,minmax(0,1fr))}}
.tui textarea{width:100%;min-height:70px;background:#000;color:#fff;border:1px solid var(--line2,#555);font-family:inherit;font-size:11px;padding:6px 8px;margin-top:6px;border-radius:0;outline:0}
.tui textarea:focus{border-color:var(--ph,#a78bfa)}

/* telemetry: run strip (4 equal cells) + phase cells + status prompt */
.tui-strip,.tui-tm{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0 0 12px;border:1px solid var(--line,#333)}
.tui-strip{border-color:var(--line2,#555);grid-template-columns:1.3fr 1fr 1fr 1fr}
.tui-strip>div,.tui-tm>div{padding:9px 12px;border-right:1px solid var(--line,#333);min-width:0}
.tui-strip>div:last-child,.tui-tm>div:last-child{border-right:0}
.tui-strip span,.tui-tm span{display:flex;align-items:center;gap:8px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8a8a8a);white-space:nowrap}
.tui-strip span em{font-style:normal;overflow:hidden;text-overflow:ellipsis}
.tui-strip span small{font-size:8px;letter-spacing:.12em;color:var(--faint,#666);border:1px solid var(--line,#333);padding:0 4px}
.tui-strip b,.tui-tm b{display:block;margin-top:2px;font:700 16px/1.25 var(--mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tui-tm b{font-size:18px}
.tui-strip b small{font:400 10px var(--mono,monospace);letter-spacing:.08em;color:var(--dim,#8a8a8a);margin-left:6px;border:0;padding:0}
.tui-strip b small.x{color:var(--green,#4ade80);margin-left:4px;font-size:9px}
.tui-strip>div:nth-child(1) b{color:var(--cyan,#35d6ff)}.tui-strip>div:nth-child(2) b{color:var(--amber,#ffb020)}
.tui-strip>div:nth-child(3) b{color:var(--violet,#a78bfa)}.tui-strip>div:nth-child(4) b{color:var(--green,#4ade80)}
.tui-tm>div:nth-child(1) b{color:var(--cyan,#35d6ff)}.tui-tm>div:nth-child(2) b{color:var(--amber,#ffb020)}
.tui-tm>div:nth-child(3) b{color:var(--violet,#a78bfa)}.tui-tm>div:nth-child(4) b{color:var(--green,#4ade80)}
.tui-spin{display:none;flex:0 0 auto;width:9px;height:9px;border:1.5px solid var(--line2,#555);border-top-color:var(--amber,#ffb020);border-radius:50%;animation:tuisp .8s linear infinite}
.tui-prompt{color:var(--green,#4ade80);font-weight:700;font-style:normal}
.tui.is-running .tui-spin{display:inline-block}.tui.is-running .tui-prompt{display:none}
.tui #tuiFlag.is-running{color:var(--amber,#ffb020);border-color:var(--amber,#ffb020)}
.tui #tuiFlag.is-ready{color:var(--green,#4ade80);border-color:var(--green,#4ade80)}
.tui #tuiFlag.is-error{color:var(--red,#ff4d5e);border-color:var(--red,#ff4d5e)}
@keyframes tuisp{to{transform:rotate(360deg)}}
@media (max-width:820px){.tui-strip,.tui-tm{grid-template-columns:repeat(2,minmax(0,1fr))}.tui-strip>div:nth-child(2),.tui-tm>div:nth-child(2){border-right:0}
  .tui-strip>div:nth-child(-n+2),.tui-tm>div:nth-child(-n+2){border-bottom:1px solid var(--line,#333)}}
.tui-stat{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;margin:0 0 10px;border:1px solid var(--line,#333);color:var(--amber,#ffb020);word-break:break-word;min-height:2.6em}
.tui-stat::before{content:"$";color:var(--green,#4ade80);font-weight:700}
.tui-runsum{margin:0 0 10px;padding:7px 12px;border:1px solid var(--line,#333);font-size:10.5px;color:var(--dim,#8a8a8a);line-height:1.7}
.tui-runsum:empty{display:none}.tui-runsum b{color:#fff}.tui-runsum .k{color:var(--green,#4ade80);letter-spacing:.16em;font-weight:700;margin-right:10px}
.tui-last{min-height:1.6em;margin-bottom:6px;font-size:11px;word-break:break-word}
.tui details.tui-logd{margin-top:6px}.tui details.tui-logd>summary{cursor:pointer;color:var(--dim,#8a8a8a);font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;list-style:none}
.tui details.tui-logd>summary::-webkit-details-marker{display:none}
.tui details.tui-logd>summary::before{content:"+ ";color:var(--ph,#a78bfa)}.tui details.tui-logd[open]>summary::before{content:"\\2212 "}
.tui pre{white-space:pre-wrap;max-height:34vh;overflow:auto;font-size:11px;line-height:1.6;margin:8px 0 0;padding:8px 12px;background:#000;border:1px solid var(--line,#333);color:rgba(255,255,255,.78)}

/* leaderboard */
.tui-sum{margin:0 0 12px;padding:8px 12px;border:1px solid var(--line2,#555);word-break:break-word}
.tui-sum.tui-ok{border-color:rgba(74,222,128,.5);background:rgba(74,222,128,.05)}
.tui-sum.tui-bad{border-color:rgba(255,77,94,.5);background:rgba(255,77,94,.06)}
.tui-tabs{display:flex;flex-wrap:wrap;width:max-content;max-width:100%;margin:4px 0 12px;border:1px solid var(--line2,#555)}
.tui-tab{background:transparent;color:var(--dim,#8a8a8a);border:0;border-right:1px solid var(--line,#333);padding:8px 14px;border-radius:0;font:500 10.5px var(--mono,monospace);letter-spacing:.1em;text-transform:uppercase}
.tui-tab:last-child{border-right:0}.tui-tab.on{background:#fff;color:#000;font-weight:700}
.tui-row{border:1px solid var(--line,#333);border-left:2px solid var(--line2,#555);margin:6px 0;padding:0;background:#000}
.tui-row:hover{border-color:#fff}
#tuiRes details.tui-row:first-of-type{border-left-color:var(--green,#4ade80)}
.tui-row summary{cursor:pointer;word-break:break-word;padding:8px 14px}
.tui-row[open] summary{border-bottom:1px solid var(--line,#333)}
.tui-row>:not(summary){margin-left:14px;margin-right:14px}
.tui-rej{border-left-color:var(--red,#ff4d5e)!important;opacity:.7}
.tui-rank{color:#fff;font-weight:700;margin-right:6px}.tui-key{color:var(--amber,#ffb020);font-weight:700}
.tui-badge{color:var(--red,#ff4d5e);border:1px solid rgba(255,77,94,.55);padding:0 6px;font-size:9.5px;letter-spacing:.12em}
.tui-grid{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:3px 14px;margin:10px 14px}
.tui-grid span:not(.tui-k){color:var(--amber,#ffb020)}.tui-k{color:var(--dim,#8a8a8a)}
.tui-btns{display:flex;gap:8px;margin:10px 14px 12px;flex-wrap:wrap}
#tuiRes>.tui-btns{margin:12px 0 0}
.tui-row .tui-btns button,#tuiRes>.tui-btns button{padding:7px 12px;font-size:10px}
@media (max-width:700px){.tui-grid{grid-template-columns:auto 1fr}}`;

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

  const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const setPath = (o, p, v) => {
    const parts = p.split('.'); let cur = o;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = v;
  };

  const CFG_FIELDS = [
    { id: 'tuiWOrbit', label: 'orbit weight', path: 'scoring.orbit.weight', group: 'rank', step: 10, min: 0 },
    { id: 'tuiWEcc', label: 'ecc weight', path: 'scoring.eccentricity.weight', group: 'rank', step: 100, min: 0 },
    { id: 'tuiWFuel', label: 'fuel weight', path: 'scoring.boosterFuelLeftKgWeight', group: 'rank', step: 0.001, min: 0 },
    { id: 'tuiWTime', label: 'time weight', path: 'scoring.timeToDeploySWeight', group: 'rank', step: 0.01, min: 0 },
    { id: 'tuiDvLo', label: 'Δv band lo (m/s)', path: 'limits.coastDeltaVbandMps.0', group: 'search', step: 10, min: 0 },
{ id: 'tuiDvHi', label: 'Δv band hi (m/s)', path: 'limits.coastDeltaVbandMps.1', group: 'search', step: 10, min: 0 },
{ id: 'tuiResLo', label: 'band OFF lo', path: 'limits.residualTargetKg.0', group: 'search', step: 10 },
{ id: 'tuiResHi', label: 'band OFF hi', path: 'limits.residualTargetKg.1', group: 'search', step: 10 },
    { id: 'tuiResOnLo', label: 'band ON lo', path: 'limits.residualTargetDeorbitOnKg.0', group: 'search', step: 10 },
    { id: 'tuiResOnHi', label: 'band ON hi', path: 'limits.residualTargetDeorbitOnKg.1', group: 'search', step: 10 },
    { id: 'tuiMLo', label: 'margin lo s', path: 'limits.marginTargetS.0', group: 'search', step: 0.1 },
    { id: 'tuiMHi', label: 'margin hi s', path: 'limits.marginTargetS.1', group: 'search', step: 0.1 },
  ];

  function mount(el, opts) {
    opts = opts || {};
    const doc = root.document, cfg = C();
    if (!doc.getElementById('tuiStyle')) { const s = doc.createElement('style'); s.id = 'tuiStyle'; s.textContent = CSS; doc.head.appendChild(s); }

    // ---- refs: presets only (default first, then user presets, fallback to baseline) ----
    function collectRefs() {
      const out = [];
      const push = (raw, src) => {
        if (!raw) return;
        const G = Number(raw.G), T = Number(raw.T), bias = Number(raw.bias), lead = Number(raw.lead), meco = Number(raw.meco);
        if (![G, T, bias, lead, meco].every(Number.isFinite)) return;
        out.push({ G, T, bias, lead, meco, alt: Number.isFinite(Number(raw.alt)) ? Number(raw.alt) : 320, name: raw.name || null, src });
      };
      try {
        if (typeof getAllPresetsForGuide === 'function') {
          const list = getAllPresetsForGuide(cfg.guideName) || [];
          const defs = list.filter((p) => p.isDefault);
          const users = list.filter((p) => !p.isDefault);
          users.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
          defs.concat(users).forEach((meta) => {
            const p = (typeof getPresetById === 'function') ? getPresetById(meta.id) : meta;
            const c = p && p.constants; if (!c) return;
            push({
              G: c.ascent && c.ascent.PUSH_MAX_GIMBAL_DEG,
              T: c.ascent && c.ascent.PUSH_T_S,
              bias: c.insertion && c.insertion.STAGE_BURN_AOA_BIAS_DEG,
              lead: c.insertion && c.insertion.CIRC_TRIGGER_LEAD_S,
              meco: c.ascent && c.ascent.MECO_TARGET_BOOSTER_FUEL_KG,
              alt: c.insertion && c.insertion.TARGET_ORBIT_ALT_KM,
              name: p.name || (p.isDefault ? 'default' : ('preset ' + (meta.id || '?')))
            }, p.isDefault ? 'default' : 'preset');
          });
        }
      } catch (e) { try { console.warn('[host] presets read failed:', e); } catch (_) {} }
      if (!out.length) {
        push({ G: cfg.baselineRaw.G, T: cfg.baselineRaw.T, bias: cfg.baselineRaw.bias, lead: cfg.baselineRaw.lead, meco: cfg.baselineRaw.meco, alt: 320, name: 'baseline (fallback)' }, 'fallback');
      }
      return out;
    }
    const REFS = collectRefs();
    const refs = REFS.map((r, i) =>
      '<option value="' + i + '">' +
      (r.src === 'preset' ? '★ ' : (r.src === 'default' ? '◆ ' : '')) +
      (r.name ? esc(r.name) + ' · ' : '') +
      'MECO ' + r.meco + ' · ' + r.alt + ' km</option>').join('');

    const stratList = (typeof root.TunerCore.listStrategies === 'function') ? root.TunerCore.listStrategies() : ['guided'];
    const stratOpts = stratList.map((n) => {
      const s = root.TunerCore.getStrategy(n) || {};
      return '<option value="' + esc(n) + '"' + (n === 'guided' ? ' selected' : '') + '>' + esc(s.label || n) + '</option>';
    }).join('');

    const DEFAULTS = {};
    CFG_FIELDS.forEach((f) => { DEFAULTS[f.path] = getPath(cfg, f.path); });

    const rankFields = CFG_FIELDS.filter((f) => f.group === 'rank').map((f) =>
      '<label>' + f.label + ' <input type="number" id="' + f.id + '" data-path="' + f.path + '" data-group="rank" step="' + (f.step || 1) + '"' +
      (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + '></label>').join('');
    const searchFields = CFG_FIELDS.filter((f) => f.group === 'search').map((f) =>
      '<label>' + f.label + ' <input type="number" id="' + f.id + '" data-path="' + f.path + '" data-group="search" step="' + (f.step || 1) + '"' +
      (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + '></label>').join('');

    const rowsTop =
      '<div class="row"><label>alt km <input type="number" id="tuiAlt" value="' + cfg.fixed.targetAltKm + '" step="1" min="150"></label>' +
      '<label>strategy <select id="tuiStrategy">' + stratOpts + '</select></label>' +
      '<label>start <select id="tuiStart">' + refs + '</select></label>' +
      '<label>B mode <select id="tuiMode"><option value="fast">fast</option><option value="fine" selected>fine</option><option value="accurate">accurate</option></select></label>' +
      '<label><input type="checkbox" id="tuiDeorbit"> deorbit ON (band 500-600 kg)</label>' +
      '<label>duration cap s <input type="number" id="tuiDurCap" step="10" min="100"></label>' +
      '<button id="tuiDurCapAuto" title="Use the suggested value for the current altitude">auto</button>' +
      '<span class="tui-dim" id="tuiDurCapHint"></span></div>';
    el.innerHTML =
      '<div class="tui-cols"><div class="tui-col">' +
      '<div class="panel tui"><h2><span class="tag">0x03</span>Tuner</h2>' + rowsTop +
      '<div class="row"><label><input type="checkbox" id="tuiAtm" checked> atmosphere</label><label><input type="checkbox" id="tuiSlosh" checked> slosh</label>' +
      '<label><input type="checkbox" id="tuiImu"> IMU</label><label><input type="checkbox" id="tuiWind"> wind</label>' +
      '<label>m/s <input type="number" id="tuiWindSpd" value="0" step="1" min="0"></label><label>dir&deg; <input type="number" id="tuiWindDir" value="0" step="5"></label>' +
      '<label>booster % <input type="number" id="tuiBoost" value="100" min="0" max="100"></label><label>stage % <input type="number" id="tuiStage" value="100" min="0" max="100"></label></div>' +
      '<div class="row"><button class="go" id="tuiRun">Run tuner</button><button class="stop" id="tuiStop" disabled>Stop</button>' +
      '<span class="tui-dim" id="tuiStratDesc"></span><span class="tui-dim" id="tuiNote"></span></div></div>' +
      '<div class="panel tui"><h2><span class="tag">0x04</span>Config</h2>' +
      '<div class="cfgsec">Ranking &mdash; applies immediately (re-scores the leaderboard)</div><div class="cfgwrap">' + rankFields + '</div>' +
      '<div class="cfgsec">Search &mdash; applies to the next run</div><div class="cfgwrap">' + searchFields + '</div>' +
      '<div class="row"><button id="tuiExpBtn">Export config</button><button id="tuiImpBtn">Import config</button><button id="tuiRstBtn">Reset defaults</button>' +
      '<span class="tui-dim" id="tuiCfgStatus"></span></div>' +
      '<textarea id="tuiCfgIOText" placeholder="Paste config JSON here, then click Import (missing or invalid fields keep their current value)." hidden></textarea></div>' +
      '</div><div class="tui-col">' +
      '<div class="panel tui" id="tuiTelePanel"><h2><span class="tag">0x05</span>Telemetry</h2>' +
      '<div class="tui-strip">' +
      '<div><span><i class="tui-prompt">$</i><i class="tui-spin"></i><em>elapsed</em><small id="tuiFlag">IDLE</small></span><b id="tuiElapsed">00:00:00</b></div>' +
      '<div><span><em>operations / s</em></span><b id="tuiOps">&mdash;</b></div>' +
      '<div><span><em>total operations</em></span><b id="tuiTotal">0</b></div>' +
      '<div><span><em>total sim time</em></span><b id="tuiSim">&mdash;</b></div></div>' +
      '<div class="tui-stat" id="tuiStat">idle</div>' +
      '<div class="tui-tm">' +
      '<div><span>evals</span><b id="tuiEvals">0</b></div><div><span>iter</span><b id="tuiIter">&mdash;</b></div>' +
      '<div><span>MECO kg</span><b id="tuiMeco">&mdash;</b></div><div><span>lane</span><b id="tuiLane">&mdash;</b></div></div>' +
      '<div class="tui-runsum" id="tuiRunSum"></div>' +
      '<div class="tui-dim tui-last" id="tuiLast"></div>' +
      '<details class="tui-logd"><summary>log</summary><pre id="tuiLog"></pre></details></div>' +
      '</div></div>' +
      '<div class="panel tui" id="tuiResPanel" hidden><h2><span class="tag">0x06</span>Result &middot; leaderboard</h2><div id="tuiRes"></div></div>';

    const $ = (id) => el.querySelector('#' + id);
    const S = { res: null, sort: 'score', alt: cfg.fixed.targetAltKm, rows: [], running: false, abortRef: { aborted: false }, refs: REFS };
    const logBuf = [];

    let durCapDirty = false;
    function refreshDurCap(fromAlt) {
      const alt = +$('tuiAlt').value || cfg.fixed.targetAltKm;
      const sug = U().suggestDurationCap(alt);
      $('tuiDurCapHint').textContent = 'auto ' + sug + ' s';
      if (!durCapDirty || fromAlt) { $('tuiDurCap').value = sug; }
    }
    $('tuiDurCap').addEventListener('input', () => { durCapDirty = true; });
    $('tuiDurCapAuto').addEventListener('click', () => { durCapDirty = false; refreshDurCap(true); });

    function updateNote() {
      const alt = +$('tuiAlt').value;
      const ref = S.refs[+$('tuiStart').value];
      const parts = [];
      if (ref) {
        const refAlt = ref.alt != null ? ref.alt : 320;
        if (Math.abs(refAlt - alt) > 100) parts.push('start ref tuned for ' + refAlt + ' km; target ' + alt + ' km — expect more evals');
      }
      const MC2 = cfg.meco || {};
      const probeStart = MC2.probeStartKg != null ? MC2.probeStartKg : 20000;
      if (ref && ref.meco < probeStart) parts.push('ref MECO ' + ref.meco + ' < ' + probeStart + ': will probe MECO ' + probeStart + ' first (fallback ' + ref.meco + ')');
      $('tuiNote').textContent = parts.join(' · ');
    }
    function updateStratDesc() {
      const s = root.TunerCore.getStrategy($('tuiStrategy').value) || {};
      $('tuiStratDesc').textContent = s.describe ? '— ' + s.describe : '';
    }
    let startAuto = true;
    function autoPickRef() {
      if (!startAuto) return;
      const alt = +$('tuiAlt').value || cfg.fixed.targetAltKm;
      let bestI = 0, bestD = Infinity, bestIsDef = false;
      S.refs.forEach((r, i) => {
        const d = Math.abs((r.alt != null ? r.alt : 320) - alt);
        const isDef = r.src === 'default' || r.src === 'fallback';
        if (d < bestD - 1e-9 || (Math.abs(d - bestD) < 1e-9 && isDef && !bestIsDef)) { bestD = d; bestI = i; bestIsDef = isDef; }
      });
      $('tuiStart').value = String(bestI);
      updateNote();
    }
    $('tuiStart').addEventListener('change', () => { startAuto = false; updateNote(); });
    $('tuiStrategy').addEventListener('change', updateStratDesc);
    $('tuiAlt').addEventListener('input', () => { autoPickRef(); refreshDurCap(); });

    // ---- config panel ----
    function fillConfigInputs() {
      CFG_FIELDS.forEach((f) => { const inp = el.querySelector('#' + f.id); if (inp) inp.value = getPath(cfg, f.path); });
    }
    function applyInputValue(inp) {
      const path = inp.dataset.path, group = inp.dataset.group;
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) { inp.value = getPath(cfg, path); return false; }
      setPath(cfg, path, v);
      return group === 'rank';
    }
    function rescoreAndRender() {
      if (!S.res) return;
      S.res.leaderboard = (S.res.leaderboard || []).map((r) =>
        U().makeRow(r.src, r.tag, r.point, r.metrics, r.extra || { E: r.E, targetAltKm: S.alt, reject: !r.ok, reasons: r.reasons }));
      renderResult();
    }
    function setSearchDisabled(dis) {
      CFG_FIELDS.filter((f) => f.group === 'search').forEach((f) => { const inp = el.querySelector('#' + f.id); if (inp) inp.disabled = dis; });
    }
    function cfgStatus(msg, cls) { const el2 = $('tuiCfgStatus'); el2.textContent = msg; el2.className = cls || 'tui-dim'; }

    el.addEventListener('input', (ev) => {
      const inp = ev.target.closest('input[data-path]'); if (!inp) return;
      const isRank = applyInputValue(inp);
      if (isRank) rescoreAndRender();
    });

    $('tuiExpBtn').addEventListener('click', () => {
      const out = {};
      CFG_FIELDS.forEach((f) => { out[f.path] = getPath(cfg, f.path); });
      const txt = JSON.stringify(out, null, 2);
      copyText(txt).then(() => cfgStatus('exported to clipboard (' + CFG_FIELDS.length + ' fields)', 'tui-ok'),
                         () => { const ta = $('tuiCfgIOText'); ta.hidden = false; ta.value = txt; ta.select(); cfgStatus('clipboard unavailable — select + copy manually', 'tui-bad'); });
    });
    $('tuiImpBtn').addEventListener('click', () => {
      const ta = $('tuiCfgIOText');
      if (ta.hidden) { ta.hidden = false; ta.value = ''; ta.focus(); cfgStatus('paste JSON above, click Import again'); return; }
      let parsed; try { parsed = JSON.parse(ta.value); } catch (e) { cfgStatus('JSON parse error: ' + e.message, 'tui-bad'); return; }
      let ok = 0, skipped = 0, rankChanged = false;
      CFG_FIELDS.forEach((f) => {
        if (!(f.path in parsed)) { skipped++; return; }
        const v = parsed[f.path];
        if (typeof v !== 'number' || !Number.isFinite(v)) { skipped++; return; }
        if (f.min != null && v < f.min) { skipped++; return; }
        if (f.max != null && v > f.max) { skipped++; return; }
        setPath(cfg, f.path, v);
        const inp = el.querySelector('#' + f.id); if (inp) inp.value = v;
        if (f.group === 'rank') rankChanged = true;
        ok++;
      });
      if (rankChanged) rescoreAndRender();
      ta.hidden = true;
      cfgStatus('imported ' + ok + ' field' + (ok === 1 ? '' : 's') + (skipped ? ', ' + skipped + ' skipped (missing/invalid → kept current)' : ''), skipped ? 'tui-dim' : 'tui-ok');
    });
    $('tuiRstBtn').addEventListener('click', () => {
      Object.keys(DEFAULTS).forEach((p) => setPath(cfg, p, DEFAULTS[p]));
      fillConfigInputs();
      rescoreAndRender();
      cfgStatus('reset to page-load defaults', 'tui-ok');
    });

    // ---- telemetry helpers ----
    const setHtml = (id, v) => { const n = $(id); if (n && n.getAttribute('data-v') !== v) { n.setAttribute('data-v', v); n.innerHTML = v; } };
    const emit = (state, text) => { try { if (opts.onState) opts.onState(state, text); } catch (_) {} };
    function setRunning(on, endState) {
      const panel = $('tuiTelePanel'); if (panel) panel.classList.toggle('is-running', on);
      const f = $('tuiFlag'); if (f) { f.className = 'is-' + (on ? 'running' : (endState || 'idle')); f.textContent = on ? 'WAIT' : (endState === 'error' ? 'ERROR' : endState === 'ready' ? 'DONE' : 'IDLE'); }
    }
    function resetTele(clearSum) {
      ['tuiElapsed'].forEach((i) => { $(i).textContent = '00:00:00'; });
      setHtml('tuiOps', '–'); setHtml('tuiTotal', '0<small>ops</small>'); setHtml('tuiSim', '–');
      $('tuiEvals').textContent = '0'; $('tuiIter').textContent = '–'; $('tuiMeco').textContent = '–'; $('tuiLane').textContent = '–';
      if (clearSum) $('tuiRunSum').textContent = '';
    }

    // ---- run / stop / result ----
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
      setSearchDisabled(true);
      const alt = +$('tuiAlt').value || cfg.fixed.targetAltKm, mode = $('tuiMode').value, deorbit = $('tuiDeorbit').checked;
      const ref = S.refs[+$('tuiStart').value];
      const env = { atmosphere: $('tuiAtm').checked, slosh: $('tuiSlosh').checked, imu: $('tuiImu').checked,
        wind: { enabled: $('tuiWind').checked, speed: +$('tuiWindSpd').value || 0, directionDeg: +$('tuiWindDir').value || 0 },
        boosterPct: +$('tuiBoost').value, stagePct: +$('tuiStage').value };
      const prevDeorbit = cfg.fixed.deorbitEnabled; cfg.fixed.deorbitEnabled = deorbit;
      const capIn = parseInt($('tuiDurCap').value, 10);
      const prevCap = cfg.durationCapS;
      cfg.durationCapS = (Number.isFinite(capIn) && capIn >= 100) ? capIn : U().suggestDurationCap(alt);
      S.alt = alt;
      const st = { phase: 'starting' }, t0 = performance.now(), hs0 = Object.assign({}, root.TunerHook ? root.TunerHook.stats : {});
      let simInfo = '';
      // "operations" = TunerEngine.tick calls actually executed (same definition as the Sereno worker counter).
      // NOTE: TunerHook's m.ticks / stats.ticks is the loop index, so a resumed (checkpoint) eval also counts the ticks it skipped.
      const DT = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.DT) || 0.02;
      let tickCount = 0, simAcc = 0, lastTotal = 0, lastEvals = 0, lastSim = 0;
      const eng = root.TunerEngine, origTick = eng && eng.tick;
      if (origTick) eng.tick = function () { tickCount++; simAcc += +arguments[0] || DT; return origTick.apply(this, arguments); };
      const samples = [];
      resetTele(true);
      setRunning(true);
      emit('running', 'Tuner starting…');
      const tick = () => {
        const now = performance.now();
        const hs = root.TunerHook ? root.TunerHook.stats : { evals: 0, ticks: 0, wallMs: 0 };
        const evals = hs.evals - (hs0.evals || 0);
        const total = tickCount;
        lastTotal = total; lastEvals = evals; lastSim = simAcc;
        samples.push([now, total]); while (samples.length > 2 && now - samples[0][0] > 2000) samples.shift();
        const rate = samples.length > 1 ? Math.max(0, (total - samples[0][1]) / ((now - samples[0][0]) / 1000)) : 0;
        const wall = (now - t0) / 1000, sim = simAcc;
        const evInfo = st.evalId ? (st.evalWaiting ? ' · ▶ eval #' + st.evalId + ' [' + (st.evalStop || '?') + ']…' : ' · ◀ eval #' + st.evalId) : '';
        const line = st.phase + evInfo + simInfo;
        $('tuiStat').textContent = line;
        $('tuiElapsed').textContent = fmtClock(wall);
        setHtml('tuiOps', S.running ? fmtBig(rate) + '<small>ops/s</small>' : '0<small>ops/s</small>');
        setHtml('tuiTotal', fmtBig(total) + '<small>ops</small>');
        setHtml('tuiSim', total > 0 ? fmtDur(sim) + (wall > 0.5 ? '<small class="x">×' + fmtBig(sim / wall) + '</small>' : '') : '–');
        $('tuiEvals').textContent = evals;
        $('tuiIter').textContent = st.iter != null ? st.iter : '–';
        $('tuiMeco').textContent = st.meco != null ? st.meco : '–';
        $('tuiLane').textContent = st.lane || '–';
        $('tuiLast').textContent = logBuf.length ? logBuf[logBuf.length - 1] : '';
        $('tuiLog').textContent = logBuf.slice(-300).join('\n');
        if (S.running) emit('running', line);
      };
      const timer = setInterval(tick, 500);
      try {
        if (!ref) throw new Error('no reference selected (no presets available?)');
        const p = U().fromRaw({ G: ref.G, T: ref.T != null ? ref.T : cfg.T0, bias: ref.bias, lead: ref.lead, meco: ref.meco });
        const stratName = $('tuiStrategy').value || 'guided';
        const strat = root.TunerCore.getStrategy(stratName);
        if (!strat) throw new Error('unknown strategy: ' + stratName);
        st.phase = '[' + stratName + '] starting';
        const res = await strat.runTuner(p, { mode, deorbit, env, targetAltKm: alt, abortRef: S.abortRef,
          onLog: (l) => { logBuf.push(l); parseLogLine(l, st); if (opts.log) opts.log(l); },
          onProgress: (q) => { simInfo = ' · t=' + fmt(q.simTime, 0) + 's ' + (q.phase || '') } });
        S.res = res; S.res.altKm = alt; S.sort = 'score'; renderResult();
        st.phase = res.ok ? 'done' : 'finished: ' + res.status;
      } catch (e) {
        st.phase = 'ERROR: ' + e.message; logBuf.push('ERROR: ' + e.message); console.error(e);
      } finally {
        clearInterval(timer);
        if (origTick && eng.tick !== origTick) eng.tick = origTick;
        cfg.fixed.deorbitEnabled = prevDeorbit;
        cfg.durationCapS = prevCap;
        setSearchDisabled(false);
        S.running = false; $('tuiRun').disabled = false; $('tuiStop').disabled = true;
        tick();
        // result line: whole-run totals (a new run resets everything above)
        const wallS = Math.max(0.001, (performance.now() - t0) / 1000), simS = lastSim, failed = /^ERROR/.test(st.phase) || /finished/.test(st.phase);
        if (lastTotal > 0) $('tuiRunSum').innerHTML = '<span class="k">RESULT</span>total <b>' + fmtBig(lastTotal) + '</b> ops · <b>' + lastEvals + '</b> evals · avg <b>' +
          fmtBig(lastEvals ? lastTotal / lastEvals : 0) + '</b> ops/eval · avg speed <b>' + fmtBig(lastTotal / wallS) + '</b> ops/s · wall <b>' + fmtDur(wallS) +
          '</b> · sim <b>' + fmtDur(simS) + '</b> (<b>×' + fmtBig(simS / wallS) + '</b>)';
        setRunning(false, failed ? 'error' : 'ready');
        emit(failed ? 'error' : 'ready', st.phase);
      }
    });

    fillConfigInputs();
    refreshDurCap(true);
    autoPickRef();
    updateStratDesc();
    return { state: S, render: renderResult };
  }

  root.TunerUI = { mount, rowJson, rowsJson, rowBlockHtml, tabsHtml, boardHtml, summaryLine, parseLogLine, keyValue, CFG_FIELDS, esc, fmt };
})();