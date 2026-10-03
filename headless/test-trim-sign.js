#!/usr/bin/env node
// Determines: does prograde Δv move the earth-fixed impact point east or west?
// If prograde moves it WEST, then the code's sign (dLambda>0 → retrograde)
// is correct. If prograde moves it EAST, the sign is inverted.

const μ = 3.986004418e14;
const R = 6371000;
const ω_e = 7.2921159e-5;
const dt = 2;

function predictImpact(r0, v0, simTimeStart) {
  let rx = 0, ry = r0;
  let vx = v0, vy = 0;
  let t = 0;
  while (t < 4000) {
    const r = Math.hypot(rx, ry);
    if (r <= R) {
      const phiI = Math.atan2(rx, ry);
      const phiEf = phiI - ω_e * (simTimeStart + t);
      return { phiEf, tImpact: t };
    }
    const r3 = r * r * r;
    const ax = -μ * rx / r3, ay = -μ * ry / r3;
    const vxh = vx + 0.5 * ax * dt;
    const vyh = vy + 0.5 * ay * dt;
    const nx = rx + vxh * dt, ny = ry + vyh * dt;
    const nr = Math.hypot(nx, ny);
    const nr3 = nr * nr * nr;
    vx = vxh + 0.5 * (-μ * nx / nr3) * dt;
    vy = vyh + 0.5 * (-μ * ny / nr3) * dt;
    rx = nx; ry = ny;
    t += dt;
  }
  return null;
}

const r0 = R + 320000;
const t_start = 700;

console.log('Prograde moves impact which way?');
console.log('');
[6990, 7000, 7010].forEach((v) => {
  const res = predictImpact(r0, v, t_start);
  if (!res) { console.log('  v=' + v + ' m/s: no impact'); return; }
  console.log('  v=' + v + ' m/s: impact phiEf=' +
    (res.phiEf * 180 / Math.PI).toFixed(4) + '°  t_impact=' +
    res.tImpact + 's');
});
console.log('');
console.log('If phiEf grows with v (7010 > 7000 > 6990):');
console.log('  → PROGRADE moves impact EAST');
console.log('  → code sign is INVERTED (should flip "up"/"dn")');
console.log('');
console.log('If phiEf shrinks with v (7010 < 7000 < 6990):');
console.log('  → PROGRADE moves impact WEST');
console.log('  → code sign is CORRECT');