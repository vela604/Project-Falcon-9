// primitives.js — search algorithm building blocks.
// Load order: AFTER lib/hook.js + lib/registry.js, BEFORE engines/*.js.
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

function pickReference(cfg, altKm) {
  const refs = (cfg.references || []).slice();
  if (!refs.length) return null;
  const a = altKm != null ? altKm : ((cfg.fixed && cfg.fixed.targetAltKm) || 320);
  refs.sort((x, y) => Math.abs((x.alt != null ? x.alt : 320) - a) - Math.abs((y.alt != null ? y.alt : 320) - a));
  return refs[0];
}

function residualBand(opts) {
    opts = opts || {};
    const Cfg = root.TunerConfig, L = Cfg.limits;
    const on = opts.deorbit != null ? !!opts.deorbit : !!(Cfg.fixed && Cfg.fixed.deorbitEnabled);
    return (on ? (L.residualTargetDeorbitOnKg || [500, 600]) : (L.residualTargetKg || [100, 200])).slice();
  }

  // ---- tuneLeadV2: edge by apside-crossing count, window by release-apside time, FULL-score search in window ----
  // o: { li0, cross(li)->{cross,tToApo,tToPeri,marginS}, full(li)->{score,done,ok,cross}, marginMaxS=20, maxLi=4000, maxWin=40 }
  async function tuneLeadV2(o) {
  const M = o.marginMaxS || 20, maxLi = o.maxLi || 4000, maxWin = o.maxWin || 40;
  const ROLL = o.maxRoll || 3, FB = o.fallbackSpan || 10, FB_FULLS = o.fallbackFulls || 8;
  const log = [], say = (s) => { log.push(s); if (o.onLog) o.onLog(s); };
  const cc = new Map(), fc = new Map(), vc = new Map(); let nC = 0, nF = 0;
  const cross = async (li) => { if (!cc.has(li)) { nC++; cc.set(li, await o.cross(li)); } return cc.get(li); };
  const full  = async (li) => { if (!fc.has(li)) { nF++; fc.set(li, await o.full(li)); } return fc.get(li); };
  const clamp = (x) => Math.max(0, Math.min(maxLi, x));
  const fin = (x) => Object.assign({ evals: nC + nF, crossEvals: nC, fullEvals: nF, log }, x);
  const isNum = (x) => typeof x === 'number' && !Number.isNaN(x);
  const scoreOf = (r) => (r && r.done && Number.isFinite(r.score)) ? r.score : Infinity;
  const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '-';

  const view = async (li) => {
    if (vc.has(li)) return vc.get(li);
    const r = await cross(li);
    const valid = !!r && Number.isFinite(r.cross);
    const nanA = !(r && isNum(r.tToApo)), nanP = !(r && isNum(r.tToPeri));
    const ta = nanA ? 0 : r.tToApo, tp = nanP ? 0 : r.tToPeri;
    const v = { li, valid, c: valid ? r.cross : NaN, ta, tp, tmin: Math.min(ta, tp), mode: tp < ta ? 'PERI' : 'APO', nan: nanA || nanP };
    vc.set(li, v); return v;
  };

  const isOne = async (li) => { const v = await view(li); return v.valid ? v.c === 1 : null; };
  let slope = o.slopeSPerTick || 1.4;
  const stepFor = (v) => (v.valid && (v.c === 1 || v.c === 2) && Number.isFinite(v.tmin)) ? Math.max(1, Math.min(256, Math.round(v.tmin / slope))) : null;
  const findB1 = async (seed) => {
    seed = clamp(seed);
    const s = await isOne(seed); if (s === null) return null;
    let A = seed, B = null, vA = await view(seed), step = stepFor(vA) || 1;
    while (B === null) {
      const p = clamp(A + (s ? step : -step));
      if (p === A) return null;
      const vp = await view(p); if (!vp.valid) return null;
      if ((vp.c === 1) === s) {
        if (vA.c === vp.c && (vp.c === 1 || vp.c === 2)) { const sl = Math.abs(vp.tmin - vA.tmin) / Math.abs(p - A); if (sl >= 0.3 && sl <= 5) slope = sl; }
        A = p; vA = vp; step = stepFor(vp) || step * 2;
      } else B = p;
    }
    while (Math.abs(A - B) > 1) {
      const m = Math.floor((A + B) / 2), sm = await isOne(m); if (sm === null) return null;
      if (sm === s) A = m; else B = m;
    }
    return s ? A : B;
  };
  const b1 = await findB1(o.li0);
  let result = null;

  const buildWindow = async (seed, dir) => {
    const cv = seed.v.c, v0 = seed.li, lim = maxWin - 1;
    const okAt = async (li) => { if (li < 0 || li > maxLi) return false; const x = await view(li); return x.valid && x.c === cv && x.tmin <= M; };
    let good = v0, bad = null, step = 1;
    while (bad === null && Math.abs(good - v0) < lim) {
      let p = clamp(good + dir * step);
      if (Math.abs(p - v0) > lim) p = v0 + dir * lim;
      if (p === good) { bad = p; break; }
      if (await okAt(p)) { good = p; step *= 2; } else bad = p;
    }
    while (bad !== null && bad !== good && Math.abs(bad - good) > 1) {
      const m = Math.floor((bad + good) / 2);
      if (await okAt(m)) good = m; else bad = m;
    }
    const N = Math.min(maxWin, Math.abs(good - v0) + 1), W = [];
    for (let k = 0; k < N; k++) W.push(v0 + dir * k);
    return W;
  };
  const pickBest = (W) => {
    let best = null, anyDone = null;
    for (const li of W) {
      const r = fc.get(li); if (!r || !r.done) continue;
      if (!anyDone) anyDone = { li, score: scoreOf(r), r };
      if (Number.isFinite(r.score) && (!best || r.score < best.score)) best = { li, score: r.score, r };
    }
    return best || anyDone;
  };
  const searchWindow = async (W) => {
    const N = W.length, f = async (k) => scoreOf(await full(W[k]));
    let L = 0, R = N - 1; const PHI = 0.618;
    while (R - L > 3) {
      let x1 = Math.round(L + (1 - PHI) * (R - L)), x2 = Math.round(L + PHI * (R - L));
      if (x2 <= x1) x2 = x1 + 1;
      if ((await f(x1)) <= (await f(x2))) R = x2; else L = x1;
    }
    for (let k = L; k <= R; k++) await f(k);
    return pickBest(W);
  };

  if (b1 != null) {
    let e2 = null;
    for (let j = b1 + 1; j <= b1 + 4 && j <= maxLi; j++) { const v = await view(j); if (v.valid && v.c === 2) { e2 = j; break; } }
    const lowLi = b1 - 1, highLi = (e2 != null ? e2 : b1 + 2) + 1;
    const sides = [];
    if (lowLi >= 0)    sides.push({ name: 'below(c1)', start: lowLi,  dir: -1, want: 1, v: await view(lowLi) });
    if (highLi <= maxLi) sides.push({ name: 'above(c2)', start: highLi, dir: +1, want: 2, v: await view(highLi) });
    for (const s of sides) say('edge 1|2 at ' + b1 + '|' + (b1 + 1) + (e2 != null ? ' (c2 from ' + e2 + ')' : ' (no c2 seen)') + '  ' + s.name + ' li ' +
      s.start + ' c' + s.v.c + ' tApo ' + f1(s.v.ta) + ' tPeri ' + f1(s.v.tp) + (s.v.nan ? ' [NaN->0]' : ''));

    const cand = sides.filter((s) => s.v.valid && s.v.c === s.want).sort((x, y) => x.v.tmin - y.v.tmin);
    for (const s of cand) {
      let seed = null;
      for (let i = 0; i < ROLL; i++) {
        const li = s.start + s.dir * i; if (li < 0 || li > maxLi) break;
        const v = await view(li);
        if (!v.valid || v.c !== s.want || v.tmin > M) continue;
        const ff = await full(li);
        say(s.name + ' li ' + li + ' (c' + v.c + ' ' + v.mode + ' ' + f1(v.tmin) + 's) FULL done ' + !!(ff && ff.done) + ' score ' + f1(ff && ff.score));
        if (ff && ff.done) { seed = { li, v }; break; }
      }
      if (!seed) continue;
      const W = await buildWindow(seed, s.dir);
      say(s.name + ' window ' + W[0] + '..' + W[W.length - 1] + ' (' + W.length + ' ticks)');
      if (o.windowOnly) return fin({ ok: true, mode: seed.v.mode, edgeK: 1, edge: [b1, b1 + 1], W, rows: Array.from(fc.values()) });
      const best = await searchWindow(W);
      if (best) { result = { s, W, best, edge: [b1, b1 + 1] }; break; }
    }
  } else say('no 1|2 edge found from li0=' + o.li0);

  if (!result) {
    const gate = o.earlyGateS || 100;
    const seen = Array.from(vc.values()).filter((v) => v.valid && (v.c === 1 || v.c === 2) && v.tmin <= gate).sort((x, y) => x.tmin - y.tmin);
    for (const v of seen.slice(0, 2)) {
      const ff = await full(v.li);
      say('early seed li ' + v.li + ' (c' + v.c + ' ' + v.mode + ' ' + f1(v.tmin) + 's) FULL done ' + !!(ff && ff.done) + ' score ' + f1(ff && ff.score));
      if (!(ff && ff.done)) continue;
      const dir = v.c === 1 ? -1 : +1;
      const W = await buildWindow({ li: v.li, v }, dir);
      const best = await searchWindow(W);
      if (best) { result = { s: { name: 'early-seed' }, W, best, edge: [v.li, v.li + 1] }; break; }
    }
  }

  if (!result) {
    const ctr = b1 != null ? b1 : o.li0;
    say('fallback: +-' + FB + ' around ' + ctr);
    const cands = [];
    for (let li = ctr - FB; li <= ctr + FB + 2; li++) {
      if (li < 0 || li > maxLi) continue;
      const v = await view(li);
      if (v.valid && (v.c === 1 || v.c === 2) && v.tmin <= M) cands.push(v);
    }
    cands.sort((x, y) => x.tmin - y.tmin);
    const W = [];
    for (const v of cands.slice(0, FB_FULLS)) { await full(v.li); W.push(v.li); }
    const best = pickBest(W);
    if (!best) return fin({ ok: false, reason: 'no done tick: b1=' + b1 + ' li0=' + o.li0 + ' fallback cands ' + cands.length, edge: [b1, b1 == null ? null : b1 + 1], window: [] });
    W.sort((a, b) => a - b);
    result = { s: { name: 'fallback' }, W, best, edge: [ctr, ctr + 1] };
  }

  const { s, W, best, edge } = result;
  const mode = (await view(best.li)).mode;
  say('WINNER ' + s.name + ' li ' + best.li + ' mode ' + mode);
  return fin({ ok: !!best.r.done, mode, edgeK: 1, edge, window: [W[0], W[W.length - 1]], W,
    rows: Array.from(fc.values()), leadTicks: best.li, bestScore: best.score, full: best.r });
}

  Object.assign(T, {
    tuneLeadV2,
    pickReference, residualBand,
  });
})();
