// ============================================================================
// customDesign.js — Body appearance DSL (Phase 4 Step P4-D1).
//
// Provides:
//   validateCustomDesignOps(ops) → { ok, error? }
//   drawCustomDesignOps(ctx, W, H, ops)
//   applyCylindricalOverlay(ctx, W)
//
// Normalized coordinate space (all op fields use these):
//   X: -0.5 (left edge) .. +0.5 (right edge)
//   Y:  0   (base)      ..  1   (top of the member's body)
//   Sizes (strokeWidth, r, size) are fractions of min(W, H).
//
// Ops (applied in order, last drawn on top):
//   rect   { x, y, w, h, fill?, stroke?, strokeWidth? }
//   circle { cx, cy, r, fill?, stroke?, strokeWidth? }
//   line   { x1, y1, x2, y2, stroke, strokeWidth? }
//   poly   { points: [[x,y],...], fill?, stroke?, strokeWidth? }
//   text   { x, y, text, size?, fill?, align? }
//
// After all ops are drawn, applyCylindricalOverlay() applies a subtle
// left-dark / center-light / right-darker gradient over the same region —
// the same one the default body uses — so the surface still reads as a
// curved cylinder regardless of what the user painted.
// ============================================================================

const CUSTOM_DESIGN_MAX_OPS = 200;
const CUSTOM_DESIGN_MAX_POINTS = 500;
const CUSTOM_DESIGN_MAX_TEXT = 40;

// Structural validation — reject malformed ops early so a bad paste can't
// blow up the render loop. Does NOT check colour validity (canvas handles
// invalid colours by ignoring the fill), just the shape/safety aspects.
function validateCustomDesignOps(ops) {
  if (!Array.isArray(ops)) return { ok: false, error: 'Design must be a JSON array of ops.' };
  if (ops.length > CUSTOM_DESIGN_MAX_OPS) {
    return { ok: false, error: `Too many ops (max ${CUSTOM_DESIGN_MAX_OPS}).` };
  }
  const allowed = ['rect', 'circle', 'line', 'poly', 'text'];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object') return { ok: false, error: `Op #${i + 1} must be an object.` };
    if (!allowed.includes(op.op)) {
      return { ok: false, error: `Op #${i + 1}: unknown op "${op.op}". Allowed: ${allowed.join(', ')}.` };
    }
    if (op.op === 'poly') {
      if (!Array.isArray(op.points)) return { ok: false, error: `Op #${i + 1}: poly needs a points array.` };
      if (op.points.length > CUSTOM_DESIGN_MAX_POINTS) return { ok: false, error: `Op #${i + 1}: poly has too many points.` };
      for (let j = 0; j < op.points.length; j++) {
        const p = op.points[j];
        if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          return { ok: false, error: `Op #${i + 1}: point #${j + 1} must be [x, y].` };
        }
      }
    }
    if (op.op === 'text') {
      const t = String(op.text || '');
      if (t.length > CUSTOM_DESIGN_MAX_TEXT) {
        return { ok: false, error: `Op #${i + 1}: text too long (max ${CUSTOM_DESIGN_MAX_TEXT} chars).` };
      }
    }
  }
  return { ok: true };
}

// Draws the ops. The caller (drawRocketArt) has already translated the
// canvas so (0, 0) is the member's base center, with +Y pointing DOWN
// (matching the rest of the drawing code) — so normalized Y is negated here.
function drawCustomDesignOps(ctx, W, H, ops) {
  if (!Array.isArray(ops) || !ops.length) return;
  const X = (nx) => nx * W;
  const Y = (ny) => -ny * H; // normalized Y up → canvas Y down
  const S = (s) => s * Math.min(W, H);
  
  ops.forEach(op => {
    if (!op || typeof op !== 'object') return;
    ctx.save();
    if (op.fill) ctx.fillStyle = op.fill;
    if (op.stroke) ctx.strokeStyle = op.stroke;
    ctx.lineWidth = (op.strokeWidth !== undefined) ? Math.max(0.5, S(op.strokeWidth)) : 1;
    
    switch (op.op) {
      case 'rect': {
        const x = X(op.x || 0);
        const yTop = Y((op.y || 0) + (op.h || 0)); // normalized-y + h  → visually higher
        const w = X(op.w || 0);
        const h = -Y(op.h || 0); // positive height in canvas pixels
        ctx.beginPath();
        ctx.rect(x, yTop, w, h);
        if (op.fill) ctx.fill();
        if (op.stroke) ctx.stroke();
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.arc(X(op.cx || 0), Y(op.cy || 0), S(op.r || 0.05), 0, Math.PI * 2);
        if (op.fill) ctx.fill();
        if (op.stroke) ctx.stroke();
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(X(op.x1 || 0), Y(op.y1 || 0));
        ctx.lineTo(X(op.x2 || 0), Y(op.y2 || 0));
        if (op.stroke) ctx.stroke();
        break;
      }
      case 'poly': {
        if (!Array.isArray(op.points) || !op.points.length) break;
        ctx.beginPath();
        op.points.forEach(([px, py], idx) => {
          if (idx === 0) ctx.moveTo(X(px), Y(py));
          else ctx.lineTo(X(px), Y(py));
        });
        ctx.closePath();
        if (op.fill) ctx.fill();
        if (op.stroke) ctx.stroke();
        break;
      }
      case 'text': {
        const sizePx = S(op.size || 0.10);
        ctx.font = `${sizePx}px "Space Grotesk", system-ui, sans-serif`;
        ctx.textAlign = op.align || 'center';
        ctx.textBaseline = 'middle';
        if (op.fill) ctx.fillText(String(op.text || ''), X(op.x || 0), Y(op.y || 0));
        break;
      }
    }
    ctx.restore();
  });
}

// The auto-cylindrical gradient — same values as the default body's own
// shading, so switching between modes doesn't change the underlying look.
// Caller must have built the body path and set it as the current path;
// this fills over it.
function applyCylindricalOverlay(ctx, W) {
  const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.14)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = g;
  ctx.fill();
}

// Convenience: parse a textarea's worth of DSL and validate in one call.
// Returns { ok, ops?, error? } — ops is the parsed array when ok.
function parseAndValidateDesign(jsonText) {
  const trimmed = (jsonText || '').trim();
  if (!trimmed) return { ok: true, ops: [] };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: 'JSON parse error: ' + e.message };
  }
  const v = validateCustomDesignOps(parsed);
  if (!v.ok) return v;
  return { ok: true, ops: parsed };
}