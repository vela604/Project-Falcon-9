## Step 3 — Baseline + calibration

| metric | raw defaults | lattice-snapped | delta |
|---|---|---|---|
| deploy time s | 590.46 | 590.46 | 0.00 |
| payload apogee km | 320.111 | 320.111 | 0.000 |
| payload perigee km | 319.999 | 319.999 | 0.000 |
| eccentricity | 0.0000083 | 0.0000083 | 0.0000000 |
| maxQ kPa | 24.75 | 24.75 | 0.00 |
| maxG own | 4.815 | 4.815 | 0.000 |
| maxG sim-raw | 5.300 | 5.300 | 0.000 |
| circ min vr m/s | -0.380 | -0.380 | 0.000 |
| circ vr at burn end | 0.046 | 0.046 | 0.000 |
| circEndMarginS (target 4.0) | 6.734 | 6.734 | 0.000 |
| booster fuel @split kg | 52625 | 52625 | 0 |
| stage residual kg (0-50) | 848.7 | 848.7 | 0.0 |
| MECO time s | 134.70 | 134.70 | 0.00 |
| score | -525.657 | -525.657 | 0.000 |

- G-load: liftoff 1.39 g, own max 4.82 g, sim-raw max 5.30 g, raw/own median 1.02 (p5 0.89, p95 1.08) -> verified
- calibrated: maxQ limit 31 kPa, durationCapS 770 s, maxG enabled @ 6.02 g
- determinism: in-process bit-identical, fresh process bit-identical
