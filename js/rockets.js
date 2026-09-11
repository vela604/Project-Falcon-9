// ============================================================================
// rockets.js — Vehicle Fleet page. All persistence goes through fleet.js
// (localStorage). No page reload needed for CRUD — just re-render.
//
// PHASE 2 STEP F: the three hardware-type dropdowns (engine layout,
// recovery mechanism, RCS arrangement) and every parameter field under them
// are driven entirely by the Components Library registry
// (componentLibrary.js) — this file never hardcodes a field for a specific
// type. See TYPE_SLOTS / populateTypeSelects() / renderParamFields() below.
// Only the truly universal fields (height/width/mass/dragCd, which don't
// belong to any one component type) stay in the old-style FIELD_MAP.
// ============================================================================

const FIELD_MAP = [
  { id: 'f-height', key: 'height' },
  { id: 'f-width', key: 'width' },
  { id: 'f-dryMass', key: 'dryMass' },
  { id: 'f-fuelMassMax', key: 'fuelMassMax' },
  { id: 'f-dragCd', key: 'dragCd' },
];

// One entry per hardware-type slot a rocket record references. `gridId`/
// `legendId` are the auto-generated-fields container and its legend-note
// span in the EDITOR form (rockets.html); `recordKey` is the fleet record
// field that stores the selected type's id.
const TYPE_SLOTS = [
  { category: 'engineLayout', selectId: 'f-engineType', gridId: 'engineParamsGrid', legendId: 'engineParamsNote', recordKey: 'engineTypeId' },
  { category: 'recoveryMechanism', selectId: 'f-recoveryType', gridId: 'recoveryParamsGrid', legendId: 'recoveryParamsNote', recordKey: 'recoveryTypeId' },
  { category: 'rcsArrangement', selectId: 'f-rcsType', gridId: 'rcsParamsGrid', legendId: 'rcsParamsNote', recordKey: 'rcsTypeId' },
];

let editingId = null; // set only while the edit FORM is open
let viewingId = null; // set only while the read-only detail panel is open

function fmtMass(kg) { return (kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' t'; }
function fmtForce(n) { return (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' kN'; }

// Generic formatter for a schema-declared parameter value, keyed off the
// schema's OWN unit string rather than the parameter's name — so it works
// for any key any type ever declares, not just the built-in ones.
function fmtParamValue(p, value) {
  if (!Number.isFinite(value)) return '—';
  switch (p.unit) {
    case 'N': return value >= 10000 ? fmtForce(value) : Math.round(value).toLocaleString() + ' N';
    case 'frac': return Math.round(value * 100) + '%';
    case 'deg': return '±' + value + '°';
    case 'm/s': return value.toLocaleString() + ' m/s';
    default: return value + (p.unit ? ' ' + p.unit : '');
  }
}

// A small adapter for renderVehiclePreview()/drawRocketArt(): the two
// margin fields are still flat top-level (matching drawRocketArt()'s opts
// shape) rather than nested under `params`, and STEP G added
// recoveryTypeId/rcsTypeId so the preview draws THIS record's own hardware
// (legs vs. catch-fitting, pod count) instead of whatever's globally active.
function previewVehicleFor(record) {
  return {
    height: record.height,
    width: record.width,
    rcsTopMargin: record.params ? record.params.rcsTopMargin : undefined,
    rcsBottomMargin: record.params ? record.params.rcsBottomMargin : undefined,
    recoveryTypeId: record.recoveryTypeId,
    rcsTypeId: record.rcsTypeId,
  };
}

// Guards the preview draw call so a missing/failed rocketArt.js load (wrong
// folder, blocked request, etc.) can't throw and take the rest of the
// editor's update logic down with it.
function safeRenderPreview(canvas, vehicle) {
  if (typeof renderVehiclePreview !== 'function') {
    console.warn('renderVehiclePreview() is not defined — check that js/simJs/rocketArt.js ' +
      'is present at that exact path (js/simJs/, not js/) and loads before this script.');
    return;
  }
  try { renderVehiclePreview(canvas, vehicle); }
  catch (e) { console.error('Vehicle preview render failed:', e); }
}

// ---------------------------------------------------------------------------
// Hardware-type dropdowns + auto-generated parameter fields (editor form)
// ---------------------------------------------------------------------------

// Fills the three <select> elements from the Components Library registry.
// Run once at bootstrap — the registry itself doesn't change while this
// page is open (custom-type authoring lives on the Components Library page).
function populateTypeSelects() {
  TYPE_SLOTS.forEach(slot => {
    const select = document.getElementById(slot.selectId);
    const types = getComponentsByCategory(slot.category);
    select.innerHTML = types.map(t => `<option value="${t.id}">${escapeHtml(t.displayName)}</option>`).join('');
  });
}

// No step is declared in a type's parameterSchema (Components Library only
// ever declares key/label/unit/min/max — see componentLibrary.js's design
// rule), so this infers a sensible one from the unit/min instead of the
// editor needing a hardcoded step per field name.
function inferParamStep(p) {
  if (p.unit === 'frac') return 0.01;
  if (p.min !== undefined && p.min > 0 && p.min < 1) return 0.01;
  if (p.min !== undefined && p.min >= 1000) return Math.max(1, Math.round(p.min / 100));
  return 1;
}

function renderParamFieldsHTML(schema, values) {
  if (!schema || !schema.length) return '<div class="legend-note">No parameters declared for this type.</div>';
  return schema.map(p => {
    const val = (values && Number.isFinite(values[p.key])) ? values[p.key] : (p.min !== undefined ? p.min : '');
    const minAttr = p.min !== undefined ? ` min="${p.min}"` : '';
    const maxAttr = p.max !== undefined ? ` max="${p.max}"` : '';
    return `<div class="field">
      <label for="param-${p.key}">${escapeHtml(p.label)}</label>
      <div class="input-unit">
        <input type="number" id="param-${p.key}" data-param-key="${p.key}"${minAttr}${maxAttr} step="${inferParamStep(p)}" value="${val}" required>
        <span>${escapeHtml(p.unit || '')}</span>
      </div>
    </div>`;
  }).join('');
}

// Regenerates one slot's field-grid for whichever type id is now selected,
// pre-filling any key that already has a value (so switching between two
// types of the same `kind`/shared keys doesn't lose what was typed) and
// falling back to the schema's own `min` for anything new.
function renderParamFields(slot, typeId, currentValues) {
  const type = getComponentType(typeId);
  const grid = document.getElementById(slot.gridId);
  const note = document.getElementById(slot.legendId);
  if (!type) { grid.innerHTML = ''; if (note) note.textContent = '—'; return; }
  if (note) note.textContent = '— ' + type.displayName;
  // No per-input listener needed here — the editor <form>'s own 'input'
  // listener (bound once at bootstrap) picks these up via event bubbling,
  // same as every other field.
  grid.innerHTML = renderParamFieldsHTML(type.parameterSchema, currentValues || {});
}

function renderAllParamFields(record) {
  TYPE_SLOTS.forEach(slot => renderParamFields(slot, record[slot.recordKey], record.params));
}

// Reads every currently-rendered param-* input into a flat {key: value} bag
// — used both by readFormData() (see below) and to carry values forward
// when a dropdown switches to a different type mid-edit.
function currentParamValues() {
  const values = {};
  document.querySelectorAll('[data-param-key]').forEach(el => {
    values[el.dataset.paramKey] = parseFloat(el.value);
  });
  return values;
}

// ---------------------------------------------------------------------------
// Fleet list
// ---------------------------------------------------------------------------
function renderFleetList() {
  const host = document.getElementById('fleetList');
  const fleet = loadFleet();
  const selectedId = getSelectedId();
  host.innerHTML = '';

  fleet.forEach(r => {
    const caps = rocketCapabilities(r);
    const row = document.createElement('div');
    row.className = 'fleet-row' + ((r.id === editingId || r.id === viewingId) ? ' active' : '');
    row.innerHTML = `
      <div class="fleet-row-top">
        <span class="fleet-row-name">${escapeHtml(r.name)}</span>
        ${r.id === selectedId ? '<span class="badge badge-flying">FLYING</span>' : ''}
        ${r.locked ? '<span class="badge badge-locked">DEFAULT</span>' : ''}
      </div>
      <div class="fleet-row-specs">
        <span>${r.height} m</span>
        <span class="accent">${fmtForce(caps.totalMaxThrust)}</span>
        <span>TWR ${caps.twrMax.toFixed(2)}</span>
        <span>Δv ${caps.deltaV.toFixed(0)} m/s</span>
      </div>
      <div class="fleet-row-actions">
        <button class="btn" data-act="fly" data-id="${r.id}" ${r.id === selectedId ? 'disabled' : ''}>Fly this</button>
        <button class="btn" data-act="edit" data-id="${r.id}">Edit</button>
        <button class="btn" data-act="dup" data-id="${r.id}">Duplicate</button>
        <button class="btn btn-danger" data-act="del" data-id="${r.id}" ${r.locked ? 'disabled' : ''}>Delete</button>
      </div>
    `;
    host.appendChild(row);
  });

  host.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'fly') { setSelectedId(id); showVehicleDetail(id); }
      if (act === 'edit') openEditorFor(id);
      if (act === 'dup') duplicateRocket(id);
      if (act === 'del') deleteRocketFlow(id);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fills one of the read-only detail panel's three type-driven sections
// (engine/recovery/rcs) from a RESOLVED type object + this record's params
// — never from a hardcoded field list, so any type in the registry (built-
// in or user-added on the Components Library page) displays correctly.
function renderDetailSection(prefix, type, params, extraNote) {
  const listEl = document.getElementById('d-' + prefix + 'List');
  const noteEl = document.getElementById('d-' + prefix + 'Note');
  if (!type) { listEl.innerHTML = ''; if (noteEl) noteEl.textContent = '—'; return; }
  if (noteEl) noteEl.textContent = '— ' + type.displayName + (extraNote ? ' ' + extraNote : '');
  const schema = type.parameterSchema || [];
  listEl.innerHTML = schema.length
    ? schema.map(p => `<div class="cap-row"><dt>${escapeHtml(p.label)}</dt><dd>${fmtParamValue(p, params ? params[p.key] : undefined)}</dd></div>`).join('')
    : '<div class="cap-row"><dt>—</dt><dd>No parameters declared.</dd></div>';
}

// ---------------------------------------------------------------------------
// Read-only detail panel — "Fly this" opens this instead of the edit form:
// figure + every spec, laid out flex (figure | grouped spec lists), same
// idea as the home page's vehicle card. "Edit" (here or in the fleet row)
// still goes to the actual editable form.
// ---------------------------------------------------------------------------
function showVehicleDetail(id) {
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r) return;
  viewingId = id;
  editingId = null;

  const set = (elId, val) => document.getElementById(elId).textContent = val;

  document.getElementById('detailTitle').textContent = r.name;
  document.getElementById('detailFlying').style.display = (r.id === getSelectedId()) ? '' : 'none';

  set('d-height', r.height + ' m');
  set('d-width', r.width + ' m');
  set('d-dryMass', fmtMass(r.dryMass));
  set('d-fuelMassMax', fmtMass(r.fuelMassMax));
  set('d-dragCd', r.dragCd);

  const engineType = getComponentType(r.engineTypeId);
  renderDetailSection('engine', engineType, r.params, engineType ? `(${engineType.frame.slots.length} engines)` : '');
  renderDetailSection('recovery', getComponentType(r.recoveryTypeId), r.params);
  renderDetailSection('rcs', getComponentType(r.rcsTypeId), r.params);

  const caps = rocketCapabilities(r);
  set('d-c-thrust', fmtForce(caps.totalMaxThrust));
  set('d-c-wet', fmtMass(caps.wetMass));
  set('d-c-twr', caps.twrMax.toFixed(2));
  set('d-c-dv', caps.deltaV.toFixed(0) + ' m/s');
  set('d-c-burn', caps.burnTimeS.toFixed(0) + ' s');

  safeRenderPreview(document.getElementById('detailPreviewCanvas'), previewVehicleFor(r));

  document.getElementById('editorEmpty').classList.add('hide');
  document.getElementById('editorForm').classList.remove('show');
  document.getElementById('vehicleDetail').classList.add('show');

  renderFleetList();
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function openEditorFor(id) {
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r) return;
  editingId = id;
  viewingId = null;
  fillForm(r);
  document.getElementById('editorTitle').textContent = r.name;
  document.getElementById('btnDuplicate').style.display = '';
  document.getElementById('btnDelete').style.display = '';
  document.getElementById('btnDelete').disabled = !!r.locked;
  showEditor();
  updateCapsPreview();
  renderFleetList();
}

function openEditorNew() {
  editingId = null;
  viewingId = null;
  fillForm(defaultVehicleData());
  document.getElementById('f-name').value = 'New Vehicle';
  document.getElementById('editorTitle').textContent = 'New Vehicle';
  document.getElementById('btnDuplicate').style.display = 'none';
  document.getElementById('btnDelete').style.display = 'none';
  showEditor();
  updateCapsPreview();
  renderFleetList();
  document.getElementById('f-name').focus();
  document.getElementById('f-name').select();
}

function fillForm(r) {
  document.getElementById('f-name').value = r.name;
  FIELD_MAP.forEach(f => { document.getElementById(f.id).value = r[f.key]; });
  TYPE_SLOTS.forEach(slot => { document.getElementById(slot.selectId).value = r[slot.recordKey]; });
  renderAllParamFields(r);
  hideFormError();
}

function showEditor() {
  document.getElementById('vehicleDetail').classList.remove('show');
  document.getElementById('editorEmpty').classList.add('hide');
  document.getElementById('editorForm').classList.add('show');
}

function closeEditor() {
  editingId = null;
  viewingId = null;
  document.getElementById('editorForm').classList.remove('show');
  document.getElementById('vehicleDetail').classList.remove('show');
  document.getElementById('editorEmpty').classList.remove('hide');
  renderFleetList();
}

function readFormData() {
  const data = { name: document.getElementById('f-name').value.trim() || 'Unnamed Vehicle' };
  FIELD_MAP.forEach(f => { data[f.key] = parseFloat(document.getElementById(f.id).value); });
  TYPE_SLOTS.forEach(slot => { data[slot.recordKey] = document.getElementById(slot.selectId).value; });
  data.params = currentParamValues();
  return data;
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.classList.add('show');
}
function hideFormError() {
  document.getElementById('formError').classList.remove('show');
}

// ---------------------------------------------------------------------------
// Live capability preview — recomputed on every input change
// ---------------------------------------------------------------------------
function updateCapsPreview() {
  const data = readFormData();
  const universalOk = FIELD_MAP.every(f => Number.isFinite(data[f.key])) && data.dryMass > 0;
  const typesOk = TYPE_SLOTS.every(slot => !!data[slot.recordKey]);
  const paramsOk = Object.keys(data.params).length > 0 && Object.values(data.params).every(Number.isFinite);
  const valid = universalOk && typesOk && paramsOk && Number.isFinite(data.params.engineVe) && data.params.engineVe > 0;
  const set = (id, val) => document.getElementById(id).textContent = val;
  if (!valid) {
    ['c-thrust', 'c-wet', 'c-twr', 'c-dv', 'c-burn'].forEach(id => set(id, '—'));
    return;
  }
  const caps = rocketCapabilities(data);
  set('c-thrust', fmtForce(caps.totalMaxThrust));
  set('c-wet', fmtMass(caps.wetMass));
  set('c-twr', caps.twrMax.toFixed(2));
  set('c-dv', caps.deltaV.toFixed(0) + ' m/s');
  set('c-burn', caps.burnTimeS.toFixed(0) + ' s');

  // Real vehicle artwork for whatever's currently in the form — same
  // drawRocketArt() the flight simulator uses, drawn idle, showing THIS
  // form's own selected recovery/RCS types (see previewVehicleFor()).
  safeRenderPreview(document.getElementById('vehiclePreviewCanvas'), previewVehicleFor(data));
}

// ---------------------------------------------------------------------------
// Save / duplicate / delete
// ---------------------------------------------------------------------------
function handleSubmit(e) {
  e.preventDefault();
  const form = document.getElementById('editorForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const data = readFormData();
  if (data.fuelMassMax < 0) { showFormError('Propellant mass cannot be negative.'); return; }
  // engineFMinFrac (throttle floor) only exists on engine types that
  // declare it — checked by key presence, not hardcoded to one type's id,
  // so a future engine type without a throttle floor skips this check
  // rather than crashing on an undefined value.
  if (data.params.engineFMinFrac !== undefined && data.params.engineFMinFrac >= 1) {
    showFormError('Throttle floor must be less than 1 (100%).');
    return;
  }
  hideFormError();

  let saved;
  if (editingId) {
    saved = updateRocket(editingId, data);
  } else {
    saved = addRocket(data);
    editingId = saved.id;
  }

  document.getElementById('editorTitle').textContent = saved.name;
  document.getElementById('btnDuplicate').style.display = '';
  document.getElementById('btnDelete').style.display = '';
  document.getElementById('btnDelete').disabled = !!saved.locked;
  renderFleetList();
}

function duplicateRocket(id) {
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r) return;
  const { id: _drop, locked: _l, ...rest } = r;
  const copy = addRocket({ ...rest, name: r.name + ' (copy)' });
  openEditorFor(copy.id);
}

function deleteRocketFlow(id) {
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r || r.locked) return;
  if (!confirm(`Delete "${r.name}"? This can't be undone.`)) return;
  deleteRocket(id);
  if (editingId === id || viewingId === id) closeEditor();
  else renderFleetList();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  populateTypeSelects();
  renderFleetList();

  TYPE_SLOTS.forEach(slot => {
    document.getElementById(slot.selectId).addEventListener('change', (e) => {
      renderParamFields(slot, e.target.value, currentParamValues());
      updateCapsPreview();
    });
  });

  document.getElementById('btnNew').addEventListener('click', openEditorNew);
  document.getElementById('btnCancel').addEventListener('click', closeEditor);
  document.getElementById('btnDelete').addEventListener('click', () => editingId && deleteRocketFlow(editingId));
  document.getElementById('btnDuplicate').addEventListener('click', () => editingId && duplicateRocket(editingId));
  document.getElementById('btnDetailEdit').addEventListener('click', () => viewingId && openEditorFor(viewingId));
  document.getElementById('editorForm').addEventListener('submit', handleSubmit);
  document.getElementById('editorForm').addEventListener('input', updateCapsPreview);
});
