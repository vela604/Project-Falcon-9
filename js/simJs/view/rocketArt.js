// ============================================================================
// rocketArt.js — Shared vehicle artwork: airframe, checkerboard/stripe,
// grid fins, 4 landing legs, and the 4 RCS pods. This is the exact same
// drawing code the live flight simulator uses for the vehicle body (pulled
// out of render.js's drawRocket()), so a static preview elsewhere (home
// page "current vehicle" card, fleet page vehicle detail) renders as the
// literal same rocket, not a lookalike.
//
// Deliberately excludes the main-engine plume (that needs live ENGINES
// throttle/gimbal state from the running sim) — a static preview is drawn
// "idle" (no flame), which is exactly what an idle pad rocket looks like.
//
// Coordinate convention: origin at the vehicle's BASE (0,0), +Y is DOWN,
// nose is in -Y, spanning from y=0 (base) to y=-H (nose tip), width W
// centered on x=0 — matching render.js's drawRocket() local frame exactly,
// so callers only need a translate/rotate to place it; no separate math.
//
// ctx      - a 2D canvas context, already translated/rotated into place
// W, H     - vehicle width/height IN PIXELS at whatever scale the caller wants
// mpp      - meters-per-pixel at that scale (only used for the RCS pod
//            margins, which are specified in real meters in CONFIG)
// opts     - { legsProgress: 0..1 (default 0, stowed),
//              firing: { [podId]: boolean } (default none firing),
//              pod: { [podId]: {Fx,Fy} } (default none),
//              legsState: optional object to record per-leg foot positions
//                         into (the live sim passes its `legs` state here;
//                         a static preview omits it) }
//            `firing`/`pod` are keyed by whatever pod ids the active RCS
//            type declares (CONFIG.RCS_TYPE.frame.pods) — TL/TR/BL/BR for
//            the built-in 4-corner type, but this file never assumes those
//            literal names (see PHASE2_PROMPT.md Step E).
// ============================================================================

// ============================================================================
// Gradient cache — several gradients in this file are a pure function of a
// pixel width/radius (cylinder body shading, dish, interstage band): same
// coordinates, same fixed color stops, every time W is the same. They were
// being rebuilt from scratch every frame for every member of every body.
// Cached per-canvas-context (WeakMap, so it never leaks a dead canvas) and
// keyed by the rounded value that actually determines the gradient, so a
// cache hit is byte-identical to a fresh build — no visual change, just
// skips rebuilding it when nothing that affects it (i.e. zoom) has moved.
// Only used for gradients with fixed color stops; anything whose *colors*
// change frame-to-frame (flame/plume, throttle-driven effects) is left
// alone since caching those wouldn't help and risks staleness.
// ============================================================================
const _gradCache = new WeakMap(); // ctx -> Map("key:sig" -> CanvasGradient)
function cachedGradient(ctx, key, sig, build) {
  let bucket = _gradCache.get(ctx);
  if (!bucket) { bucket = new Map();
    _gradCache.set(ctx, bucket); }
  const fullKey = key + ':' + sig;
  let grad = bucket.get(fullKey);
  if (grad) return grad;
  // Safety net: continuous zoom sweeps through many rounded-width values
  // over a session. Bounded already (pixel widths are a small finite
  // range), but reset if it ever grows large so this never accumulates.
  if (bucket.size > 500) bucket.clear();
  grad = build();
  bucket.set(fullKey, grad);
  return grad;
}


// ============================================================================
// SZAD overlay — canonical branding that appears on every DEFAULT (locked)
// booster. Two PNG variants ship with the code:
//   assets/szad-light.png — light-coloured logo (for dark booster bodies)
//   assets/szad-dark.png  — dark-coloured logo  (for light booster bodies)
//
// On load each image is tight-cropped to its non-transparent, non-white
// bounds so the caller doesn't have to ship hand-cropped PNGs. If the file
// is missing or canvas-crop fails (CORS / non-image), the overlay silently
// skips — no error, no half-drawn state.
// ============================================================================
const _szadImages = {
  light: null,   // for DARK backgrounds
  dark: null,    // for LIGHT backgrounds
};

function _trimImageWhitespace(img) {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
        // "content" = has alpha AND isn't near-white (typical exported-
        // logo-with-white-background case).
        const isContent = a > 16 && !(r > 245 && g > 245 && b > 245);
        if (isContent) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return img; // nothing found
    const out = document.createElement('canvas');
    out.width  = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(img,
      minX, minY, out.width, out.height,
      0, 0, out.width, out.height);
    return out;
  } catch (e) {
    return img; // CORS or security error — fall back to original
  }
}

// ============================================================================
// SZAD rendering mode.
//   true  → text-render (vertical SZAD letters with cylindrical shading,
//           matching the body's own lighting; no PNG needed).
//   false → PNG overlay (uses assets/szad-*.png).
// Both modes call into _drawSzadAtAnchor; flip this to switch.
// ============================================================================
const SZAD_USE_TEXT = true;


(function _preloadSzad() {
    // Skip PNG loading entirely when text mode is on — no network hits for
    // assets we're not going to draw.
    if (typeof SZAD_USE_TEXT !== 'undefined' && SZAD_USE_TEXT) return;
  // Two runtimes to satisfy: main thread (has Image + document.createElement)
  // and render worker (has neither — only fetch + createImageBitmap +
  // OffscreenCanvas). Both produce a drawable thing drawImage() accepts:
  // HTMLImageElement on the main thread, ImageBitmap in the worker.
  const canUseImage = (typeof Image === 'function');
  const canUseBitmap = (typeof fetch === 'function' &&
    typeof createImageBitmap === 'function');
  const canUseOffscreen = (typeof OffscreenCanvas === 'function');
  
  const logReady = (key, w, h) => {
    // worker console is separate; the log shows up in the render worker's
    // own DevTools context, not the page's — harmless either way.
    try {
    } catch (e) {}
  };
  const logFail = (key, src, err) => {
    try {
      console.warn('[szad] failed to load ' + key + ' from ' + src, err || '');
    } catch (e) {}
  };
  const afterLoad = () => {
    if (typeof _redrawAllPreviews === 'function') _redrawAllPreviews();
  };
  
  // --- Bitmap path (worker) ---
  const loadBitmap = (src, key) => {
    fetch(src).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(b => createImageBitmap(b)).then(bitmap => {
      const trimmed = canUseOffscreen
        ? _trimBitmapWhitespace(bitmap)
        : bitmap;
      _szadImages[key] = trimmed;
      logReady(key, trimmed.width, trimmed.height);
      afterLoad();
    }).catch(err => logFail(key, src, err));
  };
  
  // --- Image path (main thread) ---
  const loadImage = (src, key) => {
    const img = new Image();
    img.onload = () => {
      const trimmed = _trimImageWhitespace(img);
      _szadImages[key] = trimmed;
      logReady(key, trimmed.width, trimmed.height);
      afterLoad();
    };
    img.onerror = (e) => logFail(key, src, 'onerror');
    img.src = src;
  };
  
  const load = (canUseImage && typeof document !== 'undefined' &&
    typeof document.createElement === 'function')
    ? loadImage
    : (canUseBitmap ? loadBitmap : null);
  
  if (!load) {
    try { console.warn('[szad] no usable image loader in this context'); } catch (e) {}
    return;
  }
  load('/assets/szad-light.png', 'light');
  load('/assets/szad-dark.png',  'dark');
})();

// OffscreenCanvas equivalent of _trimImageWhitespace — used by the worker
// path. Takes an ImageBitmap, returns a (possibly trimmed) ImageBitmap
// ready for drawImage. Falls back to the original on any failure.
function _trimBitmapWhitespace(bitmap) {
  try {
    const w = bitmap.width, h = bitmap.height;
    const oc = new OffscreenCanvas(w, h);
    const cx = oc.getContext('2d');
    cx.drawImage(bitmap, 0, 0);
    const d = cx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
        const isContent = a > 16 && !(r > 245 && g > 245 && b > 245);
        if (isContent) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return bitmap;
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    const out = new OffscreenCanvas(tw, th);
    out.getContext('2d').drawImage(bitmap,
      minX, minY, tw, th,
      0, 0, tw, th);
    return out.transferToImageBitmap();
  } catch (e) {
    return bitmap;
  }
}

// Perceptual luminance (Rec. 709) — true if the hex colour reads as "light".
function _isLightColor(hex) {
  if (typeof hex !== 'string') return true;
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length !== 6) return true;
  const r = parseInt(h.slice(0,2),16)/255;
  const g = parseInt(h.slice(2,4),16)/255;
  const b = parseInt(h.slice(4,6),16)/255;
  if (![r,g,b].every(Number.isFinite)) return true;
  return (0.2126*r + 0.7152*g + 0.0722*b) > 0.55;
}

// Draw the SZAD overlay on a body-local frame (origin at base, +Y down).
// Only called for locked (default) boosters — see the call site in
// drawRocketArt. Image variant picked from the body's solid colour:
//   light body → dark SZAD
//   dark body  → light SZAD
// Rotated 90° CW so SZAD reads TOP (nose end) → BOTTOM (base end).
// One-time-per-body-key log so we can confirm the call fires without
// spamming every frame. Keyed by role so a booster logs once.
let _szadCallLogged = false;


// Draws SZAD at a caller-provided CSS-pixel anchor (baseX, baseY of the
// body). Called by outer renderers AFTER their drawRocketArt call has
// completed and the ctx is back in a clean transform. Inside drawRocketArt
// the ctx origin sits at a translate-to-base that lands off the visible
// canvas buffer for tall boosters, so any draw from in there goes
// off-screen; drawing from outside fixes that.
function _drawSzadAtAnchor(ctx, anchorX, anchorY, W, H, solidColor) {
  const isLightBody = _isLightColor(solidColor);
  
// Common layout box. Letters wide enough that each stroke spans a
// meaningful slice of the cylinder gradient — otherwise they read as
// flat black lines instead of shaded text on a curved surface.
// Layout box — real F9 proportions: letters wider than tall, lockup
// occupies a modest band down the body.
const maxL = H * 0.30;
const maxD = W * 0.78;

// Vertical nudge as a fraction of body height. Positive = down (toward
// base), negative = up (toward nose). 0 = dead centre.
const SZAD_Y_OFFSET_K = 0.15;

ctx.save();
ctx.globalCompositeOperation = 'source-over';
// Body centre, plus the offset below. Anchor Y is the base, so we shift
// the whole lockup DOWN by SZAD_Y_OFFSET_K · H.
ctx.translate(anchorX, anchorY - H / 2 + H * SZAD_Y_OFFSET_K);
  // NOTE: no additional rotation needed for text mode — letters stack
  // directly along body Y (top at -Y, base at +Y). PNG mode (below) uses
  // a π/2 rotation so the horizontal wordmark reads top→bottom.
  
  if (SZAD_USE_TEXT) {
    _drawSzadText(ctx, maxL, maxD, isLightBody);
  } else {
    _drawSzadPng(ctx, maxL, maxD, isLightBody);
  }
  
  ctx.restore();
  
  // India flag, near the top of the booster
  const FLAG_Y_OFFSET_K = -0.30; // centre se: negative = upar, positive = neeche
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.translate(anchorX, anchorY - H / 2 + H * FLAG_Y_OFFSET_K);
  _drawIndiaFlag(ctx, W, H);
  ctx.restore();
  
}

// ---------------------------------------------------------------------------
// Text renderer — S Z A D letters stacked vertically along body Y. Blue,
// solid-ish fill with a subtle vertical-edge darkening so the letters
// still read as ink on a curved surface. Sized and spaced to match the
// reference (SpaceX body livery): letters bold, generous vertical gaps,
// each letter filling most of the body's width without touching edges.
// ---------------------------------------------------------------------------
// SZAD font comes from js/szadFont.js (loaded ahead of this file on every
// page and added to the render worker's importScripts). Family name and
// loader are globals defined there — this file only consumes them.
const _szadCache = new Map();
let _szadFontReady = false;
let _szadFontReq = false;

function _ensureSzadFont() {
  if (_szadFontReq) return;
  if (typeof loadSzadFont !== 'function') return;
  _szadFontReq = true;
  loadSzadFont().then((ok) => {
    if (!ok) return;
    _szadFontReady = true;
    _szadCache.clear();
    if (typeof _redrawAllPreviews === 'function') _redrawAllPreviews();
  });
}


// Canvas factory that works in BOTH main thread and worker:
//   main  → document.createElement('canvas')
//   worker → new OffscreenCanvas()
// Every canvas creation in the SZAD text renderer must go through this,
// otherwise the render worker throws `document is not defined` on its
// first SZAD draw (see the crash trace: _drawSzadText → drawSzadAtAnchor
// → drawRocketArt → render.worker.js). Cached as a function ref so the
// typeof test runs once, not per-draw.
const _szadMakeCanvas = (function() {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return (w, h) => new OffscreenCanvas(w, h);
  }
  return null;
})();


// Decal shading that matches the ACTUAL booster body gradient.
// Profile measured from the rendered body (u = 0 left edge … 1 right edge,
// value = brightness relative to the brightest column). Peak sits at the
// centre, right side falls off a bit faster than the left.
const _BODY_SHADE = [0.866, 0.892, 0.922, 0.951, 0.978, 1.0, 0.976, 0.934, 0.900, 0.848, 0.80];

function _bodyShade(u) {
  const x = Math.max(0, Math.min(1, u)) * (_BODY_SHADE.length - 1);
  const i = Math.min(_BODY_SHADE.length - 2, Math.floor(x));
  return _BODY_SHADE[i] + (_BODY_SHADE[i + 1] - _BODY_SHADE[i]) * (x - i);
}

// w      : 2D ctx of the already-wrapped decal canvas
// outW/H : its pixel size
// sW     : decal on-screen width (CSS px)   W : full BODY width (CSS px)
// Darkens only (multiply-like), so the decal colour stays true at the
// brightest column and dims exactly as much as the body underneath.
function _decalShade(w, outW, outH, sW, W) {
  w.save();
  w.globalCompositeOperation = 'source-atop';
  const g = w.createLinearGradient(0, 0, outW, 0);
  for (let s = 0; s <= 12; s++) {
    const t = s / 12;                              // across the decal
    const u = 0.5 + (t - 0.5) * (sW / W);          // across the BODY
    g.addColorStop(t, `rgba(0,0,0,${(1 - _bodyShade(u)).toFixed(3)})`);
  }
  w.fillStyle = g;
  w.fillRect(0, 0, outW, outH);
  w.restore();
}


// India flag on the booster body — same cylinder wrap + shading as SZAD.
// Paste this ANYWHERE below _szadMakeCanvas (same file as _drawSzadAtAnchor).
const _flagCache = new Map();

function _drawIndiaFlag(ctx, W, H) {
  if (!_szadMakeCanvas) return;

  // ---- Tunables ----
  const WIDTH_K = 0.56;    // flag width / body width
  const ASPECT  = 2 / 3;   // flag height / width (India = 2:3)
  const MAX_H_K = 0.10;    // flag height cap as fraction of body height
  const Q       = 3;       // supersampling

  const R = W / 2;
  let fW = 2 * R * Math.asin(Math.min(0.99, (W * WIDTH_K) / 2 / R)); // flat width
  let fH = fW * ASPECT;
  if (fH > H * MAX_H_K) {            // short boosters: scale down
    const k = (H * MAX_H_K) / fH;
    fW *= k; fH *= k;
  }
  const sW = 2 * R * Math.sin(fW / 2 / R);   // on-screen width after wrap

  const key = [fW.toFixed(1), fH.toFixed(1), R.toFixed(1)].join('|');
  let wrapped = _flagCache.get(key);
  if (!wrapped) {
    // 1) flat flag
    const fw = Math.ceil(fW * Q), fh = Math.ceil(fH * Q);
    const flat = _szadMakeCanvas(fw, fh);
    const f = flat.getContext('2d');
    const bh = fh / 3;
    f.fillStyle = '#D9822F'; f.fillRect(0, 0, fw, bh);
    f.fillStyle = '#EEF0F4'; f.fillRect(0, bh, fw, bh);
    f.fillStyle = '#1F6B3C'; f.fillRect(0, 2 * bh, fw, fh - 2 * bh);

    // Ashoka Chakra: diameter = 3/4 of white band, 24 spokes
    const cx = fw / 2, cy = fh / 2, r = bh * 0.375;
    f.strokeStyle = f.fillStyle = '#1F3070';
    f.lineWidth = Math.max(1, r * 0.13);
    f.beginPath(); f.arc(cx, cy, r, 0, Math.PI * 2); f.stroke();
    f.lineWidth = Math.max(0.6, r * 0.05);
    f.beginPath();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      f.moveTo(cx, cy);
      f.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    f.stroke();
    f.beginPath(); f.arc(cx, cy, r * 0.13, 0, Math.PI * 2); f.fill();

    // 2) cylinder wrap
    const outW = Math.ceil(sW * Q), outH = fh;
    wrapped = _szadMakeCanvas(outW, outH);
    const w = wrapped.getContext('2d');
    for (let i = 0; i < outW; i++) {
      const dx  = (i + 0.5) / Q - sW / 2;
      const phi = Math.asin(Math.max(-1, Math.min(1, dx / R)));
      const sx  = (phi * R + fW / 2) * Q;
      w.drawImage(flat, Math.max(0, Math.min(fw - 1, Math.floor(sx))), 0, 1, outH, i, 0, 1, outH);
    }

    // 3) shading — same profile as the real body
    _decalShade(w, outW, outH, sW, W);
    // matte / faded-paint look: slight desaturation toward body colour
    w.globalCompositeOperation = 'source-atop';
    w.fillStyle = 'rgba(232,235,242,0.14)';
    w.fillRect(0, 0, outW, outH);
    _flagCache.set(key, wrapped);
  }

  // origin = top-centre of the flag
  ctx.save();
  ctx.globalAlpha = 0.93;   // paint, not sticker
  ctx.drawImage(wrapped, -sW / 2, -fH / 2, sW, fH);
  ctx.restore();
}



function _drawSzadText(ctx, maxL, maxD, isLightBody) {
  _ensureSzadFont();
  if (!_szadFontReady) return;   // font load hote hi next frame me aa jayega
  if (!_szadMakeCanvas) return;  // no canvas factory in this context
  
  // ---- Tunables ----
  const WIDTH_K  = 0.54;   // letter width / body width
  const ASPECT   = 0.62;   // letter height / width
  const PITCH_K  = 1.8;    // pitch / letter height
  const BOLD = 0;   // is font me motai already sahi hai)         // extra stroke thickness (0 = normal Michroma)
  const Q        = 3;      // supersampling

  const BODY_W = maxD / 0.78;
  const R = BODY_W / 2;
  const MAX_LOCK = maxL / 0.30 * 0.45;
  const letters = ['z', 'a', 'd', 's'];   // lowercase zaroori hai

  // ---- Sizing ----
  const SCREEN_W = BODY_W * WIDTH_K;
  let fW = 2 * R * Math.asin(Math.min(0.99, SCREEN_W / 2 / R)); // flat width
  let gh = fW * ASPECT;
  let pitch = gh * PITCH_K;
  let lockH = pitch * (letters.length - 1) + gh;
  if (lockH > MAX_LOCK) {
    const k = MAX_LOCK / lockH;
    fW *= k; gh *= k; pitch *= k; lockH *= k;
  }
  const sW = 2 * R * Math.sin(fW / 2 / R);   // on-screen width after wrap

  const key = [fW.toFixed(1), lockH.toFixed(1), R.toFixed(1), isLightBody].join('|');
  let wrapped = _szadCache.get(key);
  if (!wrapped) {
    // 1) flat lockup: har letter same box me fit
    // 1) flat lockup: har letter same box me fit
const flat = _szadMakeCanvas(Math.ceil(fW * Q), Math.ceil(lockH * Q));
const f = flat.getContext('2d');
    const col = isLightBody ? '#0d5a8f' : '#8cc4ec';
    f.fillStyle = f.strokeStyle = col;
    f.font = '400 200px ' + SZAD_FONT_FAMILY;
    f.textAlign = 'left';
    f.textBaseline = 'alphabetic';
    f.lineJoin = 'miter';
    f.lineWidth = BOLD;

    for (let i = 0; i < letters.length; i++) {
      const m = f.measureText(letters[i]);
      const bw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight + BOLD;
      const bh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + BOLD;
      f.save();
      f.translate(0, i * pitch * Q);
      f.scale((fW * Q) / bw, (gh * Q) / bh);
      const x = m.actualBoundingBoxLeft + BOLD / 2;
      const y = m.actualBoundingBoxAscent + BOLD / 2;
      f.fillText(letters[i], x, y);
      if (BOLD > 0) f.strokeText(letters[i], x, y);
      f.restore();
    }

    // 2) cylinder wrap
    // 2) cylinder wrap
const outW = Math.ceil(sW * Q), outH = flat.height;
wrapped = _szadMakeCanvas(outW, outH);
const w = wrapped.getContext('2d');
    for (let i = 0; i < outW; i++) {
      const dx  = (i + 0.5) / Q - sW / 2;
      const phi = Math.asin(Math.max(-1, Math.min(1, dx / R)));
      const sx  = (phi * R + fW / 2) * Q;
      w.drawImage(flat, Math.max(0, Math.min(flat.width - 1, Math.floor(sx))), 0, 1, outH, i, 0, 1, outH);
    }

    // 3) cylinder shading
    _decalShade(w, outW, outH, sW, BODY_W);
    _szadCache.set(key, wrapped);
  }

  ctx.drawImage(wrapped, -sW / 2, -lockH / 2, sW, lockH);
}

// ---------------------------------------------------------------------------
// PNG renderer — the pre-existing path. Horizontal wordmark rotated so it
// reads top→bottom along the body. Aspect preserved from the source image.
// ---------------------------------------------------------------------------
function _drawSzadPng(ctx, maxL, maxD, isLightBody) {
  const img = isLightBody ? _szadImages.dark : _szadImages.light;
  if (!img) return;
  const iw = img.width, ih = img.height;
  if (!(iw > 0 && ih > 0)) return;
  const aspect = iw / ih;
  let L = maxL;
  let D = L / aspect;
  if (D > maxD) {
    D = maxD;
    L = D * aspect;
  }
  // If aspect-only leaves SZAD below 45% of body length, allow up to
  // that threshold with a vertical stretch — image stays width-clamped.
  const minL = maxL * 0.51;   // 0.45 of body ≈ 0.51 of maxL
  if (L < minL) {
    L = Math.min(minL, maxL);
    D = Math.min(maxD, L / aspect);
  }
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -L / 2, -D / 2, L, D);
  ctx.restore();
}


// Redraw any visible static previews after an asset finishes loading —
// previews are one-shot draws, so they miss a late-arriving image unless
// we nudge them. Live sim render uses rAF and picks the image up
// automatically, no nudge needed. All calls are typeof-guarded so this
// works identically on pages that don't have these functions.
function _redrawAllPreviews() {
  try {
    if (typeof viewingId !== 'undefined' && viewingId &&
        typeof showVehicleDetail === 'function') {
      showVehicleDetail(viewingId);
    }
  } catch (e) {}
  try {
    if (typeof editingId !== 'undefined' && editingId &&
        typeof openEditorFor === 'function') {
      // Don't re-open editor (loses user form state) — instead just
      // redraw the preview canvas that's already present.
      const cv = document.getElementById('vehiclePreviewCanvas');
      if (cv && typeof renderVehiclePreview === 'function') {
        const rec = loadFleet().find(r => r.id === editingId);
        if (rec) renderVehiclePreview(cv, previewVehicleFor(rec));
      }
    }
  } catch (e) {}
  try {
    if (typeof _previewMembers !== 'undefined' && _previewMembers.length &&
        typeof _renderPreviewMember === 'function') {
      _renderPreviewMember();
    }
  } catch (e) {}
}

// ============================================================================
// PS-A — Payload space (fairing) shape renderer.
//
// Draws ONLY the fairing silhouette — no body, no legs, no RCS, no engines.
// Coordinate convention matches drawRocketArt exactly: origin at the
// member's own BASE (0,0), +Y down, nose tip at (0, -H).
//
// Single silhouette, driven entirely by formulas over opts (Rule 5 — no
// hardcoded fractions). Section heights:
//   frustumH  = |bulgeR - capR| / tan(frustumAngleDeg)
//   curveH    = curveRatio × bulgeR
//   straightH = max(0, H - frustumH - curveH)
// If the two mandatory sections (frustum + ogive) alone exceed the
// available height H, both are scaled down proportionally so the shape
// still fits — the straight section is simply the first to vanish.
//
// bulgeWidth == capWidth gives a straight-sided "cap" (frustum collapses);
// bulgeWidth > capWidth gives the classic flared fairing.
//
// opts read:
//   payloadCapWidth        base diameter, meters (falls back to W×mpp)
//   payloadBulgeWidth      max bulge diameter, meters (falls back to
//                          payloadCapWidth → straight-sided shape)
//   payloadFrustumAngleDeg frustum angle from horizontal, degrees (default 45)
//   payloadCurveRatio      top-curve height / bulge radius (default 0.85)
//   payloadColor           '#rrggbb' fill (default '#e9edf2')

// Payload-space fairing silhouette renderer. Called from drawRocketArt
// when the member's stageRole is 'payloadSpace'. Draws the classic
// fairing profile (frustum + straight section + ogive) using the shape
// opts supplied by the caller.
function drawPayloadSpaceShape(ctx, W, H, mpp, opts) {
  opts = opts || {};
  const color = opts.payloadColor || '#e9edf2';

  const capWidth_m = Number.isFinite(opts.payloadCapWidth) ? opts.payloadCapWidth : W * mpp;
  const capR = (capWidth_m / 2) / mpp;

  const bulgeWidth_m = Number.isFinite(opts.payloadBulgeWidth) ? opts.payloadBulgeWidth : capWidth_m;
  const bulgeR = (bulgeWidth_m / 2) / mpp;
  const frustumAngleDeg = Number.isFinite(opts.payloadFrustumAngleDeg) ? opts.payloadFrustumAngleDeg : 45;
  const curveRatio = Number.isFinite(opts.payloadCurveRatio) ? opts.payloadCurveRatio : 0.85;

  const angleRad = Math.max(1, Math.min(89, frustumAngleDeg)) * Math.PI / 180;
  let frustumH = Math.abs(bulgeR - capR) / Math.tan(angleRad);
  let curveH = curveRatio * bulgeR;
  const mandatory = frustumH + curveH;
  if (mandatory > H && mandatory > 0) {
    const s = H / mandatory;
    frustumH *= s;
    curveH *= s;
  }
  const straightH = Math.max(0, H - frustumH - curveH);

  const baseY = 0;
  const frustumTopY = -frustumH;
  const straightTopY = frustumTopY - straightH;
  const tipY = -H;

  const bodyPath = () => {
    ctx.beginPath();
    ctx.moveTo(-capR, baseY);
    ctx.lineTo(-bulgeR, frustumTopY);
    ctx.lineTo(-bulgeR, straightTopY);
    ctx.bezierCurveTo(
      -bulgeR * 0.98, straightTopY - curveH * 0.30,
      -bulgeR * 0.45, tipY + curveH * 0.15,
      0, tipY
    );
    ctx.bezierCurveTo(
      bulgeR * 0.45, tipY + curveH * 0.15,
      bulgeR * 0.98, straightTopY - curveH * 0.30,
      bulgeR, straightTopY
    );
    ctx.lineTo(bulgeR, frustumTopY);
    ctx.lineTo(capR, baseY);
    ctx.closePath();
  };

  ctx.fillStyle = color;
  ctx.strokeStyle = '#8b93a0';
  ctx.lineWidth = 1.2;
  bodyPath();
  ctx.fill();
  ctx.stroke();

  const bodyDesign = opts.bodyDesign || { mode: 'solid', dslText: '' };
  if ((bodyDesign.mode || 'solid') === 'dsl' &&
    typeof parseAndValidateDesign === 'function' &&
    typeof drawCustomDesignOps === 'function') {
    const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
    if (parsed.ok && parsed.ops.length) {
      const widestW_px = Math.max(capR, bulgeR) * 2;
      ctx.save();
      bodyPath();
      ctx.clip();
      drawCustomDesignOps(ctx, widestW_px, H, parsed.ops);
      ctx.restore();
    }
  }

  if (typeof applyCylindricalOverlay === 'function') {
    const gradW = Math.max(capR, bulgeR) * 2;
    bodyPath();
    applyCylindricalOverlay(ctx, gradW);
  }
}

// ============================================================================

// Payload art — satellite bus + folding solar wings + dish. Renders in
// one of two states, or any state in between:
//   openProgress = 0  → stowed (panels folded against the bus)
//   openProgress = 1  → deployed (wings extended, dish + antenna up)
// The caller interpolates over PAYLOAD_OPEN_DURATION_S seconds.
function drawPayloadArt(ctx, W, H, openProgress) {
  const p = Math.max(0, Math.min(1, openProgress || 0));
  
  // ---- Solar wings ----
  // Folded: thin strips hugging the bus at ±W/2, width W*0.15 each.
  // Deployed: long wings sweeping outward, width W*1.3 each.
  // Hinge rotates the wing outward by 12° so it reads as an unfolding
  // mechanism, not just a sliding strip.
  const wingH = H * 0.72;
  const wingY = -H * 0.86;
  const foldedW = W * 0.15;
  const extendedW = W * 1.30;
  const wingW = foldedW + (extendedW - foldedW) * p;
  const wingTilt = p * 12 * Math.PI / 180;
  
  [-1, 1].forEach(side => {
    ctx.save();
    // Hinge at the bus edge, mid-height of the wing.
    ctx.translate(side * (W / 2), wingY + wingH / 2);
    ctx.rotate(side * wingTilt);
    // Wing rect extends outward from the hinge.
    const wx = side > 0 ? 0 : -wingW;
    // Solar cell gradient — darker at the edges, bluish mid.
    const wg = ctx.createLinearGradient(wx, 0, wx + wingW, 0);
    wg.addColorStop(0, '#1a3050');
    wg.addColorStop(0.35, '#2c5a8a');
    wg.addColorStop(0.7, '#2a5280');
    wg.addColorStop(1, '#0a1520');
    ctx.fillStyle = wg;
    ctx.fillRect(wx, -wingH / 2, wingW, wingH);
    // Frame
    ctx.strokeStyle = '#0a1520';
    ctx.lineWidth = 0.7;
    ctx.strokeRect(wx, -wingH / 2, wingW, wingH);
    // Cell grid — vertical strips (many small cells across the wing)
    ctx.strokeStyle = 'rgba(140,190,255,0.35)';
    ctx.lineWidth = 0.4;
    const cols = Math.max(4, Math.round((wingW / W) * 6));
    for (let i = 1; i < cols; i++) {
      const cx = wx + (wingW * i / cols);
      ctx.beginPath();
      ctx.moveTo(cx, -wingH / 2 + 1);
      ctx.lineTo(cx, wingH / 2 - 1);
      ctx.stroke();
    }
    // Horizontal mid-seam
    ctx.beginPath();
    ctx.moveTo(wx, 0);
    ctx.lineTo(wx + wingW, 0);
    ctx.stroke();
    // Hinge bracket (small dark block bridging bus edge to hinge)
    ctx.fillStyle = '#3a3e44';
    ctx.fillRect(-side * (W * 0.03), -wingH * 0.08, side * (W * 0.03), wingH * 0.16);
    ctx.strokeStyle = '#0d1015';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(-side * (W * 0.03), -wingH * 0.08, side * (W * 0.03), wingH * 0.16);
    ctx.restore();
  });
  
  // ---- Main bus ----
  const bg = cachedGradient(ctx, 'mainBody', Math.round(W), () => {
    const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
    g.addColorStop(0, '#4a4e54');
    g.addColorStop(0.5, '#c8d0d8');
    g.addColorStop(1, '#3a3d43');
    return g;
  });
  ctx.fillStyle = bg;
  ctx.fillRect(-W / 2, -H, W, H);
  ctx.strokeStyle = '#1c1e22';
  ctx.lineWidth = 1;
  ctx.strokeRect(-W / 2, -H, W, H);
  
  // Horizontal equipment seams across the bus (3 bands)
  ctx.strokeStyle = 'rgba(20,24,30,0.45)';
  ctx.lineWidth = 0.5;
  [-0.30, 0.05, 0.40].forEach(f => {
    const y = -H * (0.5 + f);
    ctx.beginPath();
    ctx.moveTo(-W / 2, y);
    ctx.lineTo(W / 2, y);
    ctx.stroke();
  });
  
  // Small instrument panel details — 2 tiny dark rectangles
  ctx.fillStyle = 'rgba(15,18,24,0.65)';
  ctx.fillRect(-W * 0.30, -H * 0.62, W * 0.16, H * 0.06);
  ctx.fillRect(W * 0.10, -H * 0.44, W * 0.20, H * 0.05);
  
  // RCS thruster nubs at the four bus corners (base-side), always visible
  ctx.fillStyle = '#1c1e22';
  [-1, 1].forEach(sgn => {
    ctx.fillRect(sgn * (W / 2) - sgn * W * 0.05 - (sgn > 0 ? 0 : W * 0.05),
      -H * 0.05,
      W * 0.05, H * 0.03);
  });
  
  // ---- Dish / antenna assembly on top ----
  // Stowed: flat, hugging the top of the bus.
  // Deployed: rotated up ~55° and slightly wider.
  const dishR_base = W * 0.20;
  const dishR = dishR_base * (0.85 + 0.30 * p);
  const mastH = H * (0.03 + 0.10 * p); // small mast grows
  const dishAngle = p * 55 * Math.PI / 180; // rotates back
  
  ctx.save();
  ctx.translate(0, -H); // top center of bus
  // Mast
  ctx.strokeStyle = '#2a2e34';
  ctx.lineWidth = Math.max(1, W * 0.02);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -mastH);
  ctx.stroke();
  // Dish — rotate about the mast top
  ctx.translate(0, -mastH);
  ctx.rotate(dishAngle);
  // Dish dish
  const dg = cachedGradient(ctx, 'topDish', Math.round(dishR), () => {
    const g = ctx.createRadialGradient(0, 0, dishR * 0.05, 0, 0, dishR);
    g.addColorStop(0, '#eef3fa');
    g.addColorStop(0.55, '#b9c2cd');
    g.addColorStop(1, '#545c66');
    return g;
  });
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.arc(0, 0, dishR, Math.PI, 0, false); // upper semicircle
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#1c1e22';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  // Feed horn (small dot at focus)
  ctx.fillStyle = '#e8eef5';
  ctx.beginPath();
  ctx.arc(0, -dishR * 0.35, Math.max(0.8, W * 0.02), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  
  // ---- Base nozzle (existing) ----
  const nzW = W * 0.35;
  const nzH = H * 0.08;
  ctx.fillStyle = '#1c1e22';
  ctx.beginPath();
  ctx.moveTo(-nzW / 2, 0);
  ctx.lineTo(-nzW / 2 * 0.6, nzH);
  ctx.lineTo(nzW / 2 * 0.6, nzH);
  ctx.lineTo(nzW / 2, 0);
  ctx.closePath();
  ctx.fill();
  
  // ---- Blinking beacon (becomes green when deployed) ----
  const blink = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
  const beaconColor = (p > 0.5) ?
    `rgba(74,222,128,${blink})` :
    `rgba(255,60,50,${blink})`;
  ctx.fillStyle = beaconColor;
  ctx.beginPath();
  ctx.arc(0, -H * 0.55, W * 0.05, 0, Math.PI * 2);
  ctx.fill();
}


// ============================================================================
// Fairing-recovery parachute artwork.
//
// Drawn in the body's own local frame (caller has already applied the
// body's translate + rotate), origin at the body's base, +Y DOWN. The
// canopy sits above the body's top edge, connected by suspension lines.
//
// progress: 0 → nothing drawn (chute packed / not fitted)
//           0..lineStretchFrac → only the folded chute pack + lines
//           lineStretchFrac..1 → canopy inflates linearly from 0 → full size
//
// Sizes are derived from the real-world canopy diameter + line length in
// METERS (matching every other opts value this file reads), converted to
// px via mpp — so a canopy rendered at any zoom always matches its true
// physical size relative to the fairing it's attached to.
// ============================================================================
function drawChuteArt(ctx, bodyTopY, mpp, chuteType, progress) {
  if (!chuteType || !chuteType.parameterSchema) return;
  const valOf = (k) => { const e = chuteType.parameterSchema.find(p => p.key === k); return e ? e.value : undefined; };
  const canopyD = valOf('canopyDiameter');
  const lineLen = valOf('lineLength');
  const lineStretchS = valOf('lineStretchTime');
  const openingS = valOf('openingTime');
  if (!Number.isFinite(canopyD) || !Number.isFinite(lineLen)) return;
  if (!Number.isFinite(lineStretchS) || !Number.isFinite(openingS)) return;
  
  const totalS = lineStretchS + openingS;
  if (totalS <= 0) return;
  const tSinceStart = progress * totalS;
  
  // Inflation ramp — 0 during line-stretch, linear 0→1 during opening.
  let inflateFrac = 0;
  if (tSinceStart > lineStretchS) {
    inflateFrac = Math.min(1, (tSinceStart - lineStretchS) / openingS);
  }
  
  const linePx = lineLen / mpp;
  const canopyR_full = (canopyD / 2) / mpp;
  const canopyR = canopyR_full * inflateFrac;
  
  // Attach point (body top) and canopy center — canopy center sits at
  // attach + line + radius above the body top.
  const attachY = bodyTopY;
  const canopyCenterY = attachY - linePx - canopyR;
  const canopyCenterX = 0;
  
  // ---- Suspension lines (drawn from canopy rim to attach point) ----
  // Always drawn once line-stretch begins, even at inflateFrac = 0 — the
  // lines are physically taut before the canopy fills.
  if (tSinceStart > 0) {
    ctx.save();
    ctx.strokeStyle = 'rgba(220,225,232,0.55)';
    ctx.lineWidth = Math.max(0.6, 1 / mpp * 0.5);
    const lineCount = 6;
    for (let i = 0; i < lineCount; i++) {
      // Rim point angle — evenly spaced around the canopy; project onto
      // the 2D plane as ±cos, so lines spread to both sides.
      const ang = (i / (lineCount - 1)) * Math.PI; // 0..π (half ring visible)
      const rx = Math.cos(ang) * canopyR;
      ctx.beginPath();
      ctx.moveTo(attachY === bodyTopY ? 0 : 0, attachY);
      ctx.lineTo(rx, canopyCenterY + canopyR * 0.15);
      ctx.stroke();
    }
    ctx.restore();
  }
  
  // ---- Canopy (dome) ----
  if (inflateFrac > 0.02 && canopyR > 0.5) {
    ctx.save();
    // Dome: upper semicircle, sitting on the canopy center line.
    const grad = ctx.createLinearGradient(
      canopyCenterX - canopyR, canopyCenterY - canopyR,
      canopyCenterX + canopyR, canopyCenterY - canopyR
    );
    grad.addColorStop(0, '#a8b0bc');
    grad.addColorStop(0.5, '#e4e8ee');
    grad.addColorStop(1, '#8f98a6');
    ctx.fillStyle = grad;
    ctx.strokeStyle = '#4a5058';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(canopyCenterX, canopyCenterY, canopyR, Math.PI, 0, false);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // Radial seams — 4 gores for a segmented look.
    ctx.strokeStyle = 'rgba(74,80,88,0.55)';
    ctx.lineWidth = 0.8;
    for (let i = 1; i <= 3; i++) {
      const fx = canopyCenterX - canopyR + (2 * canopyR) * (i / 4);
      ctx.beginPath();
      ctx.moveTo(fx, canopyCenterY - Math.sqrt(Math.max(0, canopyR * canopyR - (fx - canopyCenterX) ** 2)));
      ctx.lineTo(canopyCenterX, canopyCenterY);
      ctx.stroke();
    }
    // Vent ring at the canopy top (small ellipse).
    const ventR = canopyR * 0.18;
    ctx.fillStyle = 'rgba(60,65,72,0.55)';
    ctx.beginPath();
    ctx.ellipse(canopyCenterX, canopyCenterY - canopyR * 0.95, ventR, ventR * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
  }
}


// Payload art — compact satellite with folded solar panels + small dish.
// ============================================================================
// Grid fin artwork — one fin as an axis-aligned rectangle with a lattice
// overlay, hinged at a FIXED top-edge point (never re-centers).
//
// Real orthographic front-view physics (confirmed against reference
// photos): only ONE pose ever shows the full perforated mesh — the
// FRONT fin's STOWED pose (chord×span, face-on, because in the tangent-
// plane its face happens to align with the view). Every other
// combination is a thin, mostly-solid-looking edge-on sliver:
//   L/R stowed:   thickness × span   (thin vertical strip)
//   L/R deployed: span × thickness   (thin horizontal strip)
//   F/B deployed: chord × thickness  (thin horizontal strip)
// This isn't a shortcut — it's what a real photo taken exactly
// horizontal shows (a slightly-below camera angle, like some reference
// shots, peeks a bit of the underside; a true horizontal view doesn't).
//
//   anchorX — anchor x in body-local coords. For L/R fins this is the
//             hull-edge x (the fin's inner edge touches the hull).
//             For F/B fins this is 0 (fin is horizontally centered).
//   hingeY  — the FIXED hinge line (top edge) in body-local coords. The
//             rect always hangs tailward (canvas +y) from this fixed
//             point — it never re-centers as wPx/hPx change with p.
//   side    — -1 = left-anchored (rect extends in −X from anchor),
//             +1 = right-anchored (rect extends in +X from anchor),
//              0 = centered (rect straddles anchor)
//   cellPx  — lattice cell size in px.
// ============================================================================
// Draw one grid-fin rect. `rotateRad` (default 0) rotates the rect about
// the anchor/hinge point — used for F/B control deflection; L/R never
// rotate (their control is locked at 0). `showMesh` gates the lattice
// overlay: only poses where the fin's perforated face is aimed at the
// viewer should draw it (F/B stowed); every other pose shows a solid
// edge sliver with no mesh.
// Draw one grid-fin rect. The rect's top-left in the local (pre-rotation)
// frame is (topX, topY); the rect has size (wPx, hPx). Rotation happens
// around the (pivotX, pivotY) anchor — which lets the caller put the
// pivot at the fin's physical hinge axis (root end, thickness-center)
// while still positioning the rect wherever the pose needs it.
//
// This separation is what makes control rotation look right: at deployed
// state the caller passes topY = -thicknessPx/2, so the rect's geometric
// center sits exactly on the pivot — the strip spins in place rather
// than seesawing around its top edge.
function drawGridFinFace(ctx, pivotX, pivotY, topX, topY, wPx, hPx, cellPx, style, showMesh, rotateRad) {
  if (!(wPx > 0) || !(hPx > 0)) return;
  const fill = (style && style.fill) || '#8a9198';
  const stroke = (style && style.stroke) || '#48515e';
  
  ctx.save();
  ctx.translate(pivotX, pivotY);
  if (rotateRad) ctx.rotate(rotateRad);
  
  if (showMesh) {
    // Perforated face — ONLY the cell walls and frame are drawn. Cells
    // stay transparent so whatever's behind (hull, sky, another fin)
    // shows through the openings. Previously the rect was filled solid
    // first and the mesh was overlaid as thin lines, so the "cells"
    // still read as grey metal instead of holes.
    //
    // Wall thickness: ~18% of the cell pitch, floored at 0.8 px so walls
    // don't disappear at fine zoom. Frame gets a bit more weight than
    // the interior walls so the fin reads as a bordered panel.
    const wallPx = Math.max(0.8, cellPx * 0.18);
    const framePx = Math.max(1.4, cellPx * 0.30);
    
    const cols = Math.max(1, Math.round(wPx / cellPx));
    const rows = Math.max(1, Math.round(hPx / cellPx));
    const colStep = wPx / cols;
    const rowStep = hPx / rows;
    
    // Interior walls (thin lattice).
    ctx.strokeStyle = fill;
    ctx.lineWidth = wallPx;
    ctx.beginPath();
    for (let i = 1; i < cols; i++) {
      const x = topX + i * colStep;
      ctx.moveTo(x, topY);
      ctx.lineTo(x, topY + hPx);
    }
    for (let j = 1; j < rows; j++) {
      const y = topY + j * rowStep;
      ctx.moveTo(topX, y);
      ctx.lineTo(topX + wPx, y);
    }
    ctx.stroke();
    
    // Frame — same colour, slightly heavier, drawn on the perimeter.
    // Inset by wallPx/2 so the stroke straddles the rect edge, matching
    // how the interior walls straddle their grid lines.
    ctx.lineWidth = framePx;
    ctx.strokeRect(
      topX + framePx / 2,
      topY + framePx / 2,
      wPx - framePx,
      hPx - framePx
    );
  } else {
    // Solid edge-on face — filled rect + border, unchanged.
    ctx.beginPath();
    ctx.rect(topX, topY, wPx, hPx);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  ctx.restore();
}

// Pusher-puff render — 4 small bursts at the TOP RIM of the stack.
// Called from drawRocketArt for the top member when the physics worker
// reports an active pusher event on this body. Draws in the member's own
// local coordinate frame (origin at base, +Y down, nose at -H), so no
// world-to-screen math is needed — the parent transform already did it.
//
// progress: 0 → just fired, expands outward + upward + fades over [0..1).
function drawPusherPuffsAtRim(ctx, W, H, progress) {
  const alpha = 1 - progress;
  const halfW = W / 2;

  // 4 puffs at the top rim — 2 per side, slightly offset vertically along
  // the member's axis so they read as a small cluster, not one blob.
  const defs = [
    { sideX: -1, offsetY:  0.15 },
    { sideX: -1, offsetY: -0.35 },
    { sideX:  1, offsetY:  0.15 },
    { sideX:  1, offsetY: -0.35 },
  ];

  defs.forEach(pd => {
    // Base at the rim edge (top of this member, which is the top of the
    // stack), nudged up/down along the member axis.
    const baseX = pd.sideX * halfW;
    const baseY = -H + pd.offsetY * W * 0.4;

    // Motion: outward (away from centerline) + upward (toward nose / off
    // the top of the stack), both scaled by W so puff geometry tracks
    // vehicle width.
    const outX = pd.sideX * progress * W * 1.4;
    const outY = -progress * W * 0.6;
    const cx = baseX + outX;
    const cy = baseY + outY;

    const radius = Math.max(4, 4 + progress * W * 0.9);

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0,    `rgba(240,248,255,${alpha * 0.92})`);
    g.addColorStop(0.5,  `rgba(200,220,245,${alpha * 0.55})`);
    g.addColorStop(1,    `rgba(160,190,220,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---------------------------------------------------------------------------
// Engine bell — auto-sized from the record's actual thruster mass flow.
//
// Every thruster type declares two hardware constants
// (massFlowToBellHeight / massFlowToBellDiameter); the rendered bell is
// derived from the record's own mass flow rate × those constants, so the
// same thruster at a different flow gets a proportionally different
// nozzle automatically. No percentage-of-rocket-width fudge any more.
//
//   bellHeight_m   = massFlowToBellHeight   × gimbalFlowKgPerSec
//   bellDiameter_m = massFlowToBellDiameter × gimbalFlowKgPerSec
//   bellExitY_m    = bellHeight_m           (from the member's own base,
//                                            down-positive)
// ---------------------------------------------------------------------------
function getEngineBellDims_m(record) {
  const empty = { h: 0, d: 0, exitY: 0 };
  if (!record || !record.engineTypeId || !record.engineThrusters) return empty;
  if (typeof getComponentType !== 'function') return empty;
  const g = record.engineThrusters.gimbal || record.engineThrusters.fixed;
  if (!g || !Number.isFinite(g.massFlowRate)) return empty;
  const t = getComponentType(g.thrusterTypeId);
  if (!t) return empty;
  const hEnt = t.parameterSchema.find(p => p.key === 'massFlowToBellHeight');
  const dEnt = t.parameterSchema.find(p => p.key === 'massFlowToBellDiameter');
  if (!hEnt || !dEnt) return empty;
  const h = Number.isFinite(hEnt.value) ? hEnt.value * g.massFlowRate : 0;
  const d = Number.isFinite(dEnt.value) ? dEnt.value * g.massFlowRate : 0;
  return { h, d, exitY: h };
}

// Kept as a thin wrapper for existing callers (render.js's plume anchor).
function getEngineBellExitY_m(record) {
  return getEngineBellDims_m(record).exitY;
}


// Pre-rendered puff sprite. A soft white radial blob, built once per
// worker, drawn via drawImage every frame. Replaces the old on-the-fly
// ctx.filter='blur(...)' chain, which was expensive in OffscreenCanvas
// and — on some browsers — silently no-op'd, leaving the puffs invisible.
let _puffSprite = null;
let _puffSpriteSize = 0;

function _getPuffSprite() {
  if (_puffSprite) return _puffSprite;
  const S = 64;
  let c = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { c = new OffscreenCanvas(S, S); } catch (e) { c = null; }
  }
  if (!c && typeof document !== 'undefined' && document.createElement) {
    c = document.createElement('canvas');
    c.width = S;
    c.height = S;
  }
  if (!c) { _puffSprite = false; return null; }
  const cx = c.getContext('2d');
  if (!cx) { _puffSprite = false; return null; }
  // Layered alpha falloff — bright white core, cool outer haze.
  const g = cx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.30, 'rgba(248,251,255,0.72)');
  g.addColorStop(0.60, 'rgba(220,230,245,0.34)');
  g.addColorStop(0.85, 'rgba(200,215,235,0.10)');
  g.addColorStop(1.00, 'rgba(190,205,225,0)');
  cx.fillStyle = g;
  cx.beginPath();
  cx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  cx.fill();
  _puffSprite = c;
  _puffSpriteSize = S;
  return c;
}
// ============================================================================
// Live RCS puff particles — body-local pool, keyed by member index.
//
// Each frame the pod is firing, drawGasPuff() spawns 1 particle at the
// nozzle exit with velocity along the firing axis. Particles drift
// outward with drag, grow as they age, and fade toward end-of-life.
// This is what makes the puff feel like flowing gas rather than a static
// cloud. Sprites are pre-rendered (see _getPuffSprite), so each particle
// costs exactly one drawImage call — cheap.
// ============================================================================
const _gasPools = {};  // { memberIdx: { particles: [], stepBin: -1, drawBin: -1 } }
let _gasActiveGen = -1;
const _GAS_PARTICLE_CAP = 64;

function _gasPoolFor(idx) {
  let p = _gasPools[idx];
  if (!p) {
    p = { particles: [], stepBin: -1, drawBin: -1 };
    _gasPools[idx] = p;
  }
  return p;
}

// Called once per frame from drawRocket() BEFORE any bodies draw.
function _stepAllGasPools() {
  const bin = Math.floor(performance.now() / 5);
  for (const k in _gasPools) {
    const pool = _gasPools[k];
    if (bin === pool.stepBin) continue;
    const dt = pool.stepBin < 0 ? 0.016 : Math.min(0.05, (bin - pool.stepBin) * 0.005);
    pool.stepBin = bin;
    for (let i = pool.particles.length - 1; i >= 0; i--) {
      const p = pool.particles[i];
      p.age += dt;
      if (p.age >= p.life) { pool.particles.splice(i, 1); continue; }
      // Drag — gas decelerates as it disperses.
      const drag = Math.exp(-1.2 * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
}

// Clear pools when the camera switches to a different body — particles
// were spawned in the old body's local frame and would be meaningless.
function _resetGasPoolsIfBodyChanged(gen) {
  if (gen === _gasActiveGen) return;
  _gasActiveGen = gen;
  for (const k in _gasPools) delete _gasPools[k];
}

function drawRocketArt(ctx, W, H, mpp, opts) {
  opts = opts || {};
  
 const legsProgress = opts.legsProgress || 0;
  const legsState = opts.legsState || null;
  // A5 — which member of the containing body this draw call represents.
  // 0 = bottom (the only member that ever existed pre-multi-member), so
  // every existing caller (static previews, single-member bodies) draws
  // unchanged with the pod id `b0.*`. Multi-member bodies pass their own
  // idx so pod lookup keys match what computeRCSForBody returned.
  const memberIdx = (Number.isInteger(opts.memberIdx) && opts.memberIdx >= 0) ? opts.memberIdx : 0;
  
  // P4-D3: body appearance + nose shape + role flags.
  const noseCurveness = opts.noseCurveness || 0;
const isBooster = opts.stageRole === 'booster';
const isNose = opts.stageRole === 'nose';
const isPayloadSpace = opts.stageRole === 'payloadSpace';
// When a separate payloadSpace fairing sits directly above this stage
// in the stack, the stage's top is capped by the fairing, so it must
// render as a flat-top (open) cylinder — NOT with its own nose. Without
// this flag a stage in a stack drew its own nose, which visually poked
// out from underneath the fairing.
const hasFairingAbove = !!opts.hasFairingAbove;

  const bodyDesign = opts.bodyDesign || { mode: 'solid', solidColor: '#e9edf2', dslText: '' };
  const designMode = bodyDesign.mode || 'solid';
  const solidFill = bodyDesign.solidColor || '#e9edf2';
  
  // ---- Interstage: hollow dark band. ----
// Structure-only member between a booster (below) and a stage (above).
// No engines, no legs, no fuel, no RCS. Drawn as a solid dark rectangle
// in the member's own colour with a subtle cylindrical gradient, plus
// a top rim highlight to read as "structural ring". Early exit before
// any of the engine / legs / body machinery below.
if (opts.stageRole === 'interstage') {
  const bandColor = (opts.bodyDesign && opts.bodyDesign.solidColor) || '#1a1d22';
  const grad = cachedGradient(ctx, 'interstageBand', Math.round(W) + ':' + bandColor, () => {
    const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
    // Darker edges, slightly lighter centre — same cylindrical read
    // the booster hull and engine bells use, just at low contrast so
    // the band still reads as "dark structural" not "shiny metal".
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    return g;
  });
  ctx.fillStyle = bandColor;
  ctx.fillRect(-W / 2, -H, W, H);
  ctx.fillStyle = grad;
  ctx.fillRect(-W / 2, -H, W, H);
  // Top rim — thin light band at the very top edge, reads as the
  // structural interface where the stage's thrust structure clamps.
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(-W / 2, -H + 0.5);
  ctx.lineTo(W / 2, -H + 0.5);
  ctx.stroke();
  // Bottom rim — same, where it meets the booster's hull top.
    // Bottom rim — same, where it meets the booster's hull top.
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.moveTo(-W / 2, -0.5);
  ctx.lineTo(W / 2, -0.5);
  ctx.stroke();
  
  // Pusher puff — drawn BEFORE this branch's return so it actually
  // fires for the interstage member. (The generic call at the end of
  // drawRocketArt is unreachable for this role due to the early return.)
  if (opts.pusherPuffProgress >= 0 && opts.pusherPuffProgress < 1) {
    drawPusherPuffsAtRim(ctx, W, H, opts.pusherPuffProgress);
  }
  return;
  }

// ---- Payload space role: pure fairing shape, early exit. ----
// PS-A: standalone shape renderer — no body/legs/RCS/engines for this
// role. Not yet reachable from any fleet record (that wiring is PS-C/D);
// this branch only fires when a caller explicitly passes
// stageRole: 'payloadSpace', same pattern as the nose early-exit below.
if (isPayloadSpace) {
  drawPayloadSpaceShape(ctx, W, H, mpp, opts);
  return;
}

// ---- Nose role: pure cone, early exit. ----
if (isNose) {
    const c = Math.max(0, Math.min(1, noseCurveness));
    const ctrlx = -W / 4 + c * (-W / 4);
    const ctrly = -H / 2 + c * (-H / 2);
    
    const conePath = () => {
      ctx.beginPath();
      ctx.moveTo(-W / 2, 0);
      ctx.quadraticCurveTo(ctrlx, ctrly, 0, -H);
      ctx.quadraticCurveTo(-ctrlx, ctrly, W / 2, 0);
      ctx.closePath();
    };
    
    ctx.fillStyle = solidFill;
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    conePath();
    ctx.fill();
    ctx.stroke();
    
    if (typeof applyCylindricalOverlay === 'function') {
      conePath();
      applyCylindricalOverlay(ctx, W);
    }
    
    // DSL for nose (if allowed — currently nose role is solid only, but
    // keep the hook so future support is drop-in).
    if (designMode === 'dsl' && typeof parseAndValidateDesign === 'function' &&
      typeof drawCustomDesignOps === 'function') {
      const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
      if (parsed.ok && parsed.ops.length) {
        ctx.save();
        conePath();
        ctx.clip();
        drawCustomDesignOps(ctx, W, H, parsed.ops);
        conePath();
        if (typeof applyCylindricalOverlay === 'function') applyCylindricalOverlay(ctx, W);
        ctx.restore();
      }
    }
    return;
  }
  
  // ---- Legs setup ----
  // No implicit fallback to CONFIG.RECOVERY_TYPE. Callers must pass
// recoveryType explicitly if they want legs drawn — otherwise default
// to null (no legs). The old fallback meant any caller that omitted the
// field silently got the ACTIVE stack's recovery hardware drawn on it,
// which is why fairing halves / payloads showed phantom legs during
// descent. Every caller that actually owns legs (member loop in
// render.js, renderVehiclePreview, renderStackPreview, figure-panel
// member loop) passes it explicitly.
const recoveryType = ('recoveryType' in opts) ? opts.recoveryType : null;


  const showLegs = !!(recoveryType && recoveryType.capabilities && recoveryType.capabilities.deploysOnVehicle);
  const hingeGeometryFn = (recoveryType && recoveryType.frame && typeof recoveryType.frame.hingeGeometry === 'function') ?
    recoveryType.frame.hingeGeometry :
    null;
  if (showLegs && !hingeGeometryFn) {
    console.warn(`drawRocketArt: recovery type "${recoveryType.id}" declares deploysOnVehicle but has no frame.hingeGeometry() — legs skipped this frame.`);
  }
  const legGeo = hingeGeometryFn ? hingeGeometryFn(H) : null;
  const legCount = (recoveryType && recoveryType.frame && recoveryType.frame.legCount) || 4;
  if (showLegs && legGeo && legCount !== 4) {
    console.warn(`drawRocketArt: recovery type "${recoveryType.id}" has legCount ${legCount}, but leg artwork is still only implemented for the 4-leg illusion — drawing 4 legs anyway.`);
  }
  
  // ---- Engine bell (stage, standalone) + interstage (booster top) ----
  // Both sizes derive from the engine layout's total mass flow rate:
  //   bellHeight = 0.007 × totalMassFlowRate    (m, per nozzle)
  //   bellRadius = bellHeight / 2
  //   interstageHeight = bellHeight × 1.20      (bell + margin)
  //   interstageDiameter = booster width (fixed)
  //
  // For multi-nozzle layouts (octaweb), we draw one small bell per outer
  // engine + a slightly bigger centre bell — the visible cluster. For a
  // single-nozzle layout, one bell.
  const engineLayout = opts.engineLayout || null;
const engineBell = (() => {
  if (!engineLayout || !engineLayout.frame || !engineLayout.frame.slots) return null;
  // Auto-sized from the record's own mass flow × the thruster type's
  // two bell constants. Falls back to no bell if either the layout or
  // the thruster schema can't be resolved.
  const dims = (typeof getEngineBellDims_m === 'function') ?
  getEngineBellDims_m({
    engineTypeId: engineLayout.id,
    engineThrusters: opts.engineThrusters,
  }) : { h: 0, d: 0 };
  if (!(dims.h > 0) || !(dims.d > 0)) return null;
  const nSlots = engineLayout.frame.slots.length;
  return {
    h: dims.h,
    d: dims.d,
    r: dims.d / 2,
    count: nSlots,
    slots: engineLayout.frame.slots,
  };
})();
  
  
  const p = legsProgress;
  const legHingeY = legGeo ? legGeo.hingeY : -H * 0.004;
  const legLength = legGeo ? legGeo.legLength : H * 0.27;
  const maxSweepRad = legGeo ? legGeo.maxSweepRad : (125 * Math.PI) / 180;
  const pistonMountY = legGeo ? legGeo.pistonMountY : -H * 0.08;
  const LEG_TIP_CURVENESS = 0.90;
  
  function drawLandingLeg(side, isBack) {
    const depthX = isBack ? 0.75 : 1.0;
    const depthY = isBack ? -H * 0.006 : 0;
    
    const j1x = side * (W * 0.49) * depthX;
    const j2x = side * (W * 0.05) * depthX;
    const jY = legHingeY + depthY;
    
    const pivotX = Math.sin(Math.PI / 4) * (j1x + j2x) / 1;
    const pivotY = jY;
    
    const currentSweep = side * p * maxSweepRad;
    const tipX = pivotX + legLength * Math.sin(currentSweep);
    const tipY = pivotY - legLength * Math.cos(currentSweep);
    
    const cutoutApexX = pivotX + (tipX - pivotX) * 0.07;
    const cutoutApexY = pivotY + (tipY - pivotY) * 0.07;
    
    const d1 = Math.hypot(tipX - j1x, tipY - jY) || 1;
    const u1x = (j1x - tipX) / d1,
      u1y = (jY - tipY) / d1;
    const d2 = Math.hypot(tipX - j2x, tipY - jY) || 1;
    const u2x = (j2x - tipX) / d2,
      u2y = (jY - tipY) / d2;
    const roundR = Math.min(legLength * LEG_TIP_CURVENESS, d1 * 0.85, d2 * 0.85);
    const p1x = tipX + u1x * roundR,
      p1y = tipY + u1y * roundR;
    const p2x = tipX + u2x * roundR,
      p2y = tipY + u2y * roundR;
    
    const tipApexX = 0.25 * p1x + 0.5 * tipX + 0.25 * p2x;
    const tipApexY = 0.25 * p1y + 0.5 * tipY + 0.25 * p2y;
    
    if (!isBack && legsState) {
      const legActualLength = Math.hypot(tipApexX - pivotX, tipApexY - pivotY);
      if (!legsState.actualLength) {
        legsState.actualLength = {};
        legsState.footX = {};
        legsState.footY = {};
      }
      legsState.actualLength[side] = legActualLength;
      legsState.footX[side] = tipApexX;
      legsState.footY[side] = tipApexY;
    }
    
    if (p > 0.02) {
      const pmX = pivotX;
      const pmY = pistonMountY + depthY;
      
      ctx.strokeStyle = isBack ? '#050608' : '#0a0c0f';
      ctx.lineWidth = Math.max(1.5, W * 0.040);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pmX, pmY);
      ctx.lineTo(tipApexX, tipApexY);
      ctx.stroke();
      
      ctx.strokeStyle = isBack ? '#171b22' : '#2c313a';
      ctx.lineWidth = Math.max(0.8, W * 0.018);
      ctx.beginPath();
      ctx.moveTo(pmX, pmY);
      ctx.lineTo(tipApexX, tipApexY);
      ctx.stroke();
      
      const rodStartFrac = 0.32;
      const rx1 = pmX + (tipApexX - pmX) * rodStartFrac;
      const ry1 = pmY + (tipApexY - pmY) * rodStartFrac;
      
      ctx.strokeStyle = isBack ? '#8a9099' : '#e6ecf2';
      ctx.lineWidth = Math.max(1, W * 0.022);
      ctx.beginPath();
      ctx.moveTo(rx1, ry1);
      ctx.lineTo(tipApexX, tipApexY);
      ctx.stroke();
      
      ctx.fillStyle = isBack ? '#0d1015' : '#1a1e24';
      ctx.beginPath();
      ctx.arc(rx1, ry1, W * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
    
    const legGrad = ctx.createLinearGradient(pivotX, jY, tipX, tipY);
    if (isBack) {
      legGrad.addColorStop(0, '#0f1114');
      legGrad.addColorStop(0.35, '#1a1d22');
      legGrad.addColorStop(0.7, '#08090b');
      legGrad.addColorStop(1, '#000000');
    } else {
      legGrad.addColorStop(0, '#1c1f24');
      legGrad.addColorStop(0.35, '#3a3f47');
      legGrad.addColorStop(0.7, '#14171b');
      legGrad.addColorStop(1, '#000000');
    }
    
    ctx.fillStyle = legGrad;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.2;
    
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(p1x, p1y);
    ctx.quadraticCurveTo(tipX, tipY, p2x, p2y);
    ctx.lineTo(j2x, jY);
    ctx.lineTo(cutoutApexX, cutoutApexY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(tipApexX, tipApexY);
    ctx.lineTo(cutoutApexX, cutoutApexY);
    ctx.closePath();
    ctx.fill();
    
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1.2, W * 0.018);
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(cutoutApexX, cutoutApexY);
    ctx.lineTo(j2x, jY);
    ctx.stroke();
    
    ctx.strokeStyle = isBack ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(j1x, jY);
    ctx.lineTo(p1x, p1y);
    ctx.stroke();
  }
  
// ---- SZAD overlay — DEFAULT (locked) boosters only ----
// (SZAD is NOT drawn here — see _drawSzadAtAnchor, called by each
// outer renderer that has baseX/baseY in scope. drawRocketArt's
// transform at this point has an off-canvas origin, so any local
// translate lands the image outside the visible buffer.)

// FRONT legs
if (showLegs) {
  drawLandingLeg(-1, false);
  drawLandingLeg(1, false);
}
  
  // ---- Body ----
  // Three visual cases:
  //   - stage with payloadSpace: tank rectangle + payload shape (cone or bulged)
  //   - booster: flat-top rectangle + interstage lip
  //   - rocket/legacy: cylinder + nose curve
  if (opts.stageRole === 'stage' && opts.stagePayload) {
    drawStageBody();
  } else {
  // isOpenTop: flat-top cylinder, no nose. True for boosters, and also
  // for a stage whose fairing is a separate member stacked above it —
  // the fairing is what supplies the nose in that case.
  // isOpenTop: flat-top cylinder, no nose. A real F9 upper stage is a
// flat-topped cylinder — its top is capped by the payload fairing
// (which is now a separate member in the stack), not by an integrated
// nose cone. Same for boosters, whose top is capped by the interstage.
// Only rocket / nose / payloadSpace roles get their own nose curve.
const isOpenTop = isBooster || opts.stageRole === 'stage';
const bodyPath = () => {
      ctx.beginPath();
      ctx.moveTo(-W / 2, 0);
      if (isOpenTop) {
        ctx.lineTo(-W / 2, -H);
        ctx.lineTo(W / 2, -H);
        ctx.lineTo(W / 2, 0);
      } else {
        const c = Math.max(0, Math.min(1, noseCurveness));
        const shoulderY = -H * 0.85;
        const ctrlA0x = -W * 0.25,
          ctrlA0y = shoulderY * 0.5 + (-H) * 0.5;
        const ctrlA1x = -W * 0.5,
          ctrlA1y = -H;
        const ctrlAx = ctrlA0x + c * (ctrlA1x - ctrlA0x);
        const ctrlAy = ctrlA0y + c * (ctrlA1y - ctrlA0y);
        ctx.lineTo(-W / 2, shoulderY);
        ctx.quadraticCurveTo(ctrlAx, ctrlAy, 0, -H);
        ctx.quadraticCurveTo(-ctrlAx, ctrlAy, W / 2, shoulderY);
        ctx.lineTo(W / 2, 0);
      }
      ctx.closePath();
    };
    
    ctx.fillStyle = solidFill;
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    bodyPath();
    ctx.fill();
    ctx.stroke();
    
    if (designMode !== 'dsl') {
      const shade = cachedGradient(ctx, 'cylShade', Math.round(W), () => {
        const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.14)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        g.addColorStop(1, 'rgba(0,0,0,0.20)');
        return g;
      });
      ctx.fillStyle = shade;
      bodyPath();
      ctx.fill();
    }
    
    if (designMode === 'dsl' && typeof parseAndValidateDesign === 'function' &&
      typeof drawCustomDesignOps === 'function' &&
      typeof applyCylindricalOverlay === 'function') {
      const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
      if (parsed.ok && parsed.ops.length) {
        ctx.save();
        bodyPath();
        ctx.clip();
        drawCustomDesignOps(ctx, W, H, parsed.ops);
        bodyPath();
        applyCylindricalOverlay(ctx, W);
        ctx.restore();
      } else {
        const shade = cachedGradient(ctx, 'cylShade', Math.round(W), () => {
          const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.14)');
          g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
          g.addColorStop(1, 'rgba(0,0,0,0.20)');
          return g;
        });
        ctx.fillStyle = shade;
        bodyPath();
        ctx.fill();
      }
    }
  }
  
  // ---- Stage body renderer: tank section + payload-space (nose) section ----
  function drawStageBody() {
    const payload = opts.stagePayload;
    const tankH_m = payload.tankHeight || 0;
    const capH_m = payload.capHeight || 0;
    const total_m = tankH_m + capH_m;
    // Scale so tank + payload exactly fill the member's visual height H,
    // even if the input dims don't quite sum to the record height.
    const tankH_px = total_m > 0 ? (tankH_m / total_m) * H : H * 0.75;
    const capH_px = H - tankH_px;
    
    // Widths in pixels; bulge can exceed W (fairing overhang).
    const capW_px = (payload.capWidth || 0) / mpp;
    const bulgeW_px = (payload.bulgeWidth || payload.capWidth || 0) / mpp;
    const payloadColor = payload.color || '#e9edf2';
    
    // ---- Tank section (rectangle, solidFill + cylinder gradient) ----
    const tankPath = () => {
      ctx.beginPath();
      ctx.rect(-W / 2, -tankH_px, W, tankH_px);
    };
    tankPath();
    ctx.fillStyle = solidFill;
    ctx.fill();
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    
    if (designMode !== 'dsl') {
      const g = cachedGradient(ctx, 'cylShade', Math.round(W), () => {
        const grad = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0.14)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.10)');
        grad.addColorStop(1, 'rgba(0,0,0,0.20)');
        return grad;
      });
      ctx.fillStyle = g;
      tankPath();
      ctx.fill();
    } else if (typeof parseAndValidateDesign === 'function' &&
      typeof drawCustomDesignOps === 'function' &&
      typeof applyCylindricalOverlay === 'function') {
      const parsed = parseAndValidateDesign(bodyDesign.dslText || '');
      if (parsed.ok && parsed.ops.length) {
        ctx.save();
        tankPath();
        ctx.clip();
        // DSL is relative to the tank section only (Y 0..1 = tank base..tank top).
        drawCustomDesignOps(ctx, W, tankH_px, parsed.ops);
        tankPath();
        applyCylindricalOverlay(ctx, W);
        ctx.restore();
      }
    }
    
    // ---- Payload space (the stage's nose) ----
    const payloadPath = () => {
      ctx.beginPath();
      const baseY = -tankH_px; // top of tank
      const tipY = -H; // payload tip
      const halfCapW = capW_px / 2;
      const halfBulgeW = bulgeW_px / 2;
      const isBulged = payload.kind === 'bulgedCapShape';
      
      if (isBulged) {
        // Four-section real fairing profile:
        //   base   → frustum (straight outward) → cylinder (bulge width held)
        //          → ogive (bezier to point)
        //
        // Frustum and cylinder heights are fractions of the total payload
        // height, and the ogive takes the rest. All fractions tuned to
        // match a typical real fairing silhouette.
        const frustumFrac = 0.22; // bottom 22% widens out
        const cylinderFrac = 0.28; // next 28% holds bulge width
        // Remaining 50% is the ogive.
        
        const frustumH = capH_px * frustumFrac;
        const cylinderH = capH_px * cylinderFrac;
        const ogiveH = capH_px - frustumH - cylinderH;
        
        const frustumTopY = baseY - frustumH;
        const cylinderTopY = frustumTopY - cylinderH;
        
        // Left side: base → frustum → cylinder → ogive → tip
        ctx.moveTo(-halfCapW, baseY);
        ctx.lineTo(-halfBulgeW, frustumTopY); // frustum (straight)
        ctx.lineTo(-halfBulgeW, cylinderTopY); // cylinder (straight vertical)
        ctx.bezierCurveTo(
          -halfBulgeW * 0.98, cylinderTopY - ogiveH * 0.30,
          -halfBulgeW * 0.45, tipY + ogiveH * 0.15,
          0, tipY
        );
        // Right side: tip → ogive → cylinder → frustum → base
        ctx.bezierCurveTo(
          halfBulgeW * 0.45, tipY + ogiveH * 0.15,
          halfBulgeW * 0.98, cylinderTopY - ogiveH * 0.30,
          halfBulgeW, cylinderTopY
        );
        ctx.lineTo(halfBulgeW, frustumTopY);
        ctx.lineTo(halfCapW, baseY);
      } else {
        // Simple nose cap: smooth ogive from base width to a point, no bulge,
        // no cylinder section.
        ctx.moveTo(-halfCapW, baseY);
        ctx.bezierCurveTo(
          -halfCapW * 0.70, baseY + capH_px * 0.30,
          -halfCapW * 0.30, tipY + capH_px * 0.20,
          0, tipY
        );
        ctx.bezierCurveTo(
          halfCapW * 0.30, tipY + capH_px * 0.20,
          halfCapW * 0.70, baseY + capH_px * 0.30,
          halfCapW, baseY
        );
      }
      ctx.closePath();
    };
    
    payloadPath();
    ctx.fillStyle = payloadColor;
    ctx.fill();
    ctx.strokeStyle = '#8b93a0';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    
    // Cylindrical gradient over the payload (widest width = bulge or cap).
    const gradW = Math.max(capW_px, bulgeW_px) || W;
    const pGrad = cachedGradient(ctx, 'cylShade', Math.round(gradW), () => {
      const g = ctx.createLinearGradient(-gradW / 2, 0, gradW / 2, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.14)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
      g.addColorStop(1, 'rgba(0,0,0,0.20)');
      return g;
    });
    ctx.fillStyle = pGrad;
    payloadPath();
    ctx.fill();
  }
  
  // (Old hardcoded "drawGridFins" helper — a fixed-size decoration with no
// parameters, no type lookup, and a hardcoded ±7° tilt — has been removed.
// Real grid fins are now a proper hardware type drawn via drawGridFin /
// drawGridFinEdgeOn further down, driven by opts.gridFinType / Params.)
  
if (isBooster) {
  // ---- Bottom black band — just above the engine bay ----
  // Same gradient treatment the interstage band uses, so both read as
  // hardware trim, not a painted stripe. Drawn AFTER the body so it
  // sits cleanly on top of the cylinder gradient.
  const BOOSTER_BOTTOM_BAND_FRAC = 0.06;
  const bandH_px = Math.max(3, H * BOOSTER_BOTTOM_BAND_FRAC);
  const bottomBandGrad = cachedGradient(ctx, 'boosterBottomBand', Math.round(W), () => {
    const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
    g.addColorStop(0, '#0a0c10');
    g.addColorStop(0.5, '#2a2d33');
    g.addColorStop(1, '#0a0c10');
    return g;
  });
  ctx.fillStyle = bottomBandGrad;
  ctx.fillRect(-W / 2, -bandH_px, W, bandH_px);
  
  // Top seam — where the black band meets the white tank.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.60)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-W / 2, -bandH_px);
  ctx.lineTo(W / 2, -bandH_px);
  ctx.stroke();
  
  // Bottom rim — reads as the top edge of the engine bay itself.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(-W / 2, -0.5);
  ctx.lineTo(W / 2, -0.5);
  ctx.stroke();
  
  // Interstage is now its own stack member; the booster no longer
  // renders a band at its top. Legacy Block 3 records — which don't
  // have an interstage member — will visually look different (no top
  // band) until migrated. Acceptable since Block 3's interstage role
  // migration is a separate follow-up.
  
} else if (opts.stageRole !== 'stage') {
    // Rocket / legacy rocket: checkerboard stripe + grid fins near the
    // shoulder. Stage is skipped entirely — its payload space IS the
    // visual top.
    const stripeTop = -H * 0.80,
      stripeBottom = -H * 0.72;
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-W / 2, stripeTop, W, stripeBottom - stripeTop);
    const chk = W * 0.16,
      chkY = (stripeTop + stripeBottom) / 2 - chk / 2;
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(-chk, chkY, chk, chk);
    ctx.fillRect(0, chkY, chk, chk);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-chk, chkY, chk, chk / 2);
    ctx.fillRect(-chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    ctx.fillRect(0, chkY, chk, chk / 2);
     ctx.fillRect(0, chkY, chk, chk / 2);
  ctx.fillRect(chk / 2, chkY + chk / 2, chk / 2, chk / 2);
  }
  // stage role: no fins / no checkerboard — payload space is the visual top.
  // stage role: no fins / no checkerboard.
  else {
    const stripeTop = -H * 0.80,
      stripeBottom = -H * 0.72;
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-W / 2, stripeTop, W, stripeBottom - stripeTop);
    const chk = W * 0.16,
      chkY = (stripeTop + stripeBottom) / 2 - chk / 2;
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(-chk, chkY, chk, chk);
    ctx.fillRect(0, chkY, chk, chk);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(-chk, chkY, chk, chk / 2);
    ctx.fillRect(-chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    ctx.fillRect(0, chkY, chk, chk / 2);
    ctx.fillRect(chk / 2, chkY + chk / 2, chk / 2, chk / 2);
    
      // (Old hardcoded grid-fin decoration removed — see comment above.)
  }
  
  // FRONT legs
  if (showLegs) {
    drawLandingLeg(-1, false);
    drawLandingLeg(1, false);
  }
  
// ---- Engine bells (bottom-of-stack bodies only) ----
// Drawn when this member has nothing below it in the stack (boosters,
// standalone rocket role, standalone stage). A stage sitting above a
// booster hides its MVac bell inside the interstage, exactly as real F9
// hardware does — see opts.hasMemberBelow gate below.
const drawsEngineBells = (opts.stageRole === 'stage' || isBooster || opts.stageRole === 'rocket');
if (drawsEngineBells && engineBell && !opts.hasMemberBelow) {
  // Bell dimensions come straight from the thruster type's hardware
  // constants × this record's own mass flow rate — no percentage-of-
  // rocket-width fudge. Bell exit plane sits BELOW the hull base,
  // matching real F9: nozzle exit is the ground-contact point, hull
  // base sits bellHeight above it. Caller positions the member so the
  // hull base is at (0,0) in local canvas coords, and this function
  // draws the bell hanging down from there.
  const sR_m = engineBell.r; // exit radius, meters
  const sH_m = engineBell.h;
  const hullHalf_m = (W * mpp) / 2;
  
  // de Laval bell curve — rounded throat, cylindrical wall, flat exit.
  function bellPath(g, sR, sH) {
  // Narrow throat + steep initial shoulder + near-straight lower wall.
  //   tR     = throat half-width / exit half-width.  0.35–0.45 = nozzle
  //            bell; higher (0.6+) collapses to a cone shape.
  //   CP1 y  = where the shoulder curve bottoms out. Lower = shoulder
  //            sharper; higher = rounder.
  //   CP1 x  = how far the shoulder bulges outward. Higher = more
  //            dramatic flare.
  //   CP2    = controls the lower-wall straightness. x closer to sR
  //            gives a straighter wall near the exit.
  const tR = sR * 0.35;
  g.beginPath();
  g.moveTo(-tR, 0);
  g.bezierCurveTo(
    -tR * 2.6, sH * 0.18, // steep initial shoulder
    -sR * 0.98, sH * 0.68, // nearly straight mid-wall
    -sR, sH // exit corner
  );
  g.lineTo(sR, sH);
  g.bezierCurveTo(
    sR * 0.98, sH * 0.68,
    tR * 2.6, sH * 0.18,
    tR, 0
  );
  g.closePath();
}
  
  const drawOneBell = (cx, sR, sH, gimbalRad) => {
    ctx.save();
    ctx.translate(cx, 0);
    if (Number.isFinite(gimbalRad) && gimbalRad !== 0) ctx.rotate(gimbalRad);
    const g = ctx.createLinearGradient(-sR, 0, sR, 0);
    g.addColorStop(0, '#1c1e22');
    g.addColorStop(0.5, '#4a4e54');
    g.addColorStop(1, '#1c1e22');
    ctx.fillStyle = g;
    bellPath(ctx, sR, sH);
    ctx.fill();
    ctx.strokeStyle = '#0f1114';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-sR, sH);
    ctx.lineTo(sR, sH);
    ctx.stroke();
    ctx.restore();
  };
  
  if (engineBell.count === 1) {
  const gEng = (opts.engineThrusters && opts.engineThrusters.gimbal) ? opts.engineThrusters.gimbal : null;
  // Live gimbal angle passed by caller (physics snapshot for sim,
  // 0 for static previews). Read from the caller's engine list if
  // available, else default 0.
  let gRad = 0;
  if (opts.liveEngines && opts.liveEngines.length) {
    const gE = opts.liveEngines.find(e => e.gimbal);
    if (gE && Number.isFinite(gE.gimbalDeg)) gRad = gE.gimbalDeg * Math.PI / 180;
  }
  drawOneBell(0, sR_m / mpp, sH_m / mpp, gRad);
} else {
    // Cluster — same z-sorted painter's order.
    // Cluster ring radius: min of stored octaRadius and what fits
    // inside the hull, accounting for the bell's own exit radius.
    const gap_m = 0.03;
    const R_m = (opts.params && Number.isFinite(opts.params.octaRadius)) ? opts.params.octaRadius : 1.7;
    const R_fit_m = Math.max(sR_m + 0.01, hullHalf_m - sR_m - gap_m);
    const R_vis_m = Math.min(R_m, R_fit_m);
    const items = [];
    engineBell.slots.forEach(slot => {
      if (slot.angleDeg == null) items.push({ slot, z: 0, isCenter: true });
      else items.push({ slot,
        z: Math.sin(slot.angleDeg * Math.PI / 180) * R_vis_m,
        isCenter: false });
    });
    items.sort((a, b) => b.z - a.z);
items.forEach(({ slot }) => {
  const pos = (typeof slot.position === 'function') ? slot.position(R_vis_m) : { x: 0 };
  // Live gimbal angle — same value for all gimbal-capable engines.
  let gRad = 0;
  if (opts.liveEngines && opts.liveEngines.length) {
    const eng = opts.liveEngines.find(e => e.gimbal && e.angleDeg === slot.angleDeg);
    if (eng && Number.isFinite(eng.gimbalDeg)) gRad = eng.gimbalDeg * Math.PI / 180;
  }
  drawOneBell((pos.x || 0) / mpp, sR_m / mpp, sH_m / mpp, gRad);
});
  }
}
  
// ---- Grid fins ----
// Per-fin state. `deploy` and `control` are both in DEGREES.
//   deploy:  0 = deployed (fin perpendicular to hull), ±90 = stowed
//            (flat against hull). Sign is fin identity: L=+, R=−, F=+, B=−.
//   control: F/B only, only meaningful at deploy = 0. Front ACW
//            (from front view) = +deg; back mirrors (visual same
//            direction in side view, opposite in 3D).
//
// F/B share ONE state entry (mirror pair); L/R independent deploy.
// Mesh visible only on F/B stowed (chord × span face aimed at viewer).
//
// PIVOT POSITIONS (this is what makes rotation look right):
//   All four fins pivot around their PHYSICAL hinge axis, which runs
//   along the thickness-CENTER of the fin's root end. In the deployed
//   pose that puts the pivot at the vertical center of the strip; in
//   the stowed pose, at the top edge of the strip (fin hangs down from
//   it). Achieved by keeping the world pivot fixed at (anchor, hingeY)
//   and offsetting the rect upward by p × thicknessPx/2 as deploy
//   progresses — the rect's top migrates from "at pivot" (stowed) to
//   "thicknessPx/2 above pivot" (deployed, rect centered on pivot).
if (opts.gridFinType && opts.gridFinParams) {
  const gp = opts.gridFinParams;
  const spanPx = (gp.span || 0) / mpp;
  const chordPx = (gp.chord || 0) / mpp;
  const thicknessPx = (gp.thickness || 0) / mpp;
  const cellPx = (gp.cellWidth || 0.17) / mpp;
  const gapPx = (opts.gridFinType.frame && Number.isFinite(opts.gridFinType.frame.gapM)) ?
    opts.gridFinType.frame.gapM / mpp : 0;
  const hingeY = -(gp.finPositionY || 0) / mpp;
  const hullHalfPx = W / 2;
  
  const st = opts.gridFinState || {
    L: { deploy: 90, control: 0 },
    R: { deploy: -90, control: 0 },
    FB: { deploy: 90, control: 0 },
  };
  
  const finColor = opts.gridFinColor || '#8a9198';
  const sideStyle = { fill: finColor, stroke: '#48515e' };
  const fbStyle = { fill: finColor, stroke: '#5a626e' };
  
  const pFromDeg = (d) => 1 - Math.min(1, Math.abs(d) / 90);
  
  // ---- F/B pair ----
  const fbP = pFromDeg(st.FB.deploy);
  const fbControlDeg = (st.FB.deploy === 0) ? (st.FB.control || 0) : 0;
  const fbControlRad = fbControlDeg * Math.PI / 180;
  const fbW = chordPx;
  const fbH = spanPx + (thicknessPx - spanPx) * fbP;
  // Rect top migrates from 0 (stowed → hangs from pivot) to
  // -thicknessPx/2 (deployed → centered on pivot).
  const fbTopY = -fbP * thicknessPx / 2;
  const fbShowMesh = (fbP < 0.2);
  
  // B (ghost) first — same visual direction as F (see earlier note).
  ctx.save();
  ctx.globalAlpha = 0.15;
  drawGridFinFace(ctx, 0, hingeY, -fbW / 2, fbTopY, fbW, fbH, cellPx, fbStyle, fbShowMesh, +fbControlRad);
  ctx.restore();
  
  // ---- L/R pair ----
  // Local rect extends outward from the pivot (R: +X, L: −X), with
  // thickness centered on the local Y-axis. Rotation about the pivot
  // swings the strip from hanging-down (stowed) to pointing-outward
  // (deployed); the pivot itself is the fin's physical hinge axis —
  // root end, thickness-center.
  const lp = pFromDeg(st.L.deploy);
  const rp = pFromDeg(st.R.deploy);
  const lRot = -(1 - lp) * (Math.PI / 2); // stowed −π/2 (down) → deployed 0
  const rRot = +(1 - rp) * (Math.PI / 2); // stowed +π/2 (down) → deployed 0
  // Hinge offset = gap + thickness/2. The gap is the air space between
// the hull surface and the fin's INNER FACE — but the hinge axis runs
// along the fin's thickness-CENTER, so the physical hinge sits a half-
// thickness further out. Without the +thickness/2, the stowed fin's
// inner half penetrates the hull by exactly thickness/2.
const hingeOffsetX = hullHalfPx + gapPx + thicknessPx / 2;
const rightHingeX = hingeOffsetX;
const leftHingeX = -hingeOffsetX;

// ---- Hinge brackets ----
// Small structural bosses bridging the hull-to-hinge air gap on both
// sides. Without these, the offset hinge leaves the deployed fin
// visually detached — a floating rectangle next to the rocket. Drawn
// BEFORE the fin rects so a deployed fin cleanly overlaps its own
// bracket (they share the hinge axis).
const bracketH = Math.max(3, thicknessPx * 0.55);
const bracketColor = '#242830';
const bracketEdge = '#0c0e12';
const bracketHighlight = 'rgba(255,255,255,0.28)';
function drawHingeBracket(sideSign) {
  const hullEdgeX = sideSign * hullHalfPx;
  const hingeX = sideSign * hingeOffsetX;
  const x0 = Math.min(hullEdgeX, hingeX);
  const x1 = Math.max(hullEdgeX, hingeX);
  const y0 = hingeY - bracketH / 2;
  ctx.save();
  ctx.fillStyle = bracketColor;
  ctx.fillRect(x0, y0, x1 - x0, bracketH);
  ctx.strokeStyle = bracketEdge;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(x0, y0, x1 - x0, bracketH);
  ctx.strokeStyle = bracketHighlight;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + 0.4);
  ctx.lineTo(x1, y0 + 0.4);
  ctx.stroke();
  ctx.restore();
}
drawHingeBracket(-1);
drawHingeBracket(+1);

// L fin rect: (−spanPx, −thick/2) → (0, +thick/2).
// R fin rect: (0, −thick/2) → (+spanPx, +thick/2).
drawGridFinFace(ctx, leftHingeX, hingeY, -spanPx, -thicknessPx / 2, spanPx, thicknessPx, cellPx, sideStyle, false, lRot);
drawGridFinFace(ctx, rightHingeX, hingeY, 0, -thicknessPx / 2, spanPx, thicknessPx, cellPx, sideStyle, false, rRot);

  // F drawn last (front, opaque).
  drawGridFinFace(ctx, 0, hingeY, -fbW / 2, fbTopY, fbW, fbH, cellPx, fbStyle, fbShowMesh, +fbControlRad);
}
  
  
  // ---- RCS pods ----
  const firing = opts.firing || {};
  const pod = opts.pod || {};
  const rcsTopMargin = opts.rcsTopMargin !== undefined ? opts.rcsTopMargin : ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_TOP_MARGIN : 0);
  const rcsBottomMargin = opts.rcsBottomMargin !== undefined ? opts.rcsBottomMargin : ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_BOTTOM_MARGIN : 0);
  
  // Same reasoning as recoveryType above — no implicit CONFIG fallback.
// A fairing half has no RCS pods; only stack members and previews that
// explicitly pass rcsType should get them.
const rcsType = ('rcsType' in opts) ? opts.rcsType : null;

  const podDefs = (rcsType && rcsType.kind === 'cornerPods' && rcsType.frame && rcsType.frame.pods) ? rcsType.frame.pods : [];
if (rcsType && rcsType.kind !== 'cornerPods' && podDefs.length === 0) {
  console.warn(`drawRocketArt: RCS type "${rcsType.id}" (kind "${rcsType.kind}") has no matching pod artwork yet — RCS pods skipped this frame.`);
}

const corners = {},
  lateralDir = {};
const memberH_m = H * mpp;
const rawTopY = opts.rcsTopY !== undefined ? opts.rcsTopY :
  ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_TOP_Y : 0);
const rawBottomY = opts.rcsBottomY !== undefined ? opts.rcsBottomY :
  ((typeof CONFIG !== 'undefined') ? CONFIG.RCS_BOTTOM_Y : 0);
// Clamp both offsets to the member's own height so an over-large value
// can't place pods outside the member's silhouette (e.g. stage pods
// climbing into the payload space above).
const rcsTopY = Math.max(0, Math.min(rawTopY, memberH_m));
const rcsBottomY = Math.max(0, Math.min(rawBottomY, memberH_m));

// A5 — build the same body-wide pod id each pod has in
// body.lastRcs.firing / body.lastRcs.pod (see rcs.js's buildPodEntries
// and buildPodId): `b<memberIdx>.<side><idxWithinSide>` — side from
// corner[0] sign, idx by descending LOCAL Y within (this member, side).
// Local sort here is enough because we're drawing ONE member: within
// this call, "local Y" ordering gives the same topmost-first index that
// buildPodEntries assigns body-wide.
const podIdByRegistryId = {};
{
  const bySide = { L: [], R: [] };
  podDefs.forEach(pd => {
    const side = pd.corner[0] < 0 ? 'L' : 'R';
    const localY = pd.corner[1] === 'top' ? rcsTopY : rcsBottomY;
    bySide[side].push({ pd, localY });
  });
  ['L', 'R'].forEach(side => {
    bySide[side]
      .sort((a, b2) => b2.localY - a.localY)
      .forEach((entry, i) => {
        const podId = (typeof buildPodId === 'function') ?
          buildPodId(memberIdx, side, i + 1) :
          `b${memberIdx}.${side}${i + 1}`;
        podIdByRegistryId[entry.pd.id] = podId;
      });
  });
}

podDefs.forEach(pd => {
  const xSign = pd.corner[0],
    isTop = pd.corner[1] === 'top';
  const yLocal = isTop ? rcsTopY : rcsBottomY;
  const podId = podIdByRegistryId[pd.id];
  if (!podId) return;
  corners[podId] = [xSign * (W / 2), -(yLocal / mpp)];
  lateralDir[podId] = [xSign, 0];
});
  
  const plumeLen = W * 0.6;
  const fEps = 1;
  
function drawGasPuff(cx, cy, dir, seed, duty, modeOpts) {
  modeOpts = modeOpts || {};
  const memberIdx = (Number.isInteger(opts.memberIdx) && opts.memberIdx >= 0) ?
    opts.memberIdx : 0;
  const bodyIdx = (Number.isInteger(opts.bodyIdx) && opts.bodyIdx >= 0) ?
    opts.bodyIdx : 0;
  const poolKey = bodyIdx + '_' + memberIdx;
  const pool = _gasPoolFor(poolKey);
  
  const d = Math.max(0, Math.min(1, Number.isFinite(duty) ? duty : 1.0));
  if (d < 0.05 && !modeOpts.burst) return;
  
  let spawnN = 0;
  if (modeOpts.burst) {
    // PWM pulse — fixed burst of particles, spawned all at once on the
    // rising edge. Strength independent of duty (the pulse either
    // happens or doesn't). 6 particles reads as a compact puff that
    // expands and drifts, without overwhelming the frame.
    spawnN = 6;
  } else {
    // Continuous mode — probabilistic per-frame spawn scaled by duty.
    if (Math.random() < d) spawnN++;
    if (Math.random() < d * 0.7) spawnN++;
    if (Math.random() < d * 0.35) spawnN++;
  }

  for (let s = 0; s < spawnN; s++) {
    if (pool.particles.length >= _GAS_PARTICLE_CAP) break;
    const [dx, dy] = dir;
    const nx = -dy, ny = dx;
    // Emission speed — several plume-lengths per second so particles
    // visibly travel away from the nozzle. Slightly slower at low duty
    // (weaker puff reads as gentler venting).
    const dutySpeedScale = 0.75 + 0.25 * d;
    const speed = plumeLen * (4.0 + 0.8 * Math.random()) * dutySpeedScale;
    // Perpendicular spread — small cone, not a laser beam.
    const spread = (Math.random() - 0.5) * 0.10;
    pool.particles.push({
      x: cx,
      y: cy,
      vx: (dx + nx * spread) * speed,
      vy: (dy + ny * spread) * speed,
      age: 0,
      // Lifetime slightly shorter at low duty — the cloud dissipates
      // faster when the emission is weak.
      life: (0.30 + 0.25 * Math.random()) * (0.75 + 0.25 * d),
      r0: W * (0.040 + 0.020 * Math.random()),
      growRate: W * (0.40 + 0.40 * Math.random()),
    });
  }

  // ---- Draw the pool once per 5 ms bin ----
  const bin = Math.floor(performance.now() / 5);
  if (bin === pool.drawBin) return;
  pool.drawBin = bin;

  const sprite = _getPuffSprite();
  if (!sprite) return;

  ctx.save();
  for (let i = 0; i < pool.particles.length; i++) {
    const p = pool.particles[i];
    const f = p.age / p.life;
    const r = p.r0 + p.growRate * p.age;
    // Ease-out fade — bright at birth, gone at end of life.
    const alpha = (1 - f) * (1 - f) * 0.85;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
  
  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }
  
  const _rcsMode = opts.rcsMode || {};
const _rcsRising = opts.rcsRising || {};

Object.keys(corners).forEach(k => {
      const [cxRaw, cy] = corners[k];
      const pp = pod[k] || { Fx: 0, Fy: 0, up: 0, dn: 0, lat: 0 };
      const _mode = _rcsMode[k] || 'continuous';
      const _risingLat = !!(_rcsRising[k] && _rcsRising[k].lat);
    
    const podW = W * 0.05;
    const podH = W * 0.10;
    const podR = W * 0.03;
    
    const sideSign = Math.sign(cxRaw);
    const podX = cxRaw + sideSign * podW * 0.5 - podW / 2;
    const podY = cy - podH / 2;
    
         if (Math.abs(pp.Fx) > fEps) {
     const latDuty = Number.isFinite(pp.lat) ? pp.lat : 0;
     // PWM-gated pods only emit on rising edge — one discrete pulse per
     // PWM period. Continuous pods emit ∝ duty every frame.
     const emit = (_mode === 'pwm') ? _risingLat : true;
     const _latOpts = emit ? null : { suppressed: true };
     if (emit) {
       drawGasPuff(cxRaw, cy, lateralDir[k], k.charCodeAt(k.length - 2), latDuty,
                   { burst: _mode === 'pwm' });
     }
   }
if (Math.abs(pp.Fy) > fEps) {
  const vDir = pp.Fy > 0 ? [0, 1] : [0, -1];
  const outX = cxRaw + sideSign * podW * 0.6;
  const vDuty = (pp.Fy > 0)
    ? (Number.isFinite(pp.up) ? pp.up : 0)
    : (Number.isFinite(pp.dn) ? pp.dn : 0);
  // Vertical path is only used by boolean commands (human) — always
  // continuous in practice, but respect mode for correctness.
  if (_mode !== 'pwm') {
    drawGasPuff(outX, cy, vDir, k.charCodeAt(k.length - 1) + 3, vDuty);
  }
}
    
    ctx.save();
    
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 0.5;
    
    ctx.fillStyle = firing[k] ? '#aef1ff' : '#2a2d33';
    roundRectPath(podX, podY, podW, podH, podR);
    ctx.fill();
    
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    
    ctx.strokeStyle = 'rgba(20,24,30,0.85)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    
    const hlX = sideSign > 0 ? podX + podW * 0.72 : podX + podW * 0.12;
    const hlGrad = ctx.createLinearGradient(hlX, 0, hlX + podW * 0.15, 0);
    hlGrad.addColorStop(0, 'rgba(255,255,255,0.0)');
    hlGrad.addColorStop(0.5, firing[k] ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.25)');
    hlGrad.addColorStop(1, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = hlGrad;
    roundRectPath(podX + podW * 0.55, podY + podH * 0.15, podW * 0.35, podH * 0.7, podR * 0.6);
    ctx.fill();
    
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.7;
    const slotX = sideSign > 0 ? podX + podW * 0.35 : podX + podW * 0.65;
    for (let i = 0; i < 2; i++) {
      const sy = podY + podH * (0.30 + i * 0.40);
      ctx.beginPath();
      ctx.moveTo(slotX - podW * 0.12, sy);
      ctx.lineTo(slotX + podW * 0.12, sy);
      ctx.stroke();
    }
    
        ctx.restore();
    });
    
    // Pusher rim puff — drawn LAST so it sits on top of every other layer.
    // Only fires when the caller (render.js) determined this is the top
    // member of a body with an active pusher event.
    if (opts.pusherPuffProgress >= 0 && opts.pusherPuffProgress < 1) {
      drawPusherPuffsAtRim(ctx, W, H, opts.pusherPuffProgress);
    }
    }

// ---------------------------------------------------------------------------
// P4-D4: build the payload-space descriptor for a stage record. The payload
// space IS the stage's nose — either a simple cone (noseCapShape) or a
// bulged fairing (bulgedCapShape). Only applies to stageRole === 'stage'.
// ---------------------------------------------------------------------------
function buildStagePayload(rec) {
  if (!rec || rec.stageRole !== 'stage' || !rec.payloadSpace) return null;
  const ps = rec.payloadSpace;
  const ptype = (typeof getComponentType === 'function') ? getComponentType(ps.typeId) : null;
  return {
    kind: ptype ? ptype.kind : 'noseCapShape',
    tankHeight: (rec.fuel && Number.isFinite(rec.fuel.tankHeight)) ? rec.fuel.tankHeight : 0,
    capHeight: (ps.params && Number.isFinite(ps.params.capHeight)) ? ps.params.capHeight : 0,
    capWidth: (ps.params && Number.isFinite(ps.params.capWidth)) ? ps.params.capWidth : 0,
    bulgeWidth: (ps.params && Number.isFinite(ps.params.bulgeWidth)) ? ps.params.bulgeWidth : null,
    color: ps.color || '#e9edf2',
  };
}

// ---------------------------------------------------------------------------
// Static vehicle preview — draws a vehicle at rest (legs stowed, no thrust,
// no RCS firing) onto any <canvas>, scaled to fill it at true aspect ratio.
// Used by the home page's "current vehicle" card and the fleet page's
// vehicle detail view, so both show the literal same artwork as the live
// simulator rather than a generic placeholder.
//
// `vehicle` is optional — an object with { height, width, rcsTopMargin,
// rcsBottomMargin, recoveryTypeId, rcsTypeId } (the last two new in Step G),
// e.g. a fleet record from fleet.js. Pass it explicitly when showing a
// specific record that may not be the currently-active one (the fleet
// page's editor) — when `recoveryTypeId`/`rcsTypeId` are present, THIS
// record's own hardware types are resolved and drawn (correct legs/pods
// for whatever's actually selected in the form), rather than whatever the
// globally-active CONFIG happens to be. Omit `vehicle` entirely to fall
// back to CONFIG outright (the home page always shows the active/selected
// vehicle, so CONFIG already IS the right vehicle there).
//
// Sizing: the canvas's CSS WIDTH is the one fixed thing (set by the page's
// layout/CSS) — the rocket's width is always exactly 60% of it. Height then
// follows from the vehicle's true (undistorted) real-world height:width
// ratio, so the canvas HEIGHT is computed here and applied to the element,
// rather than being a fixed value — a short stubby vehicle gets a short
// canvas, a tall slender one gets a tall canvas, proportions untouched.
//
// Renders at the display's full devicePixelRatio — this is a cheap one-shot
// draw (not an animation loop), so there's no performance reason to render
// it any lower-res and let it look soft on high-DPI screens.
// ---------------------------------------------------------------------------
function renderVehiclePreview(canvas, vehicle) {
  if (!canvas) return;
  const v = vehicle || {
    height: CONFIG.ROCKET_HEIGHT,
    width: CONFIG.ROCKET_WIDTH,
    rcsTopMargin: CONFIG.RCS_TOP_MARGIN,
    rcsBottomMargin: CONFIG.RCS_BOTTOM_MARGIN,
  };
  const cssW = canvas.clientWidth || canvas.width;
  if (!cssW) return;
  
  // Rocket width = 60% of canvas width, fixed. Height follows from the
  // real height:width ratio at that same scale (mpp) — true proportion,
  // never stretched/squashed.
  // Same height cap logic as renderStackPreview — keeps tall rockets from
// stretching the canvas past a reasonable size, at the cost of the
// drawn rocket being correspondingly narrower (correct — aspect is
// intrinsically preserved).
const MAX_DRAWN_H_PX = 520;
const maxW = cssW * 0.50;
const mppW = v.width / maxW;
const mppH = v.height / MAX_DRAWN_H_PX;
const mpp = Math.max(mppW, mppH);
const W = v.width / mpp;
const H = v.height / mpp;

// Reserve vertical space for anything drawn BELOW the body's base —
// chiefly the stage engine bell, which extends downward from local
// (0, 0). Previously canvas height was H/0.94, leaving only ~3% of H
// below the base, which clipped the bell (≈15% of a stage's height) to
// a thin sliver. Formula mirrors drawRocketArt's own bell sizing
// exactly: h_m = 0.007 × (total flow / slot count); pixel extent = h_m / mpp.
let subBaseExtentPx = 0;
const _drawsBells = (v.stageRole === 'stage' || v.stageRole === 'booster' || v.stageRole === 'rocket');
if (_drawsBells && typeof engineBellHeightForRecord === 'function') {
  // Bell height comes from the record's own mass flow × the thruster
  // type's massFlowToBellHeight constant, matching what drawRocketArt
  // will actually draw. Falls through to 0 if the thruster or layout
  // can't be resolved.
  const bellH_m = engineBellHeightForRecord({
    stageRole: v.stageRole,
    engineTypeId: v.engineLayout ? v.engineLayout.id : null,
    engineThrusters: v.engineThrusters,
  });
  if (bellH_m > 0) subBaseExtentPx = bellH_m / mpp;
}

const contentH = H + subBaseExtentPx;
const vMarginFrac = 0.94;
const cssH = contentH / vMarginFrac;
canvas.style.height = cssH + 'px';

const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(cssW * dpr);
canvas.height = Math.round(cssH * dpr);
const pctx = canvas.getContext('2d');
pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
pctx.clearRect(0, 0, cssW, cssH);

const baseX = cssW / 2;
// Symmetric top/bottom margins around contentH (body above base, bell
// below). Base sits H below content-top.
const baseY = (cssH - contentH) / 2 + H;

  // STEP G: resolve THIS vehicle's own recovery/RCS types when it names
  // them, instead of always drawing whatever the globally-active CONFIG is.
  // getComponentType() comes from componentLibrary.js, which every page
  // that calls renderVehiclePreview() already loads before this file.
  // P4-B3: distinguish "caller didn't pass recoveryType" (use CONFIG as
  // fallback) from "caller explicitly passed null" (no recovery at all —
  // e.g. a booster with hasRecovery:false). `'recoveryType' in opts` is the
  // only way to tell the difference.
  // `v` carries a *type id*, not a resolved type object — resolve it here.
  // null id → null type → no hardware rendered (e.g. hasRecovery:false).
  const recoveryType = (v.recoveryTypeId && typeof getComponentType === 'function') ?
    getComponentType(v.recoveryTypeId) :
    null;
  const rcsType = (v.rcsTypeId && typeof getComponentType === 'function') ?
    getComponentType(v.rcsTypeId) :
    null;
  
    pctx.save();
  pctx.translate(baseX, baseY);
  // Standalone preview — the interstage height comes precomputed on the
// vehicle object (populated by previewVehicleFor / _previewVehicleFor,
// which look up the real stage-above from the fleet). Fallback to the
// stage-less compute only for old call sites that don't supply it.
let interstageHeight_m = Number.isFinite(v.interstageHeight_m) ? v.interstageHeight_m : null;
if (interstageHeight_m === null && v.stageRole === 'booster' && typeof computeInterstageForBooster === 'function') {
  const inter = computeInterstageForBooster(v, null);
  if (inter && Number.isFinite(inter.height)) interstageHeight_m = inter.height;
}
  drawRocketArt(pctx, W, H, mpp, {
        hasMemberBelow: false,
        interstageHeight_m: interstageHeight_m,
        rcsTopY: v.params ? v.params.rcsTopY : undefined,
  rcsBottomY: v.rcsBottomY,
  recoveryType,
  rcsType,
  stageRole: v.stageRole,
  noseCurveness: v.noseCurveness,
  bodyDesign: v.bodyDesign,
  payloadSpaceColor: v.payloadSpaceColor,
  stagePayload: v.stagePayload,
  payloadKind: v.payloadKind,
  payloadCapWidth: v.payloadCapWidth,
  payloadBulgeWidth: v.payloadBulgeWidth,
  payloadFrustumAngleDeg: v.payloadFrustumAngleDeg,
    payloadCurveRatio: v.payloadCurveRatio,
    payloadColor: v.payloadColor,
    // Engine bell / interstage sizing — drawRocketArt's bell block reads
    // these. Without them every standalone preview (home member viewer,
    // fleet detail, fleet editor) silently skipped the stage's bell.
    engineLayout: v.engineLayout || null,
    engineThrusters: v.engineThrusters || null,
    params: v.params || null,
    // Grid fins — type object drives finCount/gap, params drive geometry.
      // Grid fins — type object drives finCount/gap, params drive geometry.
  gridFinType: v.gridFinType || null,
    gridFinParams: v.gridFinParams || null,
            gridFinState: v.gridFinState || null,
      // SZAD overlay: only drawn on locked (default) boosters.
      locked: v.locked === true,
    });
    pctx.restore();
    
    // SZAD overlay — drawn AFTER drawRocketArt, so the ctx is back in clean
    // CSS-pixel space (setTransform(dpr,0,0,dpr,0,0)), no off-canvas base
    // translate active. Only for locked (default) boosters.
    if (v.locked === true && v.stageRole === 'booster') {
      const solidColor = (v.bodyDesign && v.bodyDesign.solidColor) || '#e9edf2';
      _drawSzadAtAnchor(pctx, baseX, baseY, W, H, solidColor);
    }
    }

// ---------------------------------------------------------------------------
// Stack preview — draws all members (bottom→top) stacked vertically on a
// single canvas, at one shared scale. Used by home page ("current stack"
// card) and rocket detail views.
// ---------------------------------------------------------------------------
function renderStackPreview(canvas, memberIds, fleet) {
  if (!canvas) return;
  fleet = fleet || (typeof loadFleet === 'function' ? loadFleet() : []);
  const members = (memberIds || [])
    .map(id => fleet.find(r => r.id === id))
    .filter(Boolean);
  
  const pctx = canvas.getContext('2d');
  const cssW = canvas.clientWidth || canvas.width;
  if (!cssW) return;
  
  if (!members.length) {
    canvas.style.height = '160px';
    const dpr0 = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr0);
    canvas.height = Math.round(160 * dpr0);
    pctx.setTransform(dpr0, 0, 0, dpr0, 0, 0);
    pctx.clearRect(0, 0, cssW, 160);
    pctx.fillStyle = 'rgba(107,125,156,0.5)';
    pctx.font = '12px "JetBrains Mono", monospace';
    pctx.textAlign = 'center';
    pctx.fillText('(empty stack)', cssW / 2, 84);
    return;
  }
  
    const widest = Math.max(...members.map(m => m.width || 1));
  
  // Total stack height in METERS — bell exit to nose tip. Uses the same
  // memberStackContribution helper fleet.js's stackCombinedAggregates
  // does, so the rendered canvas and the reported stack height agree.
  let contentH_m = 0;
  members.forEach((m, i) => {
    contentH_m += memberStackContribution(m, members[i - 1] || null, members[i + 1] || null);
  });
  if (contentH_m <= 0) contentH_m = 1;
  
  const MAX_DRAWN_H_PX = 520;
  const maxW_px = cssW * 0.50;
  const mppW = widest / maxW_px;
  const mppH = contentH_m / MAX_DRAWN_H_PX;
  const mpp = Math.max(mppW, mppH);
  const contentH_px = contentH_m / mpp;
  const vMarginFrac = 0.94;
  const cssH = contentH_px / vMarginFrac;
  canvas.style.height = cssH + 'px';
  
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, cssW, cssH);
  
  const baseX = cssW / 2;
  // Ground plane (bell exit) sits at the bottom of content, above the
  // bottom margin.
  const groundY = (cssH + contentH_px) / 2;
  
  // Cumulative height from ground, in px. Members stack bottom-up; each
  // member's hull base is placed at the running cumulative value, and
  // the cumulative advances by that member's own contribution.
  let cumPx = 0;
  members.forEach((m, idx) => {
    const role = m.stageRole;
    const Hpx = (m.height || 0) / mpp;
    const W = (m.width || 1) / mpp;
    
    // Base y-position of this member's hull, in px above ground.
    let baseAboveGround_px;
    if (role === 'booster' || role === 'rocket') {
      const bellHpx = (typeof engineBellHeightForRecord === 'function') ?
        engineBellHeightForRecord(m) / mpp : 0;
      baseAboveGround_px = cumPx + bellHpx;
      cumPx += bellHpx + Hpx;
    } else if (role === 'payloadSpace') {
      const overlapPx = (Number.isFinite(m.stageOverlapM) ? m.stageOverlapM : 0) / mpp;
      baseAboveGround_px = cumPx - overlapPx;
      cumPx += Hpx - overlapPx;
    } else {
      // interstage, stage, nose — base at previous top.
      baseAboveGround_px = cumPx;
      cumPx += Hpx;
    }
    
    const baseY = groundY - baseAboveGround_px;
    
    const recoveryType = (m.hasRecovery === false) ? null :
      ((m.recoveryTypeId && typeof getComponentType === 'function') ?
        getComponentType(m.recoveryTypeId) : null);
    const rcsType = (m.rcsTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.rcsTypeId) : null;
    const engineLayout = (m.engineTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.engineTypeId) : null;
    
    const psType = (m.stageRole === 'payloadSpace' && m.payloadSpaceTypeId && typeof getComponentType === 'function') ?
      getComponentType(m.payloadSpaceTypeId) : null;
    const psParams = m.params || {};
    const payloadOpts = (m.stageRole === 'payloadSpace') ? {
      payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
      payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
      payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
      payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
      payloadColor: m.color || '#e9edf2',
    } : {};
    
    pctx.save();
    pctx.translate(baseX, baseY);
    drawRocketArt(pctx, W, Hpx, mpp, {
      rcsTopY: m.params ? m.params.rcsTopY : undefined,
      rcsBottomY: m.params ? m.params.rcsBottomY : undefined,
      recoveryType,
      rcsType,
      stageRole: m.stageRole,
      noseCurveness: m.noseCurveness,
      bodyDesign: m.bodyDesign,
      payloadSpaceColor: (m.payloadSpace && m.payloadSpace.color) ? m.payloadSpace.color : undefined,
      stagePayload: (typeof buildStagePayload === 'function') ? buildStagePayload(m) : null,
      engineLayout: engineLayout,
      engineThrusters: m.engineThrusters,
      params: m.params,
      hasMemberBelow: idx > 0,
      gridFinType: (m.hasGridFins && m.gridFinTypeId && typeof getComponentType === 'function') ?
        getComponentType(m.gridFinTypeId) : null,
      gridFinParams: m.gridFinParams || null,
      gridFinColor: m.gridFinColor || '#8a9198',
      locked: m.locked === true,
      ...payloadOpts,
    });
    pctx.restore();
    
    if (m.locked === true && m.stageRole === 'booster') {
      const solidColor = (m.bodyDesign && m.bodyDesign.solidColor) || '#e9edf2';
      _drawSzadAtAnchor(pctx, baseX, baseY, W, Hpx, solidColor);
    }
  });
  }
  