// ============================================================================
// fleet-earth.js — Earth-from-orbit background for the Vehicle Fleet page.
//   • Real 3-D globe (WebGL): NASA-style day map with clouds, city-lights night
//     map, Milky-Way star map. Sunrise on the limb, atmosphere rim, sun flare,
//     ocean glint, orange twilight band, fine drifting cloud wisps.
//   • Globe spins slowly; scrolling spins it too and slides the sun lower, so
//     the night side (city lights) creeps into view.
//   • A canvas overlay adds rocket launches (with staging) and passing satellites.
//   • Dims while you type in a form. Falls back to a CSS gradient without WebGL.
// Textures come from js/earth-textures.js (window.EARTH_TEX).
// ============================================================================
(function () {
  var bg = document.getElementById('earthBg'), cv = document.getElementById('earthGL'), fx = document.getElementById('earthFX');
  if (!cv || !window.EARTH_TEX) { document.body.classList.add('no-gl'); return; }

  // ---- tweakables ---------------------------------------------------------
  var IDLE_SPIN = 0.012, SCROLL_SPIN = 0.0011, FPS = 30, RENDER_SCALE = 0.75, MAX_W = 1500;
  var LAUNCH_EVERY = [22, 36];     // seconds between rocket launches (min, max)
  var SAT_EVERY = [40, 70];        // seconds between satellite passes
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}';
  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
    'uniform vec2 uRes, uCenter, uSun; uniform float uRad, uRot, uTime, uSky, uFlare; uniform vec3 uL;',
    'uniform sampler2D tDay, tNight, tStars;',
    'const float PI = 3.14159265;',
    'vec2 sph(vec3 d){ return vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }',
    'float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }',
    'float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),',
    '             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }',
    'float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }',
    'void main(){',
    '  vec2 fc = gl_FragCoord.xy;',
    '  vec2 p = (fc - uCenter) / uRad;',
    '  float r = length(p), aa = 1.5 / uRad;',
    '  vec3 L = normalize(uL);',
    // deep space (Milky Way map is very dark, so it is boosted)
    '  vec2 nd = (fc - 0.5 * uRes) / uRes.y;',
    '  vec3 rd = normalize(vec3(nd * 1.7, -1.0));',
    '  float c0 = cos(uSky), s0 = sin(uSky);',
    '  rd = vec3(rd.x * c0 + rd.z * s0, rd.y, -rd.x * s0 + rd.z * c0);',
    '  vec3 st = texture2D(tStars, sph(rd)).rgb; float sl = max(st.r, max(st.g, st.b));',   // drop JPEG noise floor, keep real stars
    '  vec3 col = st * smoothstep(0.14, 0.50, sl) * 3.2 + st * 0.9 + vec3(0.003, 0.007, 0.012);',
    // atmosphere glow outside the limb
    '  vec2 dp = p / max(r, 1e-4);',
    '  float ls = dot(dp, normalize(L.xy + 1e-4));',
    '  float rr = max(r - 1.0, 0.0), litA = smoothstep(-0.45, 0.6, ls);',
    '  float g = (exp(-rr * 90.0) * 1.1 + exp(-rr * 22.0) * 0.20 + exp(-rr * 6.0) * 0.03) * (0.10 + 0.90 * litA) * (1.0 - smoothstep(0.25, 0.5, rr));',
    '  float sa = pow(clamp(ls * 0.5 + 0.5, 0.0, 1.0), 7.0);',
    '  vec3 gc = mix(vec3(0.20, 0.48, 1.0), vec3(1.0, 0.66, 0.34), sa);',
    '  col = col * (1.0 - min(g, 0.9) * 0.6) + gc * g;',
    '  if (r < 1.0 + aa){',
    '    vec2 q = p / max(r, 1.0);',
    '    vec3 N = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));',
    '    float ce = cos(0.40), se = sin(0.40), ca = cos(0.41), sn = sin(0.41), cs = cos(uRot), ss = sin(uRot);',
    '    vec3 v = vec3(N.x, N.y * ce - N.z * se, N.y * se + N.z * ce);',
    '    v = vec3(v.x * ca - v.y * sn, v.x * sn + v.y * ca, v.z);',
    '    vec3 pl = vec3(v.x * cs + v.z * ss, v.y, -v.x * ss + v.z * cs);',
    '    vec2 uv = sph(pl);',
    '    vec3 day = texture2D(tDay, uv).rgb, night = texture2D(tNight, uv).rgb;',
    '    float t = dot(N, L);',
    '    float lit = smoothstep(-0.06, 0.30, t), dif = max(t, 0.0);',
    '    float cl = smoothstep(0.50, 0.82, min(day.r, min(day.g, day.b)));',
    '    float ocean = smoothstep(0.03, 0.14, day.b - day.r) * (1.0 - cl);',
    '    float wisp = smoothstep(0.60, 0.80, fbm(pl * 7.0 + vec3(uTime * 0.015, 0.0, 0.0))) * 0.30;',
    '    day = mix(day, vec3(0.96), wisp * (1.0 - cl * 0.5)); cl = max(cl, wisp);',
    '    vec3 sunCol = mix(vec3(1.0, 0.52, 0.24), vec3(1.0, 0.97, 0.92), smoothstep(0.02, 0.6, t));',
    '    vec3 c = day * (sunCol * dif * 1.45 * lit + vec3(0.006, 0.010, 0.017));',
    '    c += vec3(1.0, 0.42, 0.14) * exp(-pow((t - 0.05) / 0.14, 2.0)) * (0.20 + 0.75 * cl);',     // twilight band
    '    c += sunCol * pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 70.0) * ocean * lit * 1.8;',   // ocean glint
    '    c += night * vec3(1.5, 1.1, 0.75) * 2.8 * (1.0 - smoothstep(-0.14, 0.06, t)) * (1.0 - 0.7 * cl);',   // city lights
    '    float fr = pow(1.0 - N.z, 2.6);',
    '    c += mix(vec3(0.20, 0.48, 1.0), vec3(1.0, 0.68, 0.38), sa) * fr * (0.15 + 1.3 * lit) * 1.2;',
    '    c = mix(c, vec3(0.30, 0.55, 1.0) * (0.25 + 0.9 * lit), pow(1.0 - N.z, 2.0) * 0.55);',
    '    vec3 disc = 1.0 - exp(-c * 1.35);',
    '    col = mix(col, disc, 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r));',
    '  }',
    // sun flare on the horizon
    '  vec2 d2 = (fc - uSun) / uRes.y; float dd = length(d2);',
    '  float fl = exp(-dd * dd * 7000.0) * 1.5 + 0.06 / (1.0 + dd * dd * 700.0);',
    '  fl += exp(-abs(d2.y) * 380.0) * exp(-abs(d2.x) * 4.5) * 0.5;',
    '  fl += exp(-abs(d2.x) * 260.0) * exp(-max(d2.y, 0.0) * 5.0) * step(0.0, d2.y) * 0.45;',
    '  col += vec3(1.0, 0.70, 0.36) * fl * uFlare;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) { document.body.classList.add('no-gl'); return; }
  function mk(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { if (window.console) console.warn('[Earth] shader:', gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  var vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { document.body.classList.add('no-gl'); return; }
  var prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { document.body.classList.add('no-gl'); return; }
  gl.useProgram(prog);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {};
  ['uRes', 'uCenter', 'uSun', 'uRad', 'uRot', 'uTime', 'uSky', 'uFlare', 'uL', 'tDay', 'tNight', 'tStars'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

  // ---- textures ---------------------------------------------------------------
  var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE), pending = 3, ready = false;
  function loadTex(key, unit) {
    var img = new Image();
    img.onload = function () {
      var src = img;
      if (img.width > maxTex) { var c = document.createElement('canvas'); c.width = maxTex; c.height = maxTex / 2; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); src = c; }
      var tx = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (--pending === 0) { ready = true; start(); }
    };
    img.onerror = function () { document.body.classList.add('no-gl'); };
    img.src = window.EARTH_TEX[key];
  }
  gl.uniform1i(U.tDay, 0); gl.uniform1i(U.tNight, 1); gl.uniform1i(U.tStars, 2);
  loadTex('day', 0); loadTex('night', 1); loadTex('stars', 2);

  // ---- layout: the globe rises from the bottom, limb at ~60% of the screen height ----
  var W = 0, H = 0, RW = 0, RH = 0, S = 1, R = 0, CX = 0, CY = 0, SUNX = 0, SUNY = 0;
  function limbY(x) { return CY - Math.sqrt(Math.max(0, R * R - (x - CX) * (x - CX))); }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    S = Math.min(RENDER_SCALE * Math.min(window.devicePixelRatio || 1, 2), MAX_W / W, 1);
    RW = cv.width = Math.round(W * S); RH = cv.height = Math.round(H * S);
    fx.width = W; fx.height = H;
    gl.viewport(0, 0, RW, RH);
    R = 0.62 * Math.max(W, H); CX = W * 0.5; CY = H * 0.6 + R;
    SUNX = W * 0.30; SUNY = limbY(SUNX) - H * 0.004;
  }

  // ---- state ----------------------------------------------------------------
  var idle = 0, spinS = 0, sf = 0, sfT = 0;
  function readScroll() { sfT = 1 - Math.exp(-(window.pageYOffset || 0) / Math.max(400, window.innerHeight * 1.2)); }
  window.addEventListener('scroll', function () { readScroll(); if (reduce && ready) frame(0, 0); }, { passive: true });
  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); if (ready) frame(0, 0); }, 120); });
  document.addEventListener('focusin', function (e) { if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) bg.classList.add('dim'); });
  document.addEventListener('focusout', function () { bg.classList.remove('dim'); });

  // ---- FX overlay: rocket launches + satellites -----------------------------
  var fctx = fx.getContext('2d'), launches = [], sats = [], nextL = 5, nextS = 14;
  function rnd(a) { return a[0] + Math.random() * (a[1] - a[0]); }
  function fxStep(dt) {
    nextL -= dt; nextS -= dt;
    if (nextL <= 0) { nextL = rnd(LAUNCH_EVERY); var x0 = W * (0.12 + 0.76 * Math.random()); launches.push({ x0: x0, y0: limbY(x0), dx: (Math.random() - 0.5) * W * 0.22, t: 0, tr: [], st: false, sep: null, flash: 0 }); }
    if (nextS <= 0) { nextS = rnd(SAT_EVERY); sats.push({ t: 0, dur: 34, y0: H * (0.10 + 0.22 * Math.random()), dir: Math.random() < 0.5 ? 1 : -1, tr: [] }); }
    var i, k;
    for (i = launches.length - 1; i >= 0; i--) {
      var l = launches[i]; l.t += dt; k = l.t / 10;
      if (k < 1) {
        var x = l.x0 + l.dx * Math.pow(k, 1.5), y = l.y0 - H * 0.62 * Math.pow(k, 1.7);
        l.hx = x; l.hy = y; l.tr.push({ x: x, y: y, a: 0 });
        if (k > 0.42 && !l.st) { l.st = true; l.flash = 0.35; l.sep = { x: x, y: y, vx: 26, vy: 34, tr: [] }; }
      }
      l.tr.forEach(function (p) { p.a += dt; });
      while (l.tr.length && l.tr[0].a > 2.6) l.tr.shift();
      if (l.flash > 0) l.flash -= dt;
      if (l.sep) { l.sep.x += l.sep.vx * dt; l.sep.y += l.sep.vy * dt; l.sep.vy += 30 * dt; l.sep.tr.push({ x: l.sep.x, y: l.sep.y, a: 0 }); l.sep.tr.forEach(function (p) { p.a += dt; }); while (l.sep.tr.length && l.sep.tr[0].a > 1.4) l.sep.tr.shift(); }
      if (k >= 1 && !l.tr.length) launches.splice(i, 1);
    }
    for (i = sats.length - 1; i >= 0; i--) {
      var s = sats[i]; s.t += dt; k = s.t / s.dur;
      var sx = s.dir > 0 ? -20 + (W + 40) * k : W + 20 - (W + 40) * k, sy = s.y0 + 46 * Math.sin(k * Math.PI);
      s.x = sx; s.y = sy; s.tr.push({ x: sx, y: sy, a: 0 }); s.tr.forEach(function (p) { p.a += dt; }); while (s.tr.length && s.tr[0].a > 3) s.tr.shift();
      if (k >= 1) sats.splice(i, 1);
    }
  }
  function trail(tr, life, w, rgb) {
    for (var j = 1; j < tr.length; j++) {
      var a = Math.max(0, 1 - tr[j].a / life);
      fctx.strokeStyle = 'rgba(' + rgb + ',' + (a * 0.55).toFixed(3) + ')'; fctx.lineWidth = Math.max(0.5, w * a);
      fctx.beginPath(); fctx.moveTo(tr[j - 1].x, tr[j - 1].y); fctx.lineTo(tr[j].x, tr[j].y); fctx.stroke();
    }
  }
  function glow(x, y, r, c) {
    var g = fctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(' + c + ',0.95)'); g.addColorStop(1, 'rgba(' + c + ',0)');
    fctx.fillStyle = g; fctx.beginPath(); fctx.arc(x, y, r, 0, 6.2832); fctx.fill();
  }
  function fxDraw(t) {
    fctx.clearRect(0, 0, W, H); fctx.globalCompositeOperation = 'lighter'; fctx.lineCap = 'round';
    launches.forEach(function (l) {
      trail(l.tr, 2.6, 2.6, '255,175,95');
      if (l.sep) trail(l.sep.tr, 1.4, 1.6, '190,210,255');
      if (l.t < 10) { glow(l.hx, l.hy, 7, '255,220,170'); }
      if (l.flash > 0) glow(l.hx, l.hy, 34 * (l.flash / 0.35) + 8, '200,225,255');
    });
    sats.forEach(function (s) {
      trail(s.tr, 3, 1.2, '190,220,255');
      glow(s.x, s.y, 3 + 1.6 * (0.5 + 0.5 * Math.sin(t * 3.1)), '235,245,255');
    });
    fctx.globalCompositeOperation = 'source-over';
  }

  // ---- frame ------------------------------------------------------------------
  function frame(t, dt) {
    var y = window.pageYOffset || 0;
    idle += IDLE_SPIN * dt;
    spinS += (y * SCROLL_SPIN - spinS) * (reduce ? 1 : 1 - Math.exp(-dt * 5));
    sf += (sfT - sf) * (reduce ? 1 : 1 - Math.exp(-dt * 4));
    var rot = idle + spinS, ux = (SUNX - CX) / R, uy = -(SUNY - CY) / R, zb = 0.32 + 0.38 * sf;
    gl.uniform2f(U.uRes, RW, RH);
    gl.uniform2f(U.uCenter, CX * S, RH - CY * S);
    gl.uniform1f(U.uRad, R * S);
    gl.uniform2f(U.uSun, SUNX * S, RH - SUNY * S);
    gl.uniform3f(U.uL, ux * 0.9, uy * 0.9, -zb);
    gl.uniform1f(U.uRot, rot); gl.uniform1f(U.uTime, t); gl.uniform1f(U.uSky, rot * 0.15); gl.uniform1f(U.uFlare, 1 - 0.55 * sf);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduce) { fxStep(dt); fxDraw(t); }
  }

  function start() {
    document.body.classList.add('has-earth');
    readScroll(); sf = sfT; spinS = (window.pageYOffset || 0) * SCROLL_SPIN;
    frame(0, 0);
    if (reduce) return;
    var t0 = performance.now(), last = t0, gap = 1000 / FPS - 2;
    (function loop(now) {
      requestAnimationFrame(loop);
      if (now - last < gap) return;
      var dt = Math.min(0.1, (now - last) / 1000); last = now;
      frame((now - t0) / 1000, dt);
    })(t0);
  }
  resize();
})();
