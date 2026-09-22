// ============================================================================
// techBayBackground.js — Holographic Assembly Bay backdrop for the
// Technology Bay page. Draws a slowly rotating wireframe hologram of the
// default engine layout (Octaweb, Merlin-class 8+1 — see
// componentLibrary.js's buildOctaweb9()): one gimbal-capable center engine
// ringed by 8 fixed outer engines at 45° spacing. A perspective floor grid,
// a scanning sweep, and a handful of drifting telemetry tags finish the
// "hologram in a dark engineering bay" read. Pure canvas 2D — no WebGL
// dependency, so it never needs a fallback path.
// ============================================================================

(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var cv = document.getElementById('holoCanvas');
  if (!cv) return;
  var ctx = cv.getContext('2d');

  var W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    W = cv.clientWidth;
    H = cv.clientHeight;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- tiny 3-D helpers -----------------------------------------------
  function rotY(p, a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
  }
  function rotX(p, a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  }

  var FOCAL = 480;
  function project(p, cx, cy, camZ, scale) {
    var z = p[2] + camZ;
    var k = FOCAL / (FOCAL + z);
    return { x: cx + p[0] * k * scale, y: cy + p[1] * k * scale, k: k, z: z };
  }

  // ---- build one engine bell (bell-curved radius, ring by ring) -------
  function buildBell(throatR, exitR, height, ribs, rings) {
    var out = [];
    for (var i = 0; i <= rings; i++) {
      var t = i / rings;
      var r = throatR + (exitR - throatR) * Math.pow(t, 0.62);
      var y = -t * height;
      var ring = [];
      for (var j = 0; j < ribs; j++) {
        var a = (j / ribs) * Math.PI * 2;
        ring.push([Math.cos(a) * r, y, Math.sin(a) * r]);
      }
      out.push(ring);
    }
    return out;
  }

  var RIBS = 10, RINGS = 4;
  var outerBell = buildBell(5.2, 9.5, 26, RIBS, RINGS);
  var centerBell = buildBell(6.4, 11.5, 30, RIBS, RINGS); // slightly larger — the gimbal-capable one

  var RING_RADIUS = 46;
  var outerSlots = [];
  for (var s = 0; s < 8; s++) {
    var ang = (s / 8) * Math.PI * 2;
    outerSlots.push({ x: Math.cos(ang) * RING_RADIUS, z: Math.sin(ang) * RING_RADIUS });
  }

  var GRID_HALF = 260, GRID_STEP = 26, GRID_Y = 34;

  // xf: world -> camera transform for this frame (spin + tilt + bob composed once)
  function drawFloor(t, xf, cx, cy, camZ, scale) {
    ctx.save();
    ctx.lineWidth = 1;
    var scroll = (t * 6) % GRID_STEP;
    for (var gx = -GRID_HALF; gx <= GRID_HALF; gx += GRID_STEP) {
      var pa = project(xf([gx, GRID_Y, -GRID_HALF]), cx, cy, camZ, scale);
      var pb = project(xf([gx, GRID_Y, GRID_HALF]), cx, cy, camZ, scale);
      if (pa.k < 0.05 || pb.k < 0.05) continue;
      ctx.globalAlpha = 0.55 * Math.min(pa.k, pb.k);
      ctx.strokeStyle = 'rgba(53,214,255,0.14)';
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    for (var gz = -GRID_HALF + scroll; gz <= GRID_HALF; gz += GRID_STEP) {
      var pa2 = project(xf([-GRID_HALF, GRID_Y, gz]), cx, cy, camZ, scale);
      var pb2 = project(xf([GRID_HALF, GRID_Y, gz]), cx, cy, camZ, scale);
      if (pa2.k < 0.05 || pb2.k < 0.05) continue;
      ctx.globalAlpha = 0.55 * Math.min(pa2.k, pb2.k);
      ctx.strokeStyle = 'rgba(53,214,255,0.14)';
      ctx.beginPath(); ctx.moveTo(pa2.x, pa2.y); ctx.lineTo(pb2.x, pb2.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawBell(bell, offset, xf, cx, cy, camZ, scale, tint, highlight) {
    var projRings = bell.map(function (ring) {
      return ring.map(function (p) {
        var wp = xf([p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]);
        return project(wp, cx, cy, camZ, scale);
      });
    });

    ctx.lineWidth = highlight ? 1.6 : 1.1;
    for (var r = 0; r < projRings.length; r++) {
      var ring = projRings[r];
      ctx.beginPath();
      for (var i = 0; i <= ring.length; i++) {
        var pt = ring[i % ring.length];
        if (pt.k < 0.05) continue;
        if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      }
      var depthA = Math.max(0.18, Math.min(1, 1.15 - r / projRings.length));
      ctx.strokeStyle = tint(depthA);
      ctx.stroke();
    }
    for (var j = 0; j < RIBS; j++) {
      ctx.beginPath();
      var started = false;
      for (var r2 = 0; r2 < projRings.length; r2++) {
        var pt2 = projRings[r2][j];
        if (pt2.k < 0.05) continue;
        if (!started) { ctx.moveTo(pt2.x, pt2.y); started = true; }
        else ctx.lineTo(pt2.x, pt2.y);
      }
      ctx.strokeStyle = tint(0.55);
      ctx.stroke();
    }
  }

  // Gimbal actuator struts for the center engine — two short diagonals
  // from the throat outward, a small hardware detail that reads as
  // "this one moves".
  function drawGimbalStruts(offset, xf, cx, cy, camZ, scale) {
    var throatY = offset[1];
    var bases = [
      [offset[0] - 9, throatY + 7, offset[2] - 2],
      [offset[0] + 9, throatY + 7, offset[2] + 3],
    ];
    ctx.strokeStyle = 'rgba(255,146,72,0.75)';
    ctx.lineWidth = 1.3;
    var pBot = project(xf([offset[0], throatY, offset[2]]), cx, cy, camZ, scale);
    bases.forEach(function (base) {
      var pTop = project(xf(base), cx, cy, camZ, scale);
      if (pTop.k < 0.05 || pBot.k < 0.05) return;
      ctx.beginPath(); ctx.moveTo(pTop.x, pTop.y); ctx.lineTo(pBot.x, pBot.y); ctx.stroke();
    });
  }

  var t0 = performance.now();

  function tint(depth) {
    var a = 0.12 + depth * 0.46;
    return 'rgba(53,214,255,' + a.toFixed(3) + ')';
  }
  function tintCenter(depth) {
    var a = 0.16 + depth * 0.55;
    return 'rgba(255,178,120,' + a.toFixed(3) + ')';
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);

    var cx = W * 0.5;
    var cy = 168;                    // anchored to the top hero zone, not full viewport height
    var scale = Math.min(W, 900) * 0.0078;
    var camZ = 260;
    var rotYAngle = t * 0.09;
    var bob = Math.sin(t * 0.35) * 0.035;
    var tiltBase = -0.62;

    var xf = function (p) { return rotX(rotY(p, rotYAngle), tiltBase + bob); };

    drawFloor(t, xf, cx, cy, camZ, scale);

    outerSlots.forEach(function (slot) {
      drawBell(outerBell, [slot.x, 0, slot.z], xf, cx, cy, camZ, scale, tint, false);
    });
    drawBell(centerBell, [0, 3, 0], xf, cx, cy, camZ, scale, tintCenter, true);
    drawGimbalStruts([0, 3, 0], xf, cx, cy, camZ, scale);

    // ---- scan sweep ---------------------------------------------------
    var scanPhase = (t * 46) % (H + 220) - 110;
    var grad = ctx.createLinearGradient(0, scanPhase - 60, 0, scanPhase + 60);
    grad.addColorStop(0, 'rgba(53,214,255,0)');
    grad.addColorStop(0.5, 'rgba(53,214,255,0.07)');
    grad.addColorStop(1, 'rgba(53,214,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    var edgeGrad = ctx.createLinearGradient(0, scanPhase - 2, 0, scanPhase + 2);
    edgeGrad.addColorStop(0, 'rgba(53,214,255,0)');
    edgeGrad.addColorStop(0.5, 'rgba(180,235,255,0.22)');
    edgeGrad.addColorStop(1, 'rgba(53,214,255,0)');
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(0, scanPhase - 2, W, 4);
  }

  function loop(now) {
    requestAnimationFrame(loop);
    draw((now - t0) / 1000);
  }

  if (reduce) {
    draw(0.001);
  } else {
    requestAnimationFrame(loop);
  }
})();
