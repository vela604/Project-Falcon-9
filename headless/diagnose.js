#!/usr/bin/env node
// ============================================================================
// headless/diagnose.js — single-run per-tick dump of guidance internals.
// Runs leoInsertionV2 for N seconds, prints phase + control state every
// 0.5s. Use to find WHERE the ascent controller fails.
//
//   node headless/diagnose.js --duration 120
//   node headless/diagnose.js --duration 120 --ics 4 --pt 4 --pd 0.4
// ============================================================================

const { runSim } = require('./runner');

function parseArgs(argv) {
  const out = { durationS: 120, ics: 4.9, pt: 4.8, pd: 0.16, every: 0.5 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--duration') out.durationS = parseFloat(argv[++i]);
    else if (a === '--ics') out.ics = parseFloat(argv[++i]);
    else if (a === '--pt') out.pt = parseFloat(argv[++i]);
    else if (a === '--pd') out.pd = parseFloat(argv[++i]);
    else if (a === '--every') out.every = parseFloat(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv);
console.log('=== diagnose ===');
console.log('ics=' + args.ics + ' pt=' + args.pt + ' pd=' + args.pd);
console.log('duration=' + args.durationS + 's');
console.log('');

// Load instance with a tiny warmup run so we get sim handle.
const warm = runSim({ durationS: 0.05, quiet: true });
const sim = warm.sim;

sim.reset(0);
sim.setEnvironment({ atmosphere: true, slosh: true, imu: false });
sim.applyTunables('leoInsertionV2', [
  { path: 'ASCENT.INITIAL_COAST_S',     value: args.ics },
  { path: 'ASCENT.PUSH_T_S',            value: args.pt },
  { path: 'ASCENT.PUSH_MAX_GIMBAL_DEG', value: args.pd },
]);
sim.setFueling(100, 100);
sim.startGuide('leoInsertionV2');

const dt = sim.CONFIG.DT;
const totalTicks = Math.ceil(args.durationS / dt);
const everyTicks = Math.max(1, Math.round(args.every / dt));

console.log('t(s)  phase         alt(km)   vr      vH      tilt°    AoA°    w_AoA     gimbal°  tau_des    Q(kPa)  thr(MN)  cr');
console.log('-'.repeat(120));

for (let i = 0; i < totalTicks; i++) {
  sim.step(1);
  if ((i + 1) % everyTicks !== 0) continue;

  const st = sim.getStatus();
  const gs = st.guideStatus || {};
  const a = st.bodies.find(b => b.isActive) || st.bodies[0];
  if (!a) break;

  const rr = Math.hypot(a.rx, a.ry) || 1;
  const vr = (a.vx * a.rx + a.vy * a.ry) / rr;
  // East component of velocity, ground-relative. East unit vector is
// (ry/r, -rx/r) per the sim's convention. Pad baseline (~465 m/s east
// in inertial) is subtracted so t=0 reads 0.
const vH = (a.vx * a.ry - a.vy * a.rx) / rr - 465.1;
  const localVert = Math.atan2(-a.rx, a.ry);
  const tiltDeg = (a.theta - localVert) * 180 / Math.PI;

  // Guidance status has these for ascentAoaHold:
  const aoaDeg = Number.isFinite(gs.aoaDeg) ? gs.aoaDeg : 0;
  const omegaAoA = Number.isFinite(gs.omegaAoANow) ? gs.omegaAoANow : 0;
  const gimbalDeg = Number.isFinite(gs.gReqDeg) ? gs.gReqDeg : (Number.isFinite(gs.gRadN) ? gs.gRadN : 0);
  const tauDes = Number.isFinite(gs.tauDesired) ? gs.tauDesired : 0;
  const QkPa = Number.isFinite(gs.Q) ? gs.Q / 1000 : 0;
  const thrMN = (a.engines || []).reduce((s, e) => s + (e.currentF || 0), 0) / 1e6;

  console.log(
    st.simTime.toFixed(1).padStart(6) +
    '  ' + (gs.phase || '?').padEnd(12) +
    '  ' + a.altitudeKm.toFixed(2).padStart(7) +
    '  ' + vr.toFixed(0).padStart(6) +
    '  ' + vH.toFixed(0).padStart(6) +
    '  ' + tiltDeg.toFixed(1).padStart(6) +
    '  ' + aoaDeg.toFixed(2).padStart(6) +
    '  ' + omegaAoA.toExponential(1).padStart(9) +
    '  ' + gimbalDeg.toFixed(3).padStart(7) +
    '  ' + tauDes.toExponential(2).padStart(10) +
    '  ' + QkPa.toFixed(1).padStart(6) +
    '  ' + thrMN.toFixed(2).padStart(7) +
    '  ' + (st.crashed ? 'Y' : 'N')
  );

  if (st.crashed) {
    console.log('--- crashed at t=' + st.simTime.toFixed(2) + 's ---');
    break;
  }
}

sim.stopGuide();
console.log('');
console.log('done');