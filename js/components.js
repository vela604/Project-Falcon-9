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
    return `
      <div><span class="fl">Leg count:</span> ${f.legCount}</div>
      <div><span class="fl">Hinge height:</span> ${g.hingeY.toFixed(3)}×H</div>
      <div><span class="fl">Leg length:</span> ${g.legLength.toFixed(3)}×H</div>
      <div><span class="fl">Max sweep:</span> ${Math.round(g.maxSweepRad * 180 / Math.PI)}°</div>`;
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
  return '<div class="fl">(no frame summary defined for this kind)</div>';
}

function paramsTableHTML(schema) {
  if (!schema || !schema.length) return '<div class="tc-frame">No parameters declared.</div>';
  const rows = schema.map(p => {
    const range = (p.min !== undefined ? p.min : '') + (p.max !== undefined ? '–' + p.max : (p.min !== undefined ? '+' : ''));
    return `<tr><td>${p.label}</td><td class="key">${p.key}</td><td class="range">${p.unit}${range ? ' · ' + range : ''}</td></tr>`;
  }).join('');
  return `<table class="tc-params"><thead><tr><th>Label</th><th>Key</th><th>Unit / range</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function capsHTML(caps) {
  if (!caps) return '';
  return Object.keys(caps).map(k => {
    const on = !!caps[k];
    return `<span class="cap-chip ${on ? 'on' : 'off'}">${k}: ${on ? 'yes' : 'no'}</span>`;
  }).join('');
}

function renderTypeCard(type) {
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
      <div class="tc-section-label">Frame</div>
      <div class="tc-frame">${frameSummaryHTML(type)}</div>
      <div class="tc-section-label">Parameter schema</div>
      ${paramsTableHTML(type.parameterSchema)}
      <div class="tc-section-label">Capabilities</div>
      <div class="tc-caps">${capsHTML(type.capabilities)}</div>
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById('cardGrid');
  const types = getComponentsByCategory(activeCategory);
  grid.innerHTML = types.length
    ? types.map(renderTypeCard).join('')
    : '<div class="tc-desc">No types defined in this category yet.</div>';
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
