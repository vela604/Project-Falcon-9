// headless/dump-runner.js
const { runSim } = require('./runner');
const fs = require('fs');
const path = require('path');

// Get the sim handle by running a warmup
const warm = runSim({ durationS: 0.001, quiet: true });
const sim = warm.sim;

// Reset to fresh state
sim.reset(0);
sim.setEnvironment({
  atmosphere: true, slosh: true, imu: false,
  wind: { enabled: false, speed: 0, directionDeg: 0 },
});
sim.setFueling(100, 100);
sim.startGuide('leoInsertionV2');

const dt = sim.CONFIG.DT;
const DURATION_S = 200;
const N = Math.round(DURATION_S / dt);
const rows = [];

for (let i = 0; i < N; i++) {
  sim.step(1);
  const s = sim.state;
  rows.push({
    i,
    t: s.simTime,
    bodies: s.bodies.map(b => ({
      rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy,
      theta: b.theta, omega: b.omega,
      fuelMass: b.fuelMass,
      memberFuel: (b.memberFuel || []).slice(),
      slosh: b.slosh ? { offset: b.slosh.offset, velocity: b.slosh.velocity } : null,
      engines: (b.engines || []).map(e => ({
        massFlowRate: e.massFlowRate,
        gimbalDeg: e.gimbalDeg,
        currentF: e.currentF,
      })),
    })),
  });
}

const out = path.resolve(__dirname, '..', 'runner-dump.json');
fs.writeFileSync(out, JSON.stringify(rows));
console.log('Wrote ' + rows.length + ' ticks to ' + out);