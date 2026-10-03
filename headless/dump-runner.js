// headless/dump-runner.js
const { runSim } = require('./runner');
const fs = require('fs');
const path = require('path');

const warm = runSim({ durationS: 0.001, quiet: true });
const sim = warm.sim;
sim.reset(0);
sim.setEnvironment({ atmosphere: true, slosh: true, imu: false,
  wind: { enabled: false, speed: 0, directionDeg: 0 } });
sim.setFueling(100, 100);
sim.startGuide('leoInsertionV3');

const dt = sim.CONFIG.DT;
const N = Math.round(200 / dt);  // 200 sec
const rows = [];
for (let i = 0; i < N; i++) {
  sim.step(1);
  const s = sim.state;
  rows.push({
    i, t: s.simTime,
    activeBodyIndex: s.activeBodyIndex,
    bodies: s.bodies.map(b => ({
      rx: b.rx, ry: b.ry, vx: b.vx, vy: b.vy,
      theta: b.theta, omega: b.omega,
      fuelMass: b.fuelMass,
      memberFuel: (b.memberFuel || []).slice(),
      engines: (b.engines || []).map(e => ({
        massFlowRate: e.massFlowRate,
        gimbalDeg: e.gimbalDeg,
        currentF: e.currentF,
      })),
    })),
  });
}
fs.writeFileSync(path.resolve(__dirname, '..', 'runner-dump.json'),
  JSON.stringify(rows));
console.log('Wrote', rows.length, 'ticks');