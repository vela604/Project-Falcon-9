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

let editingRole = 'rocket';
let editingStackId = null; 
let viewingStackId = null;      // set while the read-only detail panel is open// null = new stack, id = editing existing
let workingStackMembers = [];   // array of fleet-record ids, bottom→top
let editingId = null;// set only while the edit FORM is open


let viewingId = null; // set only while the read-only detail panel is open
// Phase 4 (P4-B1): set only while creating the FIRST member of a brand-new
// family — the record being created gets this familyId assigned, and (if
// it's a booster/rocket) becomes that family's bottomId. Reset on Cancel
// or after save.
let creatingInFamilyId = null;
// Phase 4 (P4-B2): set only while the read-only family detail pane is open.
let viewingFamilyId = null;


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
  const engineLayout = (record.engineTypeId && typeof getComponentType === 'function') ?
    getComponentType(record.engineTypeId) : null;
  return {
    height: record.height,
    width: record.width,
    rcsTopY: record.params ? record.params.rcsTopY : undefined,
    rcsBottomY: record.params ? record.params.rcsBottomY : undefined,
    recoveryTypeId: record.hasRecovery === false ? null : record.recoveryTypeId,
    rcsTypeId: record.rcsTypeId,
    stageRole: record.stageRole,
    noseCurveness: record.noseCurveness,
    bodyDesign: record.bodyDesign,
    payloadSpaceColor: (record.payloadSpace && record.payloadSpace.color) ? record.payloadSpace.color : undefined,
    stagePayload: (typeof buildStagePayload === 'function') ? buildStagePayload(record) : null,
    engineLayout: engineLayout,
    engineThrusters: record.engineThrusters,
    params: record.params,
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
  // Stage-only sub-selects (Phase 3 Step E1).
  [['f-fuelType', 'fuel'], ['f-bodyMetalType', 'metal'],
   ['f-payloadSpaceType', 'payloadSpace'], ['f-payloadSpaceMetalType', 'metal']
  ].forEach(([id, cat]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const types = getComponentsByCategory(cat);
    el.innerHTML = types.map(t => `<option value="${t.id}">${escapeHtml(t.displayName)}</option>`).join('');
  });
}

function applyRecoveryVisibility(role) {
  const allowedRoles = ['rocket', 'booster', 'stage'];
  const cb = document.getElementById('f-hasRecovery');
  const sel = document.getElementById('f-recoveryType');
  const paramsBox = document.getElementById('recoveryParamsFieldset');
  if (!cb || !sel) return;
  
  const roleAllows = allowedRoles.includes(role);
  const on = roleAllows && cb.checked;
  
  const cbWrap = cb.closest('label');
  if (cbWrap) cbWrap.style.display = roleAllows ? '' : 'none';
  
  sel.style.display = on ? '' : 'none';
  sel.disabled = !on;
  
  // Only ENFORCE the OFF state here — when ON, leave display alone so
  // applyRoleVisibility's role-matrix decision wins.
  if (paramsBox && !on) {
    paramsBox.style.display = 'none';
    paramsBox.querySelectorAll('input, select, textarea').forEach(inp => { inp.disabled = true; });
  }
}

// P4-D2: Body-appearance fieldset sub-state. Role restricts whether DSL is
// available (stage/nose are solid-colour-only), and mode selects which
// sub-field is shown.
function applyBodyDesignVisibility(role) {
  const select = document.getElementById('f-bodyDesignMode');
  if (!select) return;

  // DSL is booster/rocket-only. Disable the option; if it was selected,
  // fall back to solid.
  const dslOption = select.querySelector('option[value="dsl"]');
  const dslAllowed = (role === 'booster' || role === 'rocket');
  if (dslOption) dslOption.disabled = !dslAllowed;
  if (!dslAllowed && select.value === 'dsl') select.value = 'solid';

  const mode = select.value;
  const solidField = document.getElementById('bodySolidColorField');
  const dslField = document.getElementById('bodyDslField');
  if (solidField) solidField.style.display = (mode === 'solid') ? '' : 'none';
  if (dslField) dslField.style.display = (mode === 'dsl') ? '' : 'none';
}

function validateBodyDslInput() {
  const ta = document.getElementById('f-bodyDslText');
  const err = document.getElementById('bodyDslError');
  if (!ta || !err) return { ok: true };
  const v = parseAndValidateDesign(ta.value);
  if (!v.ok) {
    err.textContent = v.error;
    err.style.display = 'block';
    return { ok: false, error: v.error };
  }
  err.style.display = 'none';
  return { ok: true, ops: v.ops };
}


// Role picker (Phase 3 Step E1).
const rolePicker = document.getElementById('rolePicker');
// Phase 4 (P4-B1): "+ New Family" prompts for a name, creates an empty
// family, then opens the role picker restricted to its mandatory first
// member — a booster. (Stage/nose additions to existing families land in
// P4-B3.)
function showRolePicker(allowedRoles) {
  document.querySelectorAll('#rolePicker .role-option').forEach(btn => {
    btn.style.display = allowedRoles.includes(btn.dataset.role) ? '' : 'none';
  });
  rolePicker.classList.add('show');
}

document.getElementById('btnNew').addEventListener('click', () => {
  const name = prompt('Family name:', 'New Family');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const fam = addFamily({ name: trimmed });
  creatingInFamilyId = fam.id;
  renderFleetList();
  showRolePicker(['booster']);
});
document.getElementById('rolePickerCancel').addEventListener('click', () => rolePicker.classList.remove('show'));
rolePicker.addEventListener('click', (e) => { if (e.target === rolePicker) rolePicker.classList.remove('show'); });
document.querySelectorAll('.role-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const role = btn.dataset.role;
    rolePicker.classList.remove('show');
    // creatingInFamilyId stays set — handleSubmit will attach the new
    // record to that family and, if it's the booster, make it the bottomId.
    openEditorNew(role);
  });
});

// Payload-space type change → re-render its params grid.
const pspaceSel = document.getElementById('f-payloadSpaceType');
if (pspaceSel) {
  pspaceSel.addEventListener('change', (e) => {
    renderPayloadSpaceParams(e.target.value, currentParamValues('payload'));
  });
}

// Stage-specific inputs also trigger live capability preview (E2 will
// actually compute; E1 just keeps the handler wiring in place).
['f-fuelType','f-fuelTankHeight','f-fuelTankWidth','f-bodyMetalType',
 'f-payloadSpaceType','f-payloadSpaceMetalType','f-payloadSpaceDeployment',
 'f-maxExtraWeight'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateCapsPreview);
});



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

function renderParamFieldsHTML(schema, values, prefix) {
  prefix = prefix || 'param';
  if (!schema || !schema.length) return '<div class="legend-note">No parameters declared for this type.</div>';
  return schema.map(p => {
    const val = (values && Number.isFinite(values[p.key])) ? values[p.key] : (p.min !== undefined ? p.min : '');
    const minAttr = p.min !== undefined ? ` min="${p.min}"` : '';
    const maxAttr = p.max !== undefined ? ` max="${p.max}"` : '';
    return `<div class="field">
      <label for="${prefix}-${p.key}">${escapeHtml(p.label)}</label>
      <div class="input-unit">
        <input type="number" id="${prefix}-${p.key}" data-param-key="${p.key}" data-param-scope="${prefix}"${minAttr}${maxAttr} step="${inferParamStep(p)}" value="${val}" required>
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
  if (!grid) {
    console.warn(`renderParamFields: no element found for grid id "${slot.gridId}" ` +
      `(slot category "${slot.category}") — check that rockets.html still has that <div>.`);
    return;
  }
  if (!type) { grid.innerHTML = ''; if (note) note.textContent = '—'; return; }
  if (note) note.textContent = '— ' + type.displayName;
  grid.innerHTML = renderParamFieldsHTML(type.parameterSchema, currentValues || {});
}

function renderAllParamFields(record) {
  TYPE_SLOTS.forEach(slot => renderParamFields(slot, record[slot.recordKey], record.params));
}


// ---------------------------------------------------------------------------
// Thruster sub-slots (Phase 3 Step B).
//
// Engine: for each distinct `gimbalCapable` value the selected layout's
// slots contain (see engineThrusterGroups() in fleet.js), render one
// (thruster-type dropdown + mass-flow-rate input + derived readout) block.
// Octaweb → 2 blocks (gimbal / fixed). A layout with only one group → 1
// block. Zero layout-specific branches here.
//
// RCS: a single block (one thruster type + per-nozzle flow rate for all pods).
// ---------------------------------------------------------------------------

function renderEngineThrusters(engineTypeId, currentThrusters) {
  const mount = document.getElementById('engineThrustersMount');
  if (!mount) return;
  const engineType = getComponentType(engineTypeId);
  if (!engineType) { mount.innerHTML = ''; return; }
  const groups = engineThrusterGroups(engineType);
  const groupKeys = Object.keys(groups);
  if (!groupKeys.length) { mount.innerHTML = ''; return; }
  const thrusterTypes = getComponentsByCategory('thruster');
  if (!thrusterTypes.length) {
    mount.innerHTML = '<div class="legend-note">No thruster types in the Components Library yet.</div>';
    return;
  }
  const defaultTypeId = thrusterTypes[0].id;

  mount.innerHTML = groupKeys.map(gk => {
    const slots = groups[gk];
    const label = gk === 'gimbal'
      ? `Gimbal-capable group — ${slots.length} engine${slots.length === 1 ? '' : 's'}`
      : gk === 'fixed'
        ? `Fixed (non-gimbal) group — ${slots.length} engine${slots.length === 1 ? '' : 's'}`
        : `${gk} group — ${slots.length} engine${slots.length === 1 ? '' : 's'}`;
    const cur = (currentThrusters && currentThrusters[gk]) || {};
    const selId = (cur.thrusterTypeId && getComponentType(cur.thrusterTypeId)) ? cur.thrusterTypeId : defaultTypeId;
    const selType = getComponentType(selId);
    const maxFlow = selType ? selType.parameterSchema.find(p => p.key === 'maxMassFlowRate').value : 1;
    const flowVal = Number.isFinite(cur.massFlowRate) ? cur.massFlowRate : maxFlow;
    const opts = thrusterTypes.map(t =>
      `<option value="${t.id}"${t.id === selId ? ' selected' : ''}>${escapeHtml(t.displayName)}</option>`
    ).join('');
    return `
      <div class="thruster-group" data-group="${gk}" data-slot-count="${slots.length}">
        <div class="thruster-group-label">${escapeHtml(label)}</div>
        <div class="field-grid">
          <div class="field">
            <label>Thruster type</label>
            <select data-thruster-type="${gk}">${opts}</select>
          </div>
          <div class="field">
            <label>Mass flow rate</label>
            <div class="input-unit">
              <input type="number" min="0" step="0.1" data-thruster-flow="${gk}" value="${flowVal}">
              <span>kg/s</span>
            </div>
          </div>
        </div>
        <div class="thruster-derived" data-thruster-derived="${gk}">—</div>
      </div>`;
  }).join('');

  groupKeys.forEach(gk => updateEngineThrusterDerived(gk));
  mount.querySelectorAll('select[data-thruster-type], input[data-thruster-flow]').forEach(el => {
    const handler = () => {
      const gk = el.dataset.thrusterType || el.dataset.thrusterFlow;
      updateEngineThrusterDerived(gk);
      updateCapsPreview();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
}

function updateEngineThrusterDerived(groupKey) {
  const group = document.querySelector(`.thruster-group[data-group="${groupKey}"]`);
  if (!group) return;
  const count = parseInt(group.dataset.slotCount || '0', 10);
  const tId = group.querySelector(`select[data-thruster-type="${groupKey}"]`).value;
  const flow = parseFloat(group.querySelector(`input[data-thruster-flow="${groupKey}"]`).value);
  const out = group.querySelector(`[data-thruster-derived="${groupKey}"]`);
  const t = getComponentType(tId);
  if (!out) return;
  if (!t || !Number.isFinite(flow)) { out.innerHTML = '—'; return; }
  const valOf = (k) => { const e = t.parameterSchema.find(p => p.key === k); return e ? e.value : undefined; };
  const ve = valOf('ve'), maxFlow = valOf('maxMassFlowRate');
if (ve === undefined) { out.innerHTML = '—'; return; }
const perEngineF = flow * ve;
// Mass via thrust / (TWR × G0) — see engineMassFromThrust() in
// componentLibrary.js. `efficiency` stays in the schema for future use
// (e.g. an effective-Ve refinement) but is no longer consumed here.
const perEngineM = engineMassFromThrust(t, perEngineF);
const groupF = perEngineF * count;
const groupM = perEngineM * count;
  const over = (maxFlow !== undefined && flow > maxFlow);
  out.innerHTML =
    `Per engine: <b>${fmtForce(perEngineF)}</b> thrust · <b>${perEngineM.toFixed(0)} kg</b> mass` +
    (count > 1 ? ` &nbsp;|&nbsp; group (×${count}): <b>${fmtForce(groupF)}</b> · <b>${groupM.toFixed(0)} kg</b>` : '') +
    (over ? ` <span class="over">· over max flow (${maxFlow} kg/s)</span>` : '');
}

function renderRcsThruster(current) {
  const mount = document.getElementById('rcsThrusterMount');
  if (!mount) return;
  const thrusterTypes = getComponentsByCategory('rcsThruster');
  if (!thrusterTypes.length) {
    mount.innerHTML = '<div class="legend-note">No RCS thruster types in the Components Library yet.</div>';
    return;
  }
  const defaultTypeId = thrusterTypes[0].id;
  const cur = current || {};
  const selId = (cur.thrusterTypeId && getComponentType(cur.thrusterTypeId)) ? cur.thrusterTypeId : defaultTypeId;
  const selType = getComponentType(selId);
  const maxFlow = selType ? selType.parameterSchema.find(p => p.key === 'maxMassFlowRate').value : 0.5;
  const flowVal = Number.isFinite(cur.massFlowRate) ? cur.massFlowRate : maxFlow;
  const opts = thrusterTypes.map(t =>
    `<option value="${t.id}"${t.id === selId ? ' selected' : ''}>${escapeHtml(t.displayName)}</option>`
  ).join('');

  mount.innerHTML = `
    <div class="thruster-group" data-group="rcs">
      <div class="thruster-group-label">RCS thruster (all pods)</div>
      <div class="field-grid">
        <div class="field">
          <label>Thruster type</label>
          <select data-thruster-type="rcs">${opts}</select>
        </div>
        <div class="field">
          <label>Mass flow rate (per nozzle)</label>
          <div class="input-unit">
            <input type="number" min="0" step="0.05" data-thruster-flow="rcs" value="${flowVal}">
            <span>kg/s</span>
          </div>
        </div>
      </div>
      <div class="thruster-derived" data-thruster-derived="rcs">—</div>
    </div>`;

  updateRcsThrusterDerived();
  mount.querySelectorAll('select[data-thruster-type], input[data-thruster-flow]').forEach(el => {
    const handler = () => { updateRcsThrusterDerived(); updateCapsPreview(); };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
}


function renderPayloadSpaceParams(typeId, currentParams) {
  const grid = document.getElementById('payloadSpaceParamsGrid');
  if (!grid) return;
  const type = getComponentType(typeId);
  if (!type) { grid.innerHTML = ''; return; }
  grid.innerHTML = renderParamFieldsHTML(type.parameterSchema, currentParams || {}, 'payload');
}

function applyRoleVisibility(role) {
  // P4-B3: single source of truth for editor-form visibility. Uses element
  // IDs (not HTML data-roles) so it doesn't depend on which attributes
  // happened to make it into rockets.html.
  const MATRIX = {
    geometryFieldset: ['rocket', 'booster', 'stage', 'nose'],
    hardwareTypesFieldset: ['rocket', 'booster', 'stage'],
    engineParamsFieldset: ['rocket', 'booster', 'stage'],
    recoveryParamsFieldset: ['rocket', 'booster', 'stage'],
    rcsParamsFieldset: ['rocket', 'booster', 'stage'],
    stageFuelFieldset: ['booster', 'stage'],
    stageMetalFieldset: ['booster', 'stage', 'nose'],
    stagePayloadFieldset: ['stage'],
    noseShapeFieldset: ['nose'],
    aeroFieldset: ['rocket', 'booster', 'stage', 'nose'],
    extraWeightFieldset: ['booster', 'stage'],
    capsBox: ['rocket', 'booster'],
    stageCapsBox: ['stage'],
    massDryField: ['rocket'],
    massFuelField: ['rocket'],
    bodyDesignFieldset: ['rocket', 'booster', 'stage', 'nose'],
    payloadColorField: ['stage'],
  };
  
  function setVisible(el, show) {
    if (!el) return;
    el.style.display = show ? '' : 'none';
    el.querySelectorAll('input, select, textarea').forEach(inp => { inp.disabled = !show; });
  }
  
  Object.keys(MATRIX).forEach(id => {
    const el = document.getElementById(id);
    if (!el) {
      console.warn(`applyRoleVisibility: #${id} not found — check rockets.html`);
      return;
    }
    setVisible(el, MATRIX[id].includes(role));
  });
  
  // Recovery gate (Part C): checkbox off → hide dropdown + params even
  // for roles that support recovery.
  applyRecoveryVisibility(role);
  applyBodyDesignVisibility(role);
}


function updateRcsThrusterDerived() {
  const group = document.querySelector('.thruster-group[data-group="rcs"]');
  if (!group) return;
  const tId = group.querySelector('select[data-thruster-type="rcs"]').value;
  const flow = parseFloat(group.querySelector('input[data-thruster-flow="rcs"]').value);
  const out = group.querySelector('[data-thruster-derived="rcs"]');
  const t = getComponentType(tId);
  if (!out) return;
  if (!t || !Number.isFinite(flow)) { out.innerHTML = '—'; return; }
  const ve = t.parameterSchema.find(p => p.key === 've').value;
  const maxFlow = t.parameterSchema.find(p => p.key === 'maxMassFlowRate').value;
  const thrust = flow * ve;
  const over = (maxFlow !== undefined && flow > maxFlow);
  out.innerHTML =
    `Per-nozzle thrust: <b>${Math.round(thrust).toLocaleString()} N</b>` +
    (over ? ` <span class="over">· over max flow (${maxFlow} kg/s)</span>` : '');
}

// Readers — pull the currently-rendered thruster sub-slots back into the
// record shape. Return null when the mount is empty (no layout selected yet).
function readEngineThrusters() {
  const mount = document.getElementById('engineThrustersMount');
  if (!mount) return null;
  const out = {};
  mount.querySelectorAll('.thruster-group').forEach(g => {
    const gk = g.dataset.group;
    const tSel = g.querySelector(`select[data-thruster-type="${gk}"]`);
    const fInp = g.querySelector(`input[data-thruster-flow="${gk}"]`);
    if (!tSel || !fInp) return;
    out[gk] = { thrusterTypeId: tSel.value, massFlowRate: parseFloat(fInp.value) };
  });
  return Object.keys(out).length ? out : null;
}

function readRcsThruster() {
  const mount = document.getElementById('rcsThrusterMount');
  if (!mount) return null;
  const g = mount.querySelector('.thruster-group[data-group="rcs"]');
  if (!g) return null;
  return {
    thrusterTypeId: g.querySelector('select[data-thruster-type="rcs"]').value,
    massFlowRate: parseFloat(g.querySelector('input[data-thruster-flow="rcs"]').value),
  };
}






// Reads every currently-rendered param-* input into a flat {key: value} bag
// — used both by readFormData() (see below) and to carry values forward
// when a dropdown switches to a different type mid-edit.
function currentParamValues(scope) {
  const targetScope = scope || 'param';
  const values = {};
  document.querySelectorAll(`[data-param-key][data-param-scope="${targetScope}"]`).forEach(el => {
    values[el.dataset.paramKey] = parseFloat(el.value);
  });
  return values;
}

// ---------------------------------------------------------------------------
// Fleet list
// ---------------------------------------------------------------------------
// Role-aware spec summary — one line per record in the fleet list. Rocket
// and booster reuse the existing capability math; a stage needs its own
// derived numbers (fuel mass, max payload, wet mass) because its flat
// dryMass/fuelMassMax don't exist (see stageDerivedMasses() in fleet.js).
function fleetRowSpecsHTML(r) {
  if (r.stageRole === 'stage') {
    const d = stageDerivedMasses(r);
    if (!d || d.reason) return `<span class="accent">—</span>`;
    const maxP = d.infeasible
      ? '<span style="color:var(--danger)">INFEASIBLE</span>'
      : `payload ${fmtMass(d.maxPayloadMassKg)}`;
    return `
      <span>${r.height} m</span>
      <span class="accent">${fmtForce(d.totalEngineThrust)}</span>
      <span>fuel ${fmtMass(d.fuelMass)}</span>
      <span>${maxP}</span>
      <span>wet ${fmtMass(d.totalWetMassAtMaxPayload)}</span>`;
  }
  const caps = rocketCapabilities(r);
  const extraRow = (r.stageRole === 'booster')
    ? `<span>cap ${fmtMass(r.maxExtraWeightKg || 0)}</span>`
    : '';
  return `
    <span>${r.height} m</span>
    <span class="accent">${fmtForce(caps.totalMaxThrust)}</span>
    <span>TWR ${caps.twrMax.toFixed(2)}</span>
    <span>Δv ${caps.deltaV.toFixed(0)} m/s</span>
    ${extraRow}`;
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
  if (!listEl) return;
  if (!type) {
    listEl.innerHTML = '';
    if (noteEl) noteEl.textContent = '—';
    return;
  }
  if (noteEl) noteEl.textContent = '— ' + type.displayName + (extraNote ? ' ' + extraNote : '');
  const schema = type.parameterSchema || [];
  listEl.innerHTML = schema.length ?
    schema.map(p => `<div class="cap-row"><dt>${escapeHtml(p.label)}</dt><dd>${fmtParamValue(p, params ? params[p.key] : undefined)}</dd></div>`).join('') :
    '<div class="cap-row"><dt>—</dt><dd>No parameters declared.</dd></div>';
}

function renderFleetList() {
  const host = document.getElementById('fleetList');
  const fleet = loadFleet();
  const families = loadFamilies();
  const selectedId = getSelectedId();
  host.innerHTML = '';

  if (!fleet.length && !families.length) {
    host.innerHTML = '<p style="color:var(--dim);font-size:13px;">No families yet — click &quot;+ New Family&quot; to start.</p>';
    return;
  }

  // Bucket records by familyId. Anything without a family (shouldn't happen
  // post-migration, but defensive) lands in Unassigned.
  const byFamily = {};
  families.forEach(f => { byFamily[f.id] = []; });
  byFamily[UNASSIGNED_FAMILY_ID] = byFamily[UNASSIGNED_FAMILY_ID] || [];
  fleet.forEach(r => {
    const fid = r.familyId || UNASSIGNED_FAMILY_ID;
    if (!byFamily[fid]) byFamily[fid] = [];
    byFamily[fid].push(r);
  });

  // Family display order: real families first (locked Falcon-9 last of these),
  // then Unassigned if it has any records.
  const realFamilyIds = families
    .filter(f => f.id !== UNASSIGNED_FAMILY_ID)
    .sort((a, b) => (a.locked ? 1 : 0) - (b.locked ? 1 : 0))
    .map(f => f.id);
  const orderedIds = [...realFamilyIds];
  if ((byFamily[UNASSIGNED_FAMILY_ID] || []).length) orderedIds.push(UNASSIGNED_FAMILY_ID);

  orderedIds.forEach(fid => {
    const fam = getFamily(fid) || { id: fid, name: '(unknown family)', bottomId: null };
    const members = byFamily[fid] || [];
    const bottom = fam.bottomId ? fleet.find(r => r.id === fam.bottomId) : null;

    // Family header
    const header = document.createElement('div');
    header.className = 'family-header' + (fid === viewingFamilyId ? ' active' : '');
    const boosterLabel = bottom
      ? `base: ${escapeHtml(bottom.name)}`
      : '<span style="color:var(--amber)">no booster yet</span>';
    header.innerHTML = `
      <span class="family-header-name">${escapeHtml(fam.name)}</span>
      <span class="family-header-meta">${boosterLabel} · ${members.length} member${members.length === 1 ? '' : 's'}</span>
      <button type="button" class="btn" data-family-add="${fid}">+ Add Member</button>
    `;
    host.appendChild(header);

    // Family header itself is clickable → opens family detail.
header.style.cursor = 'pointer';
header.addEventListener('click', () => showFamilyDetail(fid));

// "+ Add Member" button inside the header — scoped add flow.
header.querySelector(`[data-family-add="${fid}"]`).addEventListener('click', (e) => {
  e.stopPropagation();
  openFamilyAddMember(fid);
});
    // Members — bottom first, then stages/noses.
    const wrap = document.createElement('div');
    wrap.className = 'family-member-indent';
    host.appendChild(wrap);

    const ordered = [];
    if (bottom) ordered.push(bottom);
    members.filter(r => !bottom || r.id !== bottom.id).forEach(r => ordered.push(r));

    if (!ordered.length) {
      const empty = document.createElement('div');
      empty.className = 'fleet-row';
      empty.style.opacity = '0.6';
      empty.innerHTML = `<div class="fleet-row-name" style="color:var(--dim);font-size:12.5px;">(empty — add the booster first)</div>`;
      wrap.appendChild(empty);
      return;
    }

    ordered.forEach(r => {
      const caps = r.stageRole === 'stage' ? null : rocketCapabilities(r);
      const row = document.createElement('div');
      row.className = 'fleet-row' + ((r.id === editingId || r.id === viewingId) ? ' active' : '');
      const role = r.stageRole || 'rocket';
      row.innerHTML = `
        <div class="fleet-row-top">
          <span class="badge badge-role ${role}">${role.toUpperCase()}</span>
          <span class="fleet-row-name">${escapeHtml(r.name)}</span>
          ${r.id === selectedId ? '<span class="badge badge-flying">FLYING</span>' : ''}
          ${r.locked ? '<span class="badge badge-locked">DEFAULT</span>' : ''}
        </div>
        <div class="fleet-row-specs">${fleetRowSpecsHTML(r)}</div>
        <div class="fleet-row-actions">
  <button class="btn" data-act="edit" data-id="${r.id}">Edit</button>
  <button class="btn" data-act="dup" data-id="${r.id}">Duplicate</button>
  <button class="btn btn-danger" data-act="del" data-id="${r.id}" ${r.locked ? 'disabled' : ''}>Delete</button>
</div>
      `;
      wrap.appendChild(row);
    });
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
  
  // Row click → view detail (Fly this removed from rows; stack flies now).
host.querySelectorAll('.family-member-indent .fleet-row').forEach(row => {
  row.style.cursor = 'pointer';
  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;  // ignore button clicks
    const id = row.querySelector('button[data-act="edit"]');
    if (id) showVehicleDetail(id.dataset.id);
  });
});
}

// ---------------------------------------------------------------------------
// Family detail pane (Phase 4 Step P4-B2).
// Read-only overview of a family: base member (booster/rocket) + stages/noses,
// each clickable to open that record's own detail/edit view.
// ---------------------------------------------------------------------------
function showFamilyDetail(familyId) {
  const fam = getFamily(familyId);
  if (!fam) return;
  viewingFamilyId = familyId;
  editingId = null;
  viewingId = null;

  const fleet = loadFleet();
  const bottom = fam.bottomId ? fleet.find(r => r.id === fam.bottomId) : null;
  const members = fleet.filter(r => r.familyId === familyId && (!bottom || r.id !== bottom.id));
  const hasBottom = !!bottom;

  document.getElementById('famDetailTitle').textContent = fam.name;

  // Base member.
  const baseEl = document.getElementById('famDetailBase');
  if (bottom) {
    const role = bottom.stageRole || 'rocket';
    baseEl.innerHTML = `
      <div class="fam-base-row">
        <span class="badge badge-role ${role}">${role.toUpperCase()}</span>
        <span class="role-name">${escapeHtml(bottom.name)}</span>
        <span class="role-specs">${fleetRowSpecsHTML(bottom)}</span>
        <button type="button" class="btn" data-fam-open="${bottom.id}">Open</button>
      </div>`;
  } else {
    baseEl.innerHTML = `<div class="fam-empty-hint">No booster yet — this family isn't flyable. Add one to begin.</div>`;
  }

  // Members list (stages + noses).
  const memEl = document.getElementById('famDetailMembers');
  if (members.length) {
    memEl.className = 'fam-member-list';
    memEl.innerHTML = members.map(r => {
      const role = r.stageRole || 'rocket';
      return `
        <div class="fam-member-row">
          <span class="badge badge-role ${role}">${role.toUpperCase()}</span>
          <span class="role-name">${escapeHtml(r.name)}</span>
          <span class="role-specs">${fleetRowSpecsHTML(r)}</span>
          <button type="button" class="btn" data-fam-open="${r.id}">Open</button>
        </div>`;
    }).join('');
  } else {
    memEl.className = '';
    memEl.innerHTML = `<div class="fam-empty-hint">No stages or noses yet.</div>`;
  }

  // "+ Add Member" enable/disable depends on role availability — stages and
  // noses are always addable; a booster only if this family doesn't have one.
  document.getElementById('btnFamilyAddMember').disabled = false;

  // Delete Family — only when empty (deleteFamily() enforces this too).
  const deletable = !fam.locked && !bottom && members.length === 0;
  const delBtn = document.getElementById('btnFamilyDelete');
  delBtn.disabled = !deletable;
  delBtn.title = fam.locked ? 'Default family is protected.' :
                 (bottom || members.length) ? 'Delete the family\'s members first.' : '';

  // Wire "Open" buttons.
  [baseEl, memEl].forEach(host => {
    host.querySelectorAll('[data-fam-open]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showVehicleDetail(btn.dataset.famOpen);
      });
    });
  });

  document.getElementById('editorEmpty').classList.add('hide');
  document.getElementById('editorForm').classList.remove('show');
  document.getElementById('vehicleDetail').classList.remove('show');
  document.getElementById('familyDetail').style.display = '';

  renderFleetList();
}

function hideFamilyDetail() {
  viewingFamilyId = null;
  document.getElementById('familyDetail').style.display = 'none';
}

// Family-scoped add-member flow. Role picker shows whichever roles this
// family can still accept: booster only if none present, stages/noses always.
// Selecting a role sets creatingInFamilyId and opens the create form; the
// existing handleSubmit() attaches the new record to that family.
function openFamilyAddMember(familyId) {
  const fam = getFamily(familyId);
  if (!fam) return;
  // P4-B3: use getFamilyBottom() — it resolves the id to a real record and
  // returns null if the referenced record is missing (deleted), so a stale
  // bottomId can't wrongly disable the "add booster" option.
  const hasBooster = !!getFamilyBottom(familyId);
  const allowed = hasBooster ? ['stage', 'nose'] : ['booster'];
  creatingInFamilyId = familyId;
  document.querySelectorAll('#rolePicker .role-option').forEach(btn => {
    btn.style.display = allowed.includes(btn.dataset.role) ? '' : 'none';
  });
  document.getElementById('rolePicker').classList.add('show');
}

// ---------------------------------------------------------------------------
// View tabs + stack list (Phase 3 Step G2a).
//
// Two views share #main's grid: Vehicles (existing) and Stacks (new). Each
// view owns its own left pane (list) and right pane (editor / detail).
// Only one view's pair of panes is visible at a time; display:none removes
// them from grid flow entirely, so the sibling pair auto-places correctly.
// ---------------------------------------------------------------------------

let activeView = 'fleet';

function setActiveView(view) {
  activeView = view;
  const fleetVisible = view === 'fleet';
  document.getElementById('fleetPane').style.display       = fleetVisible ? '' : 'none';
  document.getElementById('editorPane').style.display      = fleetVisible ? '' : 'none';
  document.getElementById('stackPane').style.display       = fleetVisible ? 'none' : '';
  document.getElementById('stackEditorPane').style.display = fleetVisible ? 'none' : '';
  document.querySelectorAll('#viewTabs .view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  if (!fleetVisible) renderStackList();
  if (!fleetVisible && editingStackId) openStackEditor(editingStackId);
}

function renderStackList() {
  const host = document.getElementById('stackList');
  if (!host) return;
  const stacks = loadStacks();
  const fleet = loadFleet();
  host.innerHTML = '';

  if (!stacks.length) return; // :empty::after shows placeholder

  stacks.forEach(s => {
    const v = validateStack(s.members, fleet);
    const names = s.members.map(id => {
      const r = fleet.find(x => x.id === id);
      return r ? r.name : '(missing)';
    });
    const chain = names.length ? names.join(' → ') : '(empty)';

    const row = document.createElement('div');
    row.className = 'fleet-row' + ((s.id === editingStackId || s.id === viewingStackId) ? ' active' : '');
    row.innerHTML = `
  <div class="fleet-row-top">
    <span class="fleet-row-name">${escapeHtml(s.name)}</span>
    <span class="stack-badge ${v.valid ? 'valid' : 'invalid'}">${v.valid ? 'VALID' : v.errors.length + ' ERR'}</span>
    ${s.id === getSelectedStackId() ? '<span class="badge badge-flying">FLYING</span>' : ''}
  </div>
  <div class="fleet-row-specs">
    <span>${s.members.length} member${s.members.length === 1 ? '' : 's'}</span>
    <span>height ${v.stackTotalHeight.toFixed(1)} m</span>
    <span>mass ${fmtMass(v.stackTotalMass)}</span>
  </div>
  <div class="stack-chain">${escapeHtml(chain)}</div>
`;
    host.appendChild(row);
    // G2b: rows become clickable — open editor for the matching stack.
wireStackRowClicks();
  });
}


// ---------------------------------------------------------------------------
// Stack detail view (Phase 3 Step G3).
//
// Read-only view of a stack: aggregate stats, member chain (top-first), live
// validation output, and a side-elevation preview canvas showing the entire
// stack as it physically stands. "Edit" switches to the editor.
//
// The preview draws each member via the shared drawRocketArt(), stacked
// bottom-up with their real height:width ratios preserved (single scale for
// the whole stack). Payload-space bulges and nose-cap silhouettes are NOT
// yet drawn on stage members — drawRocketArt() renders every member with
// the same rounded-nose body for now; a shape-per-kind refinement can come
// later without touching anything else here.
// ---------------------------------------------------------------------------
function openStackDetail(id) {
  const s = getStack(id);
  if (!s) return;
  viewingStackId = id;
  editingStackId = null;

  const fleet = loadFleet();
  const v = validateStack(s.members, fleet);

  document.getElementById('stackDetailTitle').textContent = s.name;
  
  const flyBtn = document.getElementById('btnStackDetailFly');
if (flyBtn) {
  const isFlying = (s.id === getSelectedStackId());
  flyBtn.disabled = isFlying;
  flyBtn.textContent = isFlying ? 'FLYING' : 'Fly this';
  // Replace to remove any old listener.
  const clone = flyBtn.cloneNode(true);
  flyBtn.parentNode.replaceChild(clone, flyBtn);
  clone.addEventListener('click', () => {
    setSelectedStackId(s.id);
    // Reset sim so CONFIG re-reads at next sim page load.
    alert(`Stack "${s.name}" is now active. Open the simulator to fly it.`);
    openStackDetail(s.id);   // re-render to update FLYING state
  });
}
  
  const badge = document.getElementById('stackDetailBadge');
  badge.textContent = v.valid ? 'VALID' : v.errors.length + ' ERR';
  badge.className = 'stack-badge ' + (v.valid ? 'valid' : 'invalid');

  document.getElementById('sd-count').textContent = s.members.length;
  document.getElementById('sd-height').textContent = v.stackTotalHeight.toFixed(1) + ' m';
  document.getElementById('sd-mass').textContent = fmtMass(v.stackTotalMass);

  // Member list — top-of-stack first, so it matches the physical layout.
  const listEl = document.getElementById('sd-memberList');
  const rows = [];
  for (let i = s.members.length - 1; i >= 0; i--) {
    const rec = fleet.find(r => r.id === s.members[i]);
    if (!rec) {
      rows.push(`<div class="cap-row"><dt>—</dt><dd>(missing fleet record)</dd></div>`);
      continue;
    }
    const role = rec.stageRole || 'rocket';
    const ownMass = stackMemberOwnMass(rec);
    const massStr = Number.isFinite(ownMass) ? fmtMass(ownMass) : '<span style="color:var(--danger)">INFEASIBLE</span>';
    rows.push(
      `<div class="cap-row">` +
        `<dt><span class="badge badge-role ${role}">${role.toUpperCase()}</span> ${escapeHtml(rec.name)}</dt>` +
        `<dd>${rec.height} m · W ${rec.width} m · ${massStr}</dd>` +
      `</div>`
    );
  }
  listEl.innerHTML = rows.length ? rows.join('') : '<div class="cap-row"><dt>—</dt><dd>No members.</dd></div>';

  renderStackValidationInto('sd-validationOutput', v);
  renderStackPreview(document.getElementById('stackPreviewCanvas'), s.members, fleet);

  document.getElementById('stackEditorEmpty').classList.add('hide');
  document.getElementById('stackEditorForm').classList.remove('show');
  document.getElementById('stackDetail').style.display = '';

  renderStackList();
}

// Draws the whole stack side-elevation style onto a canvas. Single scale for
// the entire stack (aspect ratio preserved): widest member = 50% of the
// canvas width, total height follows from the sum of member heights. Canvas
// CSS height is set dynamically so the drawing fits exactl

// Shared renderer for a validateStack() result into any element by id —
// used by both the editor's validation box and the detail view's.
function renderStackValidationInto(targetId, v) {
  const out = document.getElementById(targetId);
  if (!out) return;
  if (!v) { out.innerHTML = '—'; return; }
  if (v.valid) {
    out.innerHTML = `
      <div class="stack-valid-ok">✓ Valid stack</div>
      <div class="stack-valid-detail">
        Total height: <b>${v.stackTotalHeight.toFixed(1)} m</b> ·
        Total mass: <b>${fmtMass(v.stackTotalMass)}</b> ·
        ${v.memberInfo.length} member${v.memberInfo.length === 1 ? '' : 's'}
      </div>`;
  } else {
    const items = v.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
    out.innerHTML = `
      <div class="stack-valid-err">✕ ${v.errors.length} issue${v.errors.length === 1 ? '' : 's'}</div>
      <ul class="stack-valid-list">${items}</ul>
      <div class="stack-valid-detail">
        Total height: <b>${v.stackTotalHeight.toFixed(1)} m</b> ·
        Total mass: <b>${fmtMass(v.stackTotalMass)}</b>
      </div>`;
  }
}

// ---------------------------------------------------------------------------
// Stack editor (Phase 3 Step G2b).
//
// Members are stored bottom→top internally (members[0] = booster). The UI
// renders them top-of-stack-first (visually intuitive). Reorder buttons
// swap neighbours in the array; add/remove mutate it. Nothing commits to
// localStorage until Save — Cancel reverts.
// ---------------------------------------------------------------------------

function openStackEditorNew() {
  editingStackId = null;
  workingStackMembers = [];
  document.getElementById('stackEditorTitle').textContent = 'New Stack';
  document.getElementById('fs-name').value = 'New Stack';
  document.getElementById('btnStackDuplicate').style.display = 'none';
  document.getElementById('btnStackDelete').style.display = 'none';
  document.getElementById('stackDetail').style.display = 'none';
  showStackEditor();
  renderStackEditorBody();
  document.getElementById('fs-name').focus();
  document.getElementById('fs-name').select();
}

function openStackEditor(id) {
  const s = getStack(id);
  if (!s) return;
  editingStackId = id;
  workingStackMembers = [...s.members];
  document.getElementById('stackEditorTitle').textContent = s.name;
  document.getElementById('fs-name').value = s.name;
  document.getElementById('btnStackDuplicate').style.display = '';
  document.getElementById('btnStackDelete').style.display = '';
  document.getElementById('btnStackDelete').disabled = !!s.locked;
  document.getElementById('stackDetail').style.display = 'none';
  showStackEditor();
  renderStackEditorBody();
  renderStackList();
}

function showStackEditor() {
  document.getElementById('stackEditorEmpty').classList.add('hide');
  document.getElementById('stackEditorForm').classList.add('show');
  hideStackFormError();
}

function closeStackEditor() {
  const prevId = editingStackId;
  editingStackId = null;
  workingStackMembers = [];
  document.getElementById('stackEditorForm').classList.remove('show');
  
  if (prevId) {
    openStackDetail(prevId); // back to the detail we came from
  } else {
    document.getElementById('stackEditorEmpty').classList.remove('hide');
    document.getElementById('stackDetail').style.display = 'none';
    renderStackList();
  }
}

function renderStackEditorBody() {
  renderStackMemberChain();
  refreshAddMemberDropdown();
  renderStackValidation();
}

function renderStackMemberChain() {
  const host = document.getElementById('stackMemberChain');
  if (!host) return;
  const fleet = loadFleet();
  const n = workingStackMembers.length;

  if (!n) {
    host.innerHTML = `<div class="stack-member-empty">No members yet — add a booster first (bottom of stack).</div>`;
    return;
  }

  // Render top-first (reverse iteration) so the visual order matches the
  // physical stack (nose at top, booster at bottom).
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const rec = fleet.find(r => r.id === workingStackMembers[i]);
    const role = rec ? (rec.stageRole || 'rocket') : 'missing';
    const isBottom = i === 0;
    const isTop = i === n - 1;
    const roleClass = role === 'rocket' ? 'rocket-role' : (isBottom ? 'bottom' : (isTop ? 'top' : ''));
    const roleLabel = role === 'missing' ? 'MISSING' : role.toUpperCase();
    const name = rec ? escapeHtml(rec.name) : '(missing fleet record)';
    const ownMass = rec ? stackMemberOwnMass(rec) : NaN;
    const specs = rec
      ? `H ${rec.height} m · W ${rec.width} m · ${fmtMass(ownMass)}`
      : '—';
    const badgeClass = (role === 'rocket' || role === 'missing') ? 'badge-role rocket' : `badge-role ${role}`;

    rows.push(`
      <div class="stack-member-row ${roleClass}">
        <div class="stack-member-reorder">
          <button type="button" class="stack-reorder-btn" data-stack-move="up"   data-idx="${i}" ${isTop ? 'disabled' : ''} title="Move up">▲</button>
          <button type="button" class="stack-reorder-btn" data-stack-move="down" data-idx="${i}" ${isBottom ? 'disabled' : ''} title="Move down">▼</button>
        </div>
        <div class="stack-member-body">
          <div class="stack-member-name">
            <span class="${badgeClass}">${roleLabel}</span>
            &nbsp;${name}
          </div>
          <div class="stack-member-specs">${specs}</div>
        </div>
        <button type="button" class="stack-member-remove" data-stack-remove="${i}" title="Remove">✕</button>
      </div>
    `);
  }
  host.innerHTML = rows.join('');

  host.querySelectorAll('[data-stack-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const dir = btn.dataset.stackMove;
      const target = dir === 'up' ? idx + 1 : idx - 1;
      if (target < 0 || target >= workingStackMembers.length) return;
      const tmp = workingStackMembers[idx];
      workingStackMembers[idx] = workingStackMembers[target];
      workingStackMembers[target] = tmp;
      renderStackEditorBody();
    });
  });
  host.querySelectorAll('[data-stack-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.stackRemove, 10);
      workingStackMembers.splice(idx, 1);
      renderStackEditorBody();
    });
  });
}

function refreshAddMemberDropdown() {
  const sel = document.getElementById('fs-addMember');
  if (!sel) return;
  const fleet = loadFleet();
  const n = workingStackMembers.length;

  // Which roles are allowed as the NEXT member?
  //   n == 0 → bottom slot: 'booster' only.
  //   n  > 0 → above something: 'booster' or 'stage' (never 'rocket').
  // Also exclude records already in this stack (no duplicates within one
  // stack — a member can appear in different stacks, that's fine).
  const allowedRoles = n === 0 ? ['booster'] : ['booster', 'stage'];

  const options = fleet.filter(r => {
    if (!allowedRoles.includes(r.stageRole)) return false;
    if (workingStackMembers.includes(r.id)) return false;
    return true;
  });

  if (!options.length) {
    sel.innerHTML = `<option value="">— no valid members available —</option>`;
    sel.disabled = true;
    document.getElementById('btnStackAddMember').disabled = true;
    return;
  }
  sel.disabled = false;
  document.getElementById('btnStackAddMember').disabled = false;
  sel.innerHTML = options.map(r =>
    `<option value="${r.id}">${escapeHtml(r.name)} (${(r.stageRole || 'rocket').toUpperCase()}, W ${r.width} m)</option>`
  ).join('');
}

function renderStackValidation() {
  const v = validateStack(workingStackMembers, loadFleet());
  renderStackValidationInto('stackValidationOutput', v);
}

function readStackFormData() {
  return {
    name: document.getElementById('fs-name').value.trim() || 'Unnamed Stack',
    members: [...workingStackMembers],
  };
}

function showStackFormError(msg) {
  const el = document.getElementById('stackFormError');
  el.textContent = msg;
  el.classList.add('show');
}
function hideStackFormError() {
  document.getElementById('stackFormError').classList.remove('show');
}

function handleStackSubmit(e) {
  e.preventDefault();
  const data = readStackFormData();
  if (!data.members.length) { showStackFormError('Add at least one member (a booster).'); return; }
  const v = validateStack(data.members, loadFleet());
  if (!v.valid) { showStackFormError('Stack is invalid: ' + v.errors[0]); return; }
  hideStackFormError();

  let saved;
  if (editingStackId) {
    saved = updateStack(editingStackId, data);
  } else {
    saved = addStack(data);
    editingStackId = saved.id;
  }
  document.getElementById('stackEditorTitle').textContent = saved.name;
  document.getElementById('btnStackDuplicate').style.display = '';
  document.getElementById('btnStackDelete').style.display = '';
  renderStackList();
  // Save ho gaya — auto-mark as active so the sim picks it up.
setSelectedStackId(saved.id);
  // Keep editor open after save so the user can see the VALID state — same
  // choice as fleet's editor (which also stays until Cancel/another action).
}

function deleteStackFlow(id) {
  const s = getStack(id);
  if (!s || s.locked) return;
  if (!confirm(`Delete stack "${s.name}"? This can't be undone.`)) return;
  deleteStack(id);
  if (editingStackId === id) closeStackEditor();
  else renderStackList();
}

function duplicateStackFlow(id) {
  const s = getStack(id);
  if (!s) return;
  const copy = addStack({ name: s.name + ' (copy)', members: [...s.members] });
  openStackEditor(copy.id);
}

// Row click handler — called from renderStackList()'s row creation in G2b
// (list rows become clickable here).
function wireStackRowClicks() {
  const host = document.getElementById('stackList');
  if (!host) return;
  const stacks = loadStacks();
  host.querySelectorAll('.fleet-row').forEach((row, i) => {
    const s = stacks[i];
    if (!s) return;
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => openStackDetail(s.id));
  });
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

  hideFamilyDetail();
  viewingId = id;
  editingId = null;

  const role = r.stageRole || 'rocket';
  const isStage = role === 'stage';
  const isNose = role === 'nose';
  const hasStackCap = role === 'booster' || role === 'stage';

  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.textContent = val; };
  const show = (elId, vis) => { const el = document.getElementById(elId); if (el) el.style.display = vis ? '' : 'none'; };

  document.getElementById('detailTitle').textContent = r.name;
  document.getElementById('detailFlying').style.display = (r.id === getSelectedId()) ? '' : 'none';

  // Geometry rows
  set('d-height', r.height + ' m');
  set('d-width', r.width + ' m');
  show('d-row-dryMass', role === 'rocket' || role === 'booster' || isNose);
  show('d-row-fuelMassMax', role === 'rocket' || role === 'booster');
  if (role === 'rocket' || role === 'booster') {
    set('d-dryMass', fmtMass(r.dryMass));
    set('d-fuelMassMax', fmtMass(r.fuelMassMax));
  } else if (isNose) {
    set('d-dryMass', fmtMass(computeNoseDryMass(r)));
  }
  set('d-dragCd', r.dragCd);

  // Hardware sections — nose has none of these.
  if (!isNose) {
    const engineType = getComponentType(r.engineTypeId);
    renderDetailSection('engine', engineType, r.params, engineType ? `(${engineType.frame.slots.length} engines)` : '');
    renderDetailSection('recovery', getComponentType(r.recoveryTypeId), r.params);
    renderDetailSection('rcs', getComponentType(r.rcsTypeId), r.params);
  } else {
    set('d-engineNote', '—'); document.getElementById('d-engineList').innerHTML = '';
    set('d-recoveryNote', '—'); document.getElementById('d-recoveryList').innerHTML = '';
    set('d-rcsNote', '—'); document.getElementById('d-rcsList').innerHTML = '';
  }

  // Capabilities box (rocket/booster) vs. Stage capacity box (stage).
  show('detailCapsBox', role === 'rocket' || role === 'booster');
  show('d-stageFieldset', isStage);
  if (role === 'rocket') {
  set('d-dryMass', fmtMass(r.dryMass));
  set('d-fuelMassMax', fmtMass(r.fuelMassMax));
  const caps = rocketCapabilities(r);
  set('d-c-thrust', fmtForce(caps.totalMaxThrust));
    set('d-c-wet', fmtMass(caps.wetMass));
    set('d-c-twr', caps.twrMax.toFixed(2));
    set('d-c-dv', caps.deltaV.toFixed(0) + ' m/s');
    set('d-c-burn', caps.burnTimeS.toFixed(0) + ' s');
} else if (role === 'booster') {
  const d = boosterDerivedMasses(r);
  set('d-dryMass', fmtMass(d ? d.dryMass : 0));
  set('d-fuelMassMax', fmtMass(d ? d.fuelMass : 0));
  const caps = rocketCapabilities(r);   // already handles booster derived path
  set('d-c-thrust', fmtForce(caps.totalMaxThrust));
    set('d-c-wet', fmtMass(caps.wetMass));
    set('d-c-twr', caps.twrMax.toFixed(2));
    set('d-c-dv', caps.deltaV.toFixed(0) + ' m/s');
    set('d-c-burn', caps.burnTimeS.toFixed(0) + ' s');
} else if (isStage) {
    const d = stageDerivedMasses(r);
    if (!d || d.reason) {
      ['d-sc-fuel','d-sc-body','d-sc-engines','d-sc-payload','d-sc-legs','d-sc-dry',
       'd-sc-pd','d-sc-pt','d-sc-pmax','d-sc-wet'].forEach(k => set(k, '—'));
      set('d-sc-pmax', (d && d.reason) ? d.reason : '—');
    } else {
      set('d-sc-fuel', fmtMass(d.fuelMass));
      set('d-sc-body', fmtMass(d.bodyMass));
      set('d-sc-engines', fmtMass(d.totalEngineMass));
      set('d-sc-payload', fmtMass(d.payloadContainerMass));
      set('d-sc-legs', d.legMass > 0 ? fmtMass(d.legMass) : '—');
      set('d-sc-dry', fmtMass(d.dryMassNoPayload));
      set('d-sc-pd', d.maxPayloadMassFromDeltaV < 0 ? 'infeasible' : fmtMass(d.maxPayloadMassFromDeltaV));
      set('d-sc-pt', d.maxPayloadMassFromThrust < 0 ? 'infeasible' : fmtMass(d.maxPayloadMassFromThrust));
      const pmaxEl = document.getElementById('d-sc-pmax');
      if (d.infeasible) {
        pmaxEl.textContent = 'INFEASIBLE';
        pmaxEl.className = 'infeasible';
      } else {
        pmaxEl.textContent = fmtMass(d.maxPayloadMassKg);
        pmaxEl.className = 'feasible';
      }
      set('d-sc-wet', fmtMass(d.totalWetMassAtMaxPayload));
    }
}

  // Stack capacity row (booster + stage).
  show('d-extraWeightFieldset', hasStackCap);
  if (hasStackCap) set('d-maxExtraWeight', fmtMass(r.maxExtraWeightKg || 0));

  // Compatible boosters (stage only).
  if (isStage) {
    show('d-compatFieldset', true);
    renderCompatBoosters(r);
  } else {
    show('d-compatFieldset', false);
  }

  safeRenderPreview(document.getElementById('detailPreviewCanvas'), previewVehicleFor(r));

  document.getElementById('editorEmpty').classList.add('hide');
  document.getElementById('editorForm').classList.remove('show');
  document.getElementById('vehicleDetail').classList.add('show');

  renderFleetList();
}


// Renders the live "compatible boosters" list into the stage detail panel.
// Never cached — recomputed on every detail open from the current fleet, so
// adding/editing/deleting a booster immediately reflects here (PHASE3_PROMPT
// §1.4).
function renderCompatBoosters(stage) {
  const host = document.getElementById('d-compatList');
  if (!host) return;

  const d = stageDerivedMasses(stage);
  const infeasible = !d || d.infeasible;

  // Context line: what the stage is bringing to the party.
  const summary = infeasible
    ? `Stage is infeasible — no compatible booster can be computed.`
    : `Stage wet mass (at max payload): <b>${fmtMass(d.totalWetMassAtMaxPayload)}</b> · Width: <b>${stage.width} m</b>`;

  const fleet = loadFleet();
  const { compatible, incompatible } = compatibleBoostersForStage(stage, fleet);

  if (infeasible) {
    host.innerHTML = `<div class="compat-summary">${summary}</div>` +
      `<div class="legend-note">Fix the stage design (see Stage capacity above) first.</div>`;
    return;
  }
  if (!compatible.length && !incompatible.length) {
    host.innerHTML = `<div class="compat-summary">${summary}</div>` +
      `<div class="legend-note">No boosters defined in the fleet yet — add one to compare against.</div>`;
    return;
  }

  const rows = [];
  rows.push(`<div class="compat-summary">${summary}</div>`);

  if (compatible.length) {
    rows.push('<div class="compat-section-label">Compatible</div>');
    compatible.forEach(b => {
      rows.push(
        `<div class="compat-row ok">` +
          `<span class="compat-name">${escapeHtml(b.name)}</span>` +
          `<span class="compat-note">cap ${fmtMass(b.maxExtraWeightKg || 0)} · W ${b.width} m</span>` +
        `</div>`
      );
    });
  } else {
    rows.push('<div class="legend-note">No compatible boosters in the fleet.</div>');
  }

  if (incompatible.length) {
    rows.push('<div class="compat-section-label dim">Not compatible</div>');
    incompatible.forEach(({ booster, reasons }) => {
      rows.push(
        `<div class="compat-row bad">` +
          `<span class="compat-name">${escapeHtml(booster.name)}</span>` +
          `<span class="compat-note">${escapeHtml(reasons.join(' · '))}</span>` +
        `</div>`
      );
    });
  }

  host.innerHTML = rows.join('');
}


// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function openEditorFor(id) {
hideFamilyDetail();
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r) return;
  editingId = id;
  viewingId = null;
  editingRole = r.stageRole || 'rocket';
  fillForm(r);
  document.getElementById('editorTitle').textContent = r.name;
  document.getElementById('btnDuplicate').style.display = '';
  document.getElementById('btnDelete').style.display = '';
  document.getElementById('btnDelete').disabled = !!r.locked;
  showEditor();
  updateCapsPreview();
  renderFleetList();
}

function blankNoseData() {
  return {
    id: null,
    name: 'New Nose',
    locked: false,
    stageRole: 'nose',
    familyId: null,
    height: 5, width: 3.9, dragCd: 0.4,
    bodyMetalTypeId: 'al-li-alloy',
    noseCurveness: 0,
    // No engines/legs/RCS/fuel/payload for a nose — it's aerodynamic only.
  };
}

function openEditorNew(role) {
  role = role || 'rocket';
  editingId = null;
  viewingId = null;
  editingRole = role;
  const blank = role === 'booster' ? blankBoosterData() :
  role === 'stage' ? blankStageData() :
  role === 'nose' ? blankNoseData() :
  blankRocketData();
  fillForm(blank);
  document.getElementById('editorTitle').textContent = blank.name;
  document.getElementById('btnDuplicate').style.display = 'none';
  document.getElementById('btnDelete').style.display = 'none';
  showEditor();
  updateCapsPreview();
  renderFleetList();
  document.getElementById('f-name').focus();
  document.getElementById('f-name').select();
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (!el) { console.warn(`fillForm: missing element #${id} — skipped.`); return; }
  el.value = val;
}

function fillForm(r) {
  const role = r.stageRole || 'rocket';
  setVal('f-name', r.name);
  FIELD_MAP.forEach(f => setVal(f.id, r[f.key]));
  TYPE_SLOTS.forEach(slot => setVal(slot.selectId, r[slot.recordKey]));
  renderAllParamFields(r);
  renderEngineThrusters(r.engineTypeId, r.engineThrusters);
  renderRcsThruster(r.rcsThruster);
  
  const hasRec = r.hasRecovery !== false;   // default true
const hasRecEl = document.getElementById('f-hasRecovery');
if (hasRecEl) hasRecEl.checked = hasRec;
  if (role === 'stage' && r.fuel) {
    setVal('f-fuelType', r.fuel.typeId);
    setVal('f-fuelTankHeight', r.fuel.tankHeight);
    setVal('f-fuelTankWidth', r.fuel.tankWidth);
    setVal('f-bodyMetalType', r.bodyMetalTypeId);
  }
  if (role === 'stage' && r.payloadSpace) {
    setVal('f-payloadSpaceType', r.payloadSpace.typeId);
    setVal('f-payloadSpaceMetalType', r.payloadSpace.metalTypeId);
    setVal('f-payloadSpaceDeployment', r.payloadSpace.deploymentDirection || 'clamshell');
    renderPayloadSpaceParams(r.payloadSpace.typeId, r.payloadSpace.params);
  }
  if (role === 'nose') {
  setVal('f-bodyMetalType', r.bodyMetalTypeId || 'al-li-alloy');
  setVal('f-noseCurveness', r.noseCurveness || 0);
}
// P4-D2: body appearance.
const bd = r.bodyDesign || { mode: 'solid', solidColor: '#e9edf2', dslText: '' };
setVal('f-bodyDesignMode', bd.mode || 'solid');
setVal('f-bodySolidColor', bd.solidColor || '#e9edf2');
const dslTA = document.getElementById('f-bodyDslText');
if (dslTA) dslTA.value = bd.dslText || '';
if (role === 'stage' && r.payloadSpace) {
  setVal('f-payloadSpaceColor', r.payloadSpace.color || '#e9edf2');
}
applyBodyDesignVisibility(role);
validateBodyDslInput();   // reset any prior error display

  if (role === 'booster' || role === 'stage') {
    setVal('f-maxExtraWeight', r.maxExtraWeightKg || 0);
  }
  
  if ((role === 'stage' || role === 'booster') && r.fuel) {
  setVal('f-fuelType', r.fuel.typeId);
  setVal('f-fuelTankHeight', r.fuel.tankHeight);
  setVal('f-fuelTankWidth', r.fuel.tankWidth);
  setVal('f-bodyMetalType', r.bodyMetalTypeId);
}
  applyRoleVisibility(role);
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
  creatingInFamilyId = null; // P4-B1: abandon a half-created family's first member

  document.getElementById('editorForm').classList.remove('show');
  document.getElementById('vehicleDetail').classList.remove('show');
  document.getElementById('editorEmpty').classList.remove('hide');
  renderFleetList();
}

function readVal(id) {
  const el = document.getElementById(id);
  return el ? parseFloat(el.value) : undefined;
}
function readStr(id, fallback) {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}


// Phase 4 (P4-B3): which family does the record currently being edited/created
// belong to? Used by nose (and any other role-specific path) to preserve
// family attachment through a save.
function editingRecordFamilyId() {
  if (editingId) {
    const rec = loadFleet().find(r => r.id === editingId);
    if (rec) return rec.familyId;
  }
  if (creatingInFamilyId) return creatingInFamilyId;
  return null;
}

function readFormData() {
  const role = editingRole;
  const data = {
    name: document.getElementById('f-name').value.trim() || 'Unnamed Vehicle',
    stageRole: role,
  };
  
  FIELD_MAP.forEach(f => {
    if (role !== 'rocket' && (f.key === 'dryMass' || f.key === 'fuelMassMax')) return;
    data[f.key] = parseFloat(document.getElementById(f.id).value);
  });
  TYPE_SLOTS.forEach(slot => { data[slot.recordKey] = document.getElementById(slot.selectId).value; });
  data.params = currentParamValues();
  data.bodyDesign = {
  mode: document.getElementById('f-bodyDesignMode').value || 'solid',
  solidColor: document.getElementById('f-bodySolidColor').value || '#e9edf2',
  dslText: (document.getElementById('f-bodyDslText').value || '').trim(),
};
  data.engineThrusters = readEngineThrusters();
  data.rcsThruster = readRcsThruster();
  
  // Nose early return
  if (role === 'nose') {
    const H = parseFloat(document.getElementById('f-height').value) || 0;
    const W = parseFloat(document.getElementById('f-width').value) || 0;
    const metalId = document.getElementById('f-bodyMetalType').value || 'al-li-alloy';
    const curv = parseFloat(document.getElementById('f-noseCurveness').value) || 0;
    const metal = getComponentType(metalId);
    const density = metal ? metal.parameterSchema.find(p => p.key === 'density').value : 0;
    const coneVolume = (1 / 3) * Math.PI * Math.pow(W / 2, 2) * H;
    return {
      name: document.getElementById('f-name').value.trim() || 'Unnamed Nose',
      stageRole: 'nose',
      height: H,
      width: W,
      dragCd: parseFloat(document.getElementById('f-dragCd').value) || 0.4,
      bodyMetalTypeId: metalId,
      noseCurveness: curv,
      dryMass: coneVolume * BODY_SHELL_FACTOR * density,
      bodyDesign: {
  mode: 'solid',
  solidColor: document.getElementById('f-bodySolidColor').value || '#e9edf2',
  dslText: '',
},
      familyId: editingRecordFamilyId(),
    };
  }
  
  // Stage + booster fuel/metal block
  if (role === 'stage' || role === 'booster') {
    data.fuel = {
      typeId: document.getElementById('f-fuelType').value,
      tankHeight: parseFloat(document.getElementById('f-fuelTankHeight').value),
      tankWidth: parseFloat(document.getElementById('f-fuelTankWidth').value),
    };
    data.bodyMetalTypeId = document.getElementById('f-bodyMetalType').value;
  }
  if (role === 'stage') {
    data.payloadSpace = {
  typeId: document.getElementById('f-payloadSpaceType').value,
  metalTypeId: document.getElementById('f-payloadSpaceMetalType').value,
  deploymentDirection: document.getElementById('f-payloadSpaceDeployment').value,
  color: document.getElementById('f-payloadSpaceColor').value || '#e9edf2',
  params: currentParamValues('payload'),
};
  }
  if (role === 'booster' || role === 'stage') {
    data.maxExtraWeightKg = parseFloat(document.getElementById('f-maxExtraWeight').value) || 0;
  }
  
  const hasRecEl = document.getElementById('f-hasRecovery');
  data.hasRecovery = hasRecEl ? hasRecEl.checked : true;
  
  bridgePerfParams(data);
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
  if (data.stageRole === 'nose') {
    safeRenderPreview(document.getElementById('vehiclePreviewCanvas'), previewVehicleFor(data));
    return;
  }
  if (data.stageRole === 'stage') {
  updateStageCapsPreview(data);
  safeRenderPreview(document.getElementById('vehiclePreviewCanvas'), previewVehicleFor(data));
  return;
}
  if (data.stageRole === 'booster') {
    const d = boosterDerivedMasses(data);
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    if (!d) { ['c-thrust','c-wet','c-twr','c-dv','c-burn'].forEach(k => set(k, '—')); return; }
    const mdotMax = d.effectiveVe > 0 ? d.totalEngineThrust / d.effectiveVe : 0;
    const twrMax = d.wetMass > 0 ? d.totalEngineThrust / (d.wetMass * 9.8) : 0;
    const deltaV = (d.wetMass > 0 && d.dryMass > 0) ? d.effectiveVe * Math.log(d.wetMass / d.dryMass) : 0;
    const burnTimeS = mdotMax > 0 ? d.fuelMass / mdotMax : 0;
    set('c-thrust', fmtForce(d.totalEngineThrust));
    set('c-wet', fmtMass(d.wetMass));
    set('c-twr', twrMax.toFixed(2));
    set('c-dv', deltaV.toFixed(0) + ' m/s');
    set('c-burn', burnTimeS.toFixed(0) + ' s');
    safeRenderPreview(document.getElementById('vehiclePreviewCanvas'), previewVehicleFor(data));
    return;
  }

  // Rocket path
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
  safeRenderPreview(document.getElementById('vehiclePreviewCanvas'), previewVehicleFor(data));
}


function updateStageCapsPreview(data) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const reset = () => ['sc-fuel','sc-body','sc-engines','sc-payload','sc-legs','sc-dry',
                        'sc-ve','sc-thrust','sc-pd','sc-pt','sc-pmax','sc-wet']
                        .forEach(id => set(id, '—'));

  const derived = stageDerivedMasses(data);
  if (!derived) { reset(); return; }
  if (derived.reason) { reset(); set('sc-pmax', derived.reason); return; }

  set('sc-fuel', fmtMass(derived.fuelMass));
  set('sc-body', fmtMass(derived.bodyMass));
  set('sc-engines', `${fmtMass(derived.totalEngineMass)} / ${fmtForce(derived.totalEngineThrust)}`);
  set('sc-payload', fmtMass(derived.payloadContainerMass));
  set('sc-legs', derived.legMass > 0 ? fmtMass(derived.legMass) : '—');
  set('sc-dry', fmtMass(derived.dryMassNoPayload));
  set('sc-ve', Math.round(derived.effectiveVe).toLocaleString() + ' m/s');
  set('sc-thrust', fmtForce(derived.totalEngineThrust));
  set('sc-pd', derived.maxPayloadMassFromDeltaV < 0 ? 'infeasible' : fmtMass(derived.maxPayloadMassFromDeltaV));
  set('sc-pt', derived.maxPayloadMassFromThrust < 0 ? 'infeasible' : fmtMass(derived.maxPayloadMassFromThrust));

  const pmaxEl = document.getElementById('sc-pmax');
  if (derived.infeasible) {
    pmaxEl.textContent = 'INFEASIBLE';
    pmaxEl.style.color = 'var(--danger)';
  } else {
    pmaxEl.textContent = fmtMass(derived.maxPayloadMassKg);
    pmaxEl.style.color = 'var(--cyan)';
  }
  set('sc-wet', fmtMass(derived.totalWetMassAtMaxPayload));

  const warnRow = document.getElementById('sc-warnRow');
  const warnEl = document.getElementById('sc-warn');
  if (derived.warnings && derived.warnings.length) {
    warnRow.style.display = '';
    warnEl.textContent = derived.warnings.join(' · ');
  } else {
    warnRow.style.display = 'none';
  }
}



// ---------------------------------------------------------------------------
// Save / duplicate / delete
// ---------------------------------------------------------------------------
function handleSubmit(e) {
  e.preventDefault();
  const form = document.getElementById('editorForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const data = readFormData();
  if (Number.isFinite(data.fuelMassMax) && data.fuelMassMax < 0) {
    showFormError('Propellant mass cannot be negative.'); return;
  }
  if (data.params && data.params.engineFMinFrac !== undefined && data.params.engineFMinFrac >= 1) {
    showFormError('Throttle floor must be less than 1 (100%).'); return;
  }
  if (data.stageRole === 'stage') {
    const derived = stageDerivedMasses(data);
    if (!derived) { showFormError('Stage computation failed.'); return; }
    if (derived.reason) { showFormError('Stage design invalid: ' + derived.reason); return; }
    if (derived.infeasible) {
      showFormError(`Stage infeasible — max payload ${fmtMass(derived.maxPayloadMassKg)}.`);
      return;
    }
  }
  
  // P4-D2: DSL validity — block save on invalid JSON.
if (data.bodyDesign && data.bodyDesign.mode === 'dsl') {
  const v = parseAndValidateDesign(data.bodyDesign.dslText);
  if (!v.ok) {
    showFormError('Body design DSL invalid — ' + v.error);
    return;
  }
}
  
  hideFormError();

  let saved;
  if (editingId) {
    saved = updateRocket(editingId, data);
  } else {
    if (creatingInFamilyId) data.familyId = creatingInFamilyId;
    saved = addRocket(data);
    editingId = saved.id;
    if (creatingInFamilyId && (saved.stageRole === 'booster' || saved.stageRole === 'rocket')) {
      const fam = getFamily(creatingInFamilyId);
      if (fam && !fam.bottomId) updateFamily(creatingInFamilyId, { bottomId: saved.id });
    }
    creatingInFamilyId = null;
  }

  // P4-C1 fix: close editor and show the read-only detail view — the same
  // "save done, here's the result" flow the Edit button reverses.
  showVehicleDetail(saved.id);
}

function duplicateRocket(id) {
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r) return;
  const isBottomRole = r.stageRole === 'booster' || r.stageRole === 'rocket';
  
  if (isBottomRole) {
    // P4-B3: duplicating a booster/rocket spins off a NEW family (a family
    // can only have one bottom member). Original family is untouched.
    const { id: _drop, locked: _l, familyId: _f, ...rest } = r;
    const copy = addRocket({ ...rest, name: r.name + ' (copy)' });
    const fam = addFamily({ name: r.name + ' Family (copy)', bottomId: copy.id });
    updateRocket(copy.id, { familyId: fam.id });
    openEditorFor(copy.id);
  } else {
    // Stage/nose duplicates stay in the same family.
    const { id: _drop, locked: _l, ...rest } = r;
    const copy = addRocket({ ...rest, name: r.name + ' (copy)' });
    openEditorFor(copy.id);
  }
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
  // View tabs (Phase 3 Step G2a).
document.querySelectorAll('#viewTabs .view-tab').forEach(btn => {
  btn.addEventListener('click', () => setActiveView(btn.dataset.view));
});

// "+ New Stack" — G2a: creates an empty stack with a prompted name so
// the list has something to show. Full editor (member picker, rename,
// delete) lands in G2b.
document.getElementById('btnNewStack').addEventListener('click', openStackEditorNew);

// Stack editor bindings (Phase 3 Step G2b).
document.getElementById('btnStackCancel').addEventListener('click', closeStackEditor);
document.getElementById('btnStackDuplicate').addEventListener('click', () => editingStackId && duplicateStackFlow(editingStackId));
document.getElementById('btnStackDelete').addEventListener('click', () => editingStackId && deleteStackFlow(editingStackId));
document.getElementById('stackEditorForm').addEventListener('submit', handleStackSubmit);
document.getElementById('btnStackAddMember').addEventListener('click', () => {
  const sel = document.getElementById('fs-addMember');
  if (!sel || !sel.value) return;
  workingStackMembers.push(sel.value);
  renderStackEditorBody();
});
document.getElementById('btnStackDetailEdit').addEventListener('click', () => {
  if (viewingStackId) openStackEditor(viewingStackId);
});
// Family detail pane (Phase 4 Step P4-B2).
document.getElementById('btnFamilyAddMember').addEventListener('click', () => {
  if (viewingFamilyId) openFamilyAddMember(viewingFamilyId);
});
document.getElementById('btnFamilyDelete').addEventListener('click', () => {
  if (!viewingFamilyId) return;
  const fam = getFamily(viewingFamilyId);
  if (!fam) return;
  if (!confirm(`Delete family "${fam.name}"?`)) return;
  if (deleteFamily(viewingFamilyId)) {
    hideFamilyDetail();
    document.getElementById('editorEmpty').classList.remove('hide');
    renderFleetList();
  } else {
    alert('Cannot delete — the family still has members, or is protected.');
  }
});

const hasRecCb = document.getElementById('f-hasRecovery');
if (hasRecCb) {
  hasRecCb.addEventListener('change', () => {
    applyRecoveryVisibility(editingRole);
    updateCapsPreview(); // ← ye line add karo — preview turant refresh
  });
} else {
  console.warn('f-hasRecovery checkbox missing in rockets.html');
}
// P4-D2 body appearance bindings.
const bdmSel = document.getElementById('f-bodyDesignMode');
if (bdmSel) {
  bdmSel.addEventListener('change', () => {
    applyBodyDesignVisibility(editingRole);
    updateCapsPreview();
  });
}
['f-bodySolidColor', 'f-payloadSpaceColor'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateCapsPreview);
});
const dslTA = document.getElementById('f-bodyDslText');
if (dslTA) {
  dslTA.addEventListener('input', () => {
    validateBodyDslInput();
    updateCapsPreview();
  });
}

  renderFleetList();

  TYPE_SLOTS.forEach(slot => {
  document.getElementById(slot.selectId).addEventListener('change', (e) => {
    renderParamFields(slot, e.target.value, currentParamValues());
    if (slot.category === 'engineLayout') {
      renderEngineThrusters(e.target.value, readEngineThrusters());
    }
    if (slot.category === 'rcsArrangement') {
      renderRcsThruster(readRcsThruster());
    }
    updateCapsPreview();
  });
});

  
  document.getElementById('btnCancel').addEventListener('click', closeEditor);
  document.getElementById('btnDelete').addEventListener('click', () => editingId && deleteRocketFlow(editingId));
  document.getElementById('btnDuplicate').addEventListener('click', () => editingId && duplicateRocket(editingId));
  document.getElementById('btnDetailEdit').addEventListener('click', () => viewingId && openEditorFor(viewingId));
  document.getElementById('editorForm').addEventListener('submit', handleSubmit);
  document.getElementById('editorForm').addEventListener('input', updateCapsPreview);
});
