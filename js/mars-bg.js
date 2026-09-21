// ============================================================================
// mars-bg.js — centred, rotating 3-D Mars (WebGL) + starfield for the home page.
//   • Mars is a lit sphere ray-shaded per pixel: procedural terrain (rust plains,
//     dark basalt, craters with bump-mapped rims, polar caps), sun from the
//     upper right, dusty atmosphere glow. It sits in the exact centre.
//   • Spin = slow idle rotation + your scroll (scroll down/up spins it either way).
//   • Scrolling also eases the planet back a little; pointer adds a light parallax.
// If WebGL is missing, a CSS-gradient planet is shown instead.
// ============================================================================
(function () {
  var stage = document.getElementById('marsStage'), cv = document.getElementById('mars');
  var scv = document.getElementById('stars');
  if (!stage || !cv) return;

  // ---- tweakables ----------------------------------------------------------
  var IDLE_SPIN = 0.11;      // rad/s when nobody scrolls
  var SCROLL_SPIN = 0.0016;  // rad per scrolled pixel
  var MAX_PX = 760;          // max render size of the planet canvas (perf)
  var FPS = 30;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- starfield -------------------------------------------------------------
  var sctx = scv && scv.getContext('2d'), stars = [], SW = 0, SH = 0;
  var TINTS = ['255,240,230', '255,205,170', '190,210,255'];
  function buildStars() {
    if (!sctx) return;
    SW = scv.width = window.innerWidth; SH = scv.height = window.innerHeight;
    var n = Math.min(320, Math.round(SW * SH / 4800));
    stars = [];
    for (var i = 0; i < n; i++) stars.push({
      x: Math.random() * SW, y: Math.random() * SH, d: Math.random(),
      r: 0.35 + Math.random() * Math.random() * 1.5, a: 0.25 + Math.random() * 0.6,
      sp: 0.6 + Math.random() * 2.2, ph: Math.random() * 6.28, c: TINTS[(Math.random() * 3.2) | 0 > 2 ? 2 : (Math.random() * 3) | 0]
    });
  }
  function drawStars(t, sy) {
    if (!sctx) return;
    sctx.clearRect(0, 0, SW, SH);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i], y = ((s.y - sy * (0.03 + 0.12 * s.d)) % SH + SH) % SH;
      var a = s.a * (0.7 + 0.3 * Math.sin(t * s.sp + s.ph));
      sctx.fillStyle = 'rgba(' + s.c + ',' + a.toFixed(3) + ')';
      if (s.r < 0.9) sctx.fillRect(s.x, y, s.r * 1.6, s.r * 1.6);
      else { sctx.beginPath(); sctx.arc(s.x, y, s.r, 0, 6.2832); sctx.fill(); }
    }
  }

  // ---- Mars shader -------------------------------------------------------------
  var VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}';
  var FRAG = [
    '#extension GL_OES_standard_derivatives : enable',
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 uRes; uniform float uRad, uRot, uTime; uniform vec3 uLight;',

    'float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }',
    'float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),',
    '             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }',
    'float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }',
    // nearest feature point (craters): x = distance, y = cell id
    'vec2 cell(vec3 p){ vec3 i = floor(p), f = fract(p); float md = 8.0, id = 0.0;',
    '  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){',
    '    vec3 g = vec3(float(x), float(y), float(z));',
    '    vec3 o = vec3(h31(i + g), h31(i + g + 17.3), h31(i + g + 41.7));',
    '    float d = length(g + o - f); if (d < md){ md = d; id = h31(i + g + 5.5); } }',
    '  return vec2(md, id); }',

    'void main(){',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRad;',
    '  float r = length(p), aa = 1.6 / uRad;',
    '  vec3 L = normalize(uLight);',
    '  vec3 disc = vec3(0.0);',
    '  if (r < 1.0 + aa){',
    '    vec2 q = p / max(r, 1.0);',
    '    vec3 N = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));',
    // to planet-local coords: look-from-above, axial tilt, spin
    '    float ce = cos(0.30), se = sin(0.30), ca = cos(0.44), sa = sin(0.44), cs = cos(uRot), ss = sin(uRot);',
    '    vec3 v = vec3(N.x, N.y * ce - N.z * se, N.y * se + N.z * ce);',
    '    v = vec3(v.x * ca - v.y * sa, v.x * sa + v.y * ca, v.z);',
    '    vec3 pl = vec3(v.x * cs + v.z * ss, v.y, -v.x * ss + v.z * cs);',

    '    float a = fbm(pl * 1.5 + 4.1);',
    '    float b = fbm(pl * 4.2 + a * 2.0);',
    '    float d = fbm(pl * 14.0);',
    '    vec2 cr = cell(pl * 8.0);',
    '    float has = step(cr.y, 0.28), cR = 0.16 + 0.22 * cr.y, t0 = cr.x / cR;',
    '    float bowl = (1.0 - smoothstep(0.0, 1.0, t0)) * has;',
    '    float rim = exp(-pow((t0 - 1.0) * 5.0, 2.0)) * has;',
    '    float h = 0.22 * a + 0.09 * b + 0.015 * d + 0.07 * (rim * 0.55 - bowl * 0.9);',

    '    vec3 N2 = N;',
    '#ifdef GL_OES_standard_derivatives',
    '    vec3 P = vec3(q, N.z);',
    '    vec3 dpx = dFdx(P), dpy = dFdy(P);',
    '    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);',
    '    float det = dot(dpx, r1);',
    '    vec3 sg = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);',
    '    N2 = normalize(abs(det) * N - 0.30 * sg);',
    '#endif',

    // albedo
    '    vec3 alb = mix(vec3(0.70, 0.30, 0.12), vec3(0.93, 0.58, 0.30), smoothstep(0.35, 0.72, b));',
    '    alb = mix(alb, vec3(0.20, 0.09, 0.06), smoothstep(0.47, 0.62, a) * 0.92);',
    '    alb *= 0.90 + 0.20 * d;',
    '    alb *= 1.0 - 0.14 * bowl; alb += vec3(0.10, 0.05, 0.02) * rim;',
    '    float cap = 0.80 + 0.10 * (fbm(pl * 5.0) - 0.5);',
    '    alb = mix(alb, vec3(0.92, 0.95, 1.0), smoothstep(cap, cap + 0.04, abs(pl.y)));',

    // light
    '    float t = dot(N, L);',
    '    float dif = clamp(dot(N2, L) * 1.05 + 0.06, 0.0, 1.0) * smoothstep(-0.10, 0.30, t);',
    '    vec3 col = alb * (dif * vec3(1.35, 1.10, 0.90) + vec3(0.020, 0.032, 0.060));',
    '    float fres = pow(1.0 - N.z, 2.6), lt = smoothstep(-0.25, 0.55, t);',
    '    col += vec3(1.0, 0.62, 0.40) * fres * lt * 0.55;',
    '    col += vec3(0.22, 0.42, 0.80) * fres * (1.0 - lt) * 0.16;',
    '    col += vec3(0.30, 0.50, 0.90) * 0.10 * exp(-t * t * 26.0) * (0.3 + fres);',
    '    float hz = smoothstep(0.55, 0.85, fbm(pl * 2.2 + vec3(uTime * 0.03, 0.0, 0.0)));',
    '    col = mix(col, vec3(0.95, 0.62, 0.42) * lt * 0.6, hz * 0.10 * lt);',
    '    disc = 1.0 - exp(-col * 1.4);',
    '  }',
    '  float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);',
    // atmosphere halo
    '  float rr = max(r - 1.0, 0.0);',
    '  float ld = clamp(dot(normalize(p + 1e-5), normalize(L.xy)) * 0.5 + 0.5, 0.0, 1.0);',
    '  float g = (exp(-rr * 16.0) * 0.55 + exp(-rr * 5.0) * 0.10) * (0.12 + 0.88 * ld * ld) * (1.0 - smoothstep(1.2, 1.36, r));',
    '  vec3 gc = mix(vec3(0.55, 0.30, 0.30), vec3(1.0, 0.55, 0.30), ld);',
    '  vec3 rgb = disc * cov + gc * g * (1.0 - cov);',
    '  gl_FragColor = vec4(rgb, cov + g * (1.0 - cov) * 0.85);',
    '}'
  ].join('\n');

  var gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' }) ||
           cv.getContext('experimental-webgl');
  var ok = false, U = {};
  if (gl) {
    gl.getExtension('OES_standard_derivatives');
    var mk = function (type, src) {
      var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { if (window.console) console.warn('[Mars] shader:', gl.getShaderInfoLog(sh)); return null; }
      return sh;
    };
    var vs = mk(gl.VERTEX_SHADER, VERT), fs = mk(gl.FRAGMENT_SHADER, FRAG);
    if (vs && fs) {
      var prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.useProgram(prog);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(prog, 'a');
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        ['uRes', 'uRad', 'uRot', 'uTime', 'uLight'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
        ok = true;
      }
    }
  }
  if (!ok) stage.classList.add('no-gl');

  // ---- sizing ----------------------------------------------------------------
  var PX = 0;
  function resize() {
    buildStars();
    if (!ok) return;
    var css = stage.clientWidth || 400, dpr = Math.min(window.devicePixelRatio || 1, 2);
    PX = Math.max(64, Math.min(Math.round(css * dpr), MAX_PX));
    cv.width = cv.height = PX;
    gl.viewport(0, 0, PX, PX);
  }

  // ---- state -------------------------------------------------------------------
  var idle = 0, spinS = 0, sf = 0, sfT = 0, px = 0, py = 0, tpx = 0, tpy = 0;
  var caption = document.getElementById('marsCaption');
  function readScroll() {
    var y = window.pageYOffset || 0;
    sfT = 1 - Math.exp(-y / Math.max(300, window.innerHeight));
  }
  window.addEventListener('scroll', function () { readScroll(); if (reduce) frame(0, 0); }, { passive: true });
  window.addEventListener('pointermove', function (e) {
    tpx = (e.clientX / window.innerWidth - 0.5) * 2; tpy = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });
  var rt = 0;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { resize(); frame(0, 0); }, 120); });

  function frame(t, dt) {
    var y = window.pageYOffset || 0;
    idle += IDLE_SPIN * dt;
    spinS += (y * SCROLL_SPIN - spinS) * (reduce ? 1 : 1 - Math.exp(-dt * 6));
    sf += (sfT - sf) * (reduce ? 1 : 1 - Math.exp(-dt * 5));
    px += (tpx - px) * (1 - Math.exp(-dt * 3)); py += (tpy - py) * (1 - Math.exp(-dt * 3));
    if (ok) {
      gl.uniform2f(U.uRes, PX, PX);
      gl.uniform1f(U.uRad, PX / 2 / 1.36);
      gl.uniform1f(U.uRot, idle + spinS);
      gl.uniform1f(U.uTime, t);
      gl.uniform3f(U.uLight, 0.80 + px * 0.10, 0.34 - py * 0.08, 0.50);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    stage.style.transform = 'translate(-50%,-50%) translate(' + (px * 7).toFixed(1) + 'px,' + (py * 5).toFixed(1) + 'px) scale(' + (1 - 0.50 * sf).toFixed(3) + ')';
    stage.style.opacity = (1 - 0.35 * sf).toFixed(3);
    if (caption) caption.style.opacity = Math.max(0, 1 - sf * 1.8).toFixed(3);
    drawStars(t, y);
  }

  resize(); readScroll(); sf = sfT; spinS = (window.pageYOffset || 0) * SCROLL_SPIN;
  frame(0, 0);
  if (reduce) return;

  var t0 = performance.now(), last = t0, gap = 1000 / FPS - 2;
  (function loop(now) {
    requestAnimationFrame(loop);
    if (now - last < gap) return;
    var dt = Math.min(0.1, (now - last) / 1000); last = now;
    frame((now - t0) / 1000, dt);
  })(t0);
})();
