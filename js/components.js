// ============================================================================
// components.js — Renders the Technology Bay card grid from the component
// library registry (componentLibrary.js). Display logic here branches on a
// type's `kind` (a deliberate, generic sub-shape discriminator — exactly
// what the schema design calls for) to decide HOW to summarize its frame.
// It never branches on a type's `id`; a brand-new type of an existing kind
// renders correctly with zero changes to this file.
// ============================================================================

let activeCategory = 'engineLayout';

function frameSummaryHTML(type) {
  const f = type.frame;
  if (type.kind === 'ringWithCenter') {
    const outer = f.slots.filter(s => s.role === 'outer');
    const center = f.slots.find(s => s.role === 'center');
    const spacing = outer.length ? Math.round(360 / outer.length) : 0;
    return `
      <div><span class="fl">Slots:</span> ${f.slots.length} total —
        ${center ? '1 center' + (center.gimbalCapable ? ' (gimbal-capable)' : '') : 'no center'}
        + ${outer.length} ring @ ${spacing}° spacing</div>
      <div><span class="fl">Merge topology:</span>
        ${f.mergeTopology.symmetric.length} symmetric pair(s),
        ${f.mergeTopology.asymmetric.length} asymmetric pair(s)</div>`;
  }
  if (type.kind === 'legsOnVehicle') {
    const g = f.hingeGeometry(1); // evaluate formula at H=1 to show the multipliers
    const legVol = (typeof f.structuralVolume === 'function') ? f.structuralVolume(1, 0.1) : null;
    return `
    <div><span class="fl">Leg count:</span> ${f.legCount}</div>
    <div><span class="fl">Hinge height:</span> ${g.hingeY.toFixed(3)}×H</div>
    <div><span class="fl">Leg length:</span> ${g.legLength.toFixed(3)}×H</div>
    <div><span class="fl">Max sweep:</span> ${Math.round(g.maxSweepRad * 180 / Math.PI)}°</div>
    ${legVol !== null ? `<div><span class="fl">Leg structural volume:</span> ${legVol.toFixed(5)} m³ @ H=1,W=0.1 (formula)</div>` : ''}`;
  }
  if (type.kind === 'catchFittingOnVehicle') {
    const fits = f.fittingPositions(1);
    return `
      <div><span class="fl">Fittings:</span> ${fits.length}</div>
      <div><span class="fl">Heights:</span> ${fits.map(p => (p.y.toFixed(2) + '×H')).join(', ')}</div>`;
  }
  if (type.kind === 'cornerPods') {
    return `
      <div><span class="fl">Pods:</span> ${f.pods.map(p => p.id).join(', ')}</div>
      <div><span class="fl">Nozzles / pod:</span> ${f.nozzlesPerPod}</div>`;
  }
  if (type.kind === 'noseCapShape') {
    // Evaluate the volume formulas at a representative size (H=3, W=2) just
    // to show they're live/callable — build-time uses the real dimensions.
    return `
      <div><span class="fl">Structural volume:</span> ${f.structuralVolume(3, 2).toFixed(3)} m³ @ H=3,W=2 (formula)</div>
      <div><span class="fl">Internal volume:</span> ${f.internalVolume(3, 2).toFixed(3)} m³ @ H=3,W=2 (formula)</div>`;
  }
  if (type.kind === 'bulgedCapShape') {
    return `
      <div><span class="fl">Structural volume:</span> ${f.structuralVolume(4, 3, 4.5).toFixed(3)} m³ @ H=4,W=3,bulge=4.5 (formula)</div>
      <div><span class="fl">Internal volume:</span> ${f.internalVolume(4, 3, 4.5).toFixed(3)} m³ @ H=4,W=3,bulge=4.5 (formula)</div>`;
  }
  return '<div class="fl">(no frame summary defined for this kind)</div>';
}

// Renders a schema's fixed `value` (when present) in a human-friendly way.
// Only booleans need special-casing here — everything else (numbers) is
// already display-ready as-is.
function formatFixedValue(v) {
  return typeof v === 'boolean' ? (v ? 'yes' : 'no') : v;
}

function paramsTableHTML(schema) {
  if (!schema || !schema.length) return '<div class="tc-frame">No parameters declared.</div>';
  // A "Value" column only makes sense for schemas that actually carry fixed
  // values (Phase 3's thruster/rcsThruster/fuel/metal categories — see
  // componentLibrary.js's withFixedValues()). Every other category's
  // parameterSchema entries have no `.value` at all (they're fleet-editable,
  // not fixed), so this checks structurally rather than by category/id —
  // those tables keep rendering exactly as before, 3 columns, no change.
  const hasFixedValues = schema.some(p => p.value !== undefined);
  const rows = schema.map(p => {
    const range = (p.min !== undefined ? p.min : '') + (p.max !== undefined ? '–' + p.max : (p.min !== undefined ? '+' : ''));
    const valueCell = hasFixedValues ? `<td class="value">${p.value !== undefined ? formatFixedValue(p.value) : '—'}</td>` : '';
    return `<tr><td>${p.label}</td><td class="key">${p.key}</td><td class="range">${p.unit}${range ? ' · ' + range : ''}</td>${valueCell}</tr>`;
  }).join('');
  const valueHeader = hasFixedValues ? '<th>Value</th>' : '';
  return `<table class="tc-params"><thead><tr><th>Label</th><th>Key</th><th>Unit / range</th>${valueHeader}</tr></thead><tbody>${rows}</tbody></table>`;
}

function capsHTML(caps) {
  if (!caps) return '';
  return Object.keys(caps).map(k => {
    const on = !!caps[k];
    return `<span class="cap-chip ${on ? 'on' : 'off'}">${k}: ${on ? 'yes' : 'no'}</span>`;
  }).join('');
}

function renderTypeCard(type) {
  // Frame and capabilities are both OPTIONAL at the schema level — the four
  // pure performance/material categories (thruster, rcsThruster, fuel,
  // metal) declare neither (see componentLibrary.js's Step A comment: they
  // aren't placed/shaped in space themselves). This checks structurally
  // (does the data exist), never by category/id/kind name, so a future
  // category that also skips frame or capabilities needs no changes here.
  const frameSection = type.frame ? `
      <div class="tc-section-label">Frame</div>
      <div class="tc-frame">${frameSummaryHTML(type)}</div>` : '';
  const capsSection = type.capabilities ? `
      <div class="tc-section-label">Capabilities</div>
      <div class="tc-caps">${capsHTML(type.capabilities)}</div>` : '';
  return `
    <div class="type-card">
      <div class="tc-head">
        <div>
          <div class="tc-name">${type.displayName}</div>
          <div class="tc-id">${type.id}</div>
        </div>
        <span class="tc-kind">${type.kind}</span>
      </div>
      <p class="tc-desc">${type.description || ''}</p>
      ${frameSection}
      <div class="tc-section-label">Parameter schema</div>
      ${paramsTableHTML(type.parameterSchema)}
      ${capsSection}
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById('cardGrid');
  const types = getComponentsByCategory(activeCategory);
  grid.innerHTML = types.length ?
    types.map(renderTypeCard).join('') :
    '<div class="tc-desc">No types defined in this category yet.</div>';
}

document.querySelectorAll('.cat-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCategory = btn.dataset.cat;
    renderGrid();
  });
});

renderGrid();