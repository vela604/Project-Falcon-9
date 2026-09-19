// ============================================================================
// rockets-core.js — Vehicle Fleet page, PART 1 of 2: data/schema layer.
//
// SPLIT NOTE: this file used to be the top half of a single rockets.js
// (2457 lines — too big to navigate comfortably). It's split into two plain
// <script> files (no modules), so everything here still attaches to the
// global scope exactly as before — rockets-ui.js (loaded right after this
// one) freely calls every function/variable declared here, and vice versa.
// Load order in rockets.html MUST be: rockets-core.js then rockets-ui.js.
//
// WHAT LIVES HERE:
//   - Shared page state (editingId, viewingId, editingStackId, etc.)
//   - Formatting helpers (fmtMass, fmtForce, fmtParamValue, escapeHtml*)
//   - Vehicle-preview adapter (previewVehicleFor / safeRenderPreview)
//   - Hardware-type dropdown population + role/recovery/payload-space/body-
//     design visibility toggling for the editor form
//   - Role-picker modal wiring (top-level, runs at script-load time)
//   - Auto-generated parameter-field rendering, driven by the Components
//     Library's parameterSchema (renderParamFields, renderEngineThrusters,
//     renderRcsThruster, renderPayloadSpaceParams, etc.)
//   - Form readers (readEngineThrusters, readRcsThruster, currentParamValues)
//
// escapeHtml() itself is still defined in rockets-ui.js (it's used by both
// files) — kept there rather than duplicated, since rockets-ui.js is loaded
// second and escapeHtml() is only ever CALLED from here inside functions
// (not at top-level parse time), so the forward reference resolves fine by
// the time any of this file's functions actually run.
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
let viewingStackId = null; // set while the read-only detail panel is open// null = new stack, id = editing existing
let workingStackMembers = []; // array of fleet-record ids, bottom→top
let workingStackPayloadId = null;
let editingId = null; // set only while the edit FORM is open


let viewingId = null; // set only while the read-only detail panel is open
// Phase 4 (P4-B1): set only while creating the FIRST member of a brand-new
// family — the record being created gets this familyId assigned, and (if
// it's a booster/rocket) becomes that family's bottomId. Reset on Cancel
// or after save.
let creatingInFamilyId = null;
// Phase 4 (P4-B2): set only while the read-only family detail pane is open.
let viewingFamilyId = null;


function fmtMass(kg) {
  if (!Number.isFinite(kg)) return '—';
  return (kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' t';
}

function fmtForce(n) { return (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' kN'; }

// Generic formatter for a schema-declared parameter value, keyed off the
// schema's OWN unit string rather than the parameter's name — so it works
// for any key any type ever declares, not just the built-in ones.
function fmtParamValue(p, value) {
  if (!Number.isFinite(value)) return '—';
  switch (p.unit) {
    case 'N':
      return value >= 10000 ? fmtForce(value) : Math.round(value).toLocaleString() + ' N';
    case 'frac':
      return Math.round(value * 100) + '%';
    case 'deg':
      return '±' + value + '°';
    case 'm/s':
      return value.toLocaleString() + ' m/s';
    default:
      return value + (p.unit ? ' ' + p.unit : '');
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
  // Standalone payloadSpace role — map record fields + its shape type's
  // params onto the opts names drawPayloadSpaceShape() actually reads.
  // The type's `kind` decides noseCapShape vs bulgedCapShape (Rule 1 — no
  // branching on the type's id here, just its structural kind).
  const psType = (record.stageRole === 'payloadSpace' && record.payloadSpaceTypeId &&
    typeof getComponentType === 'function') ? getComponentType(record.payloadSpaceTypeId) : null;
  const psParams = record.params || {};
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
    payloadKind: psType ? psType.kind : undefined,
    payloadCapWidth: Number.isFinite(psParams.capWidth) ? psParams.capWidth : undefined,
    payloadBulgeWidth: Number.isFinite(psParams.bulgeWidth) ? psParams.bulgeWidth : undefined,
    payloadFrustumAngleDeg: Number.isFinite(psParams.frustumSlantDeg) ? psParams.frustumSlantDeg : undefined,
    payloadCurveRatio: Number.isFinite(psParams.curveHeightFactor) ? psParams.curveHeightFactor : undefined,
    payloadColor: record.stageRole === 'payloadSpace' ? (record.color || '#e9edf2') : undefined,
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
  [
    ['f-fuelType', 'fuel'],
    ['f-bodyMetalType', 'metal'],
    ['f-payloadSpaceType', 'payloadSpace'],
    ['f-payloadSpaceMetalType', 'metal'],
    ['f-psShapeType', 'payloadSpace'],
    ['f-psMetalType', 'metal'],
  ].forEach(([id, cat]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const types = getComponentsByCategory(cat);
    el.innerHTML = types.map(t => `<option value="${t.id}">${escapeHtml(t.displayName)}</option>`).join('');
  });
}

// BUG #2 FIX: same pattern as applyRecoveryVisibility() — a stage can now
// opt OUT of having a payload space entirely (checkbox off), instead of
// being forced to always carry one with a non-zero minimum height/width.
// When off, the whole wrap is hidden and every input inside it disabled,
// so the browser's native required-field validation skips them and
// readFormData() (below) sends payloadSpace: null.
function applyPayloadSpaceVisibility(role) {
  const cb = document.getElementById('f-hasPayloadSpace');
  const wrap = document.getElementById('stagePayloadFieldsWrap');
  if (!cb || !wrap) return;
  
  const roleAllows = role === 'stage';
  const cbWrap = cb.closest('label');
  if (cbWrap) cbWrap.style.display = roleAllows ? '' : 'none';
  
  const on = roleAllows && cb.checked;
  wrap.style.display = on ? '' : 'none';
  wrap.querySelectorAll('input, select, textarea').forEach(inp => { inp.disabled = !on; });
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
  
  // BUG #7 FIX: handle BOTH states here, not just OFF. The checkbox's own
  // 'change' listener calls applyRecoveryVisibility() directly (not
  // applyRoleVisibility()), so relying on the role-matrix pass to re-enable
  // fields on ON never actually ran in that path — fields stayed disabled
  // forever after one OFF→ON toggle.
  if (paramsBox) {
    if (!on) {
      paramsBox.style.display = 'none';
      paramsBox.querySelectorAll('input, select, textarea').forEach(inp => { inp.disabled = true; });
    } else {
      paramsBox.style.display = '';
      paramsBox.querySelectorAll('input, select, textarea').forEach(inp => { inp.disabled = false; });
    }
  }
}

// P4-D2: Body-appearance fieldset sub-state. Role restricts whether DSL is
// available (stage/nose are solid-colour-only), and mode selects which
// sub-field is shown.
function applyBodyDesignVisibility(role) {
  const select = document.getElementById('f-bodyDesignMode');
  if (!select) return;
  
  // DSL allowed for all roles now.
  const dslOption = select.querySelector('option[value="dsl"]');
  if (dslOption) dslOption.disabled = false;
  
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

// Standalone payloadSpace role: same pattern, its own scope/grid/ids.
const psShapeSel = document.getElementById('f-psShapeType');
if (psShapeSel) {
  psShapeSel.addEventListener('change', (e) => {
    renderPsParams(e.target.value, currentParamValues('ps'));
    updateCapsPreview();
  });
}

// Stage-specific inputs also trigger live capability preview (E2 will
// actually compute; E1 just keeps the handler wiring in place).
['f-fuelType', 'f-fuelTankHeight', 'f-fuelTankWidth', 'f-bodyMetalType',
  'f-baffleCount', 'f-baffleInnerRadiusFrac',
  'f-payloadSpaceType', 'f-payloadSpaceMetalType', 'f-payloadSpaceDeployment',
  'f-maxExtraWeight',
  'f-psShapeType', 'f-psMetalType', 'f-psDeployment'
].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => updateCapsPreview());
});



// No step is declared in a type's parameterSchema (Components Library only
// ever declares key/label/unit/min/max — see componentLibrary.js's design
// rule), so this infers a sensible one from the unit/min instead of the
// editor needing a hardcoded step per field name.
function inferParamStep(p) {
  if (p.unit === 'frac') return 0.01;
  if (p.min !== undefined && p.min > 0 && p.min < 1) return 0.01;
  if (p.min !== undefined && p.min >= 1000) return Math.max(1, Math.round(p.min / 100));
  return 0.1;
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
    const label = gk === 'gimbal' ?
      `Gimbal-capable group — ${slots.length} engine${slots.length === 1 ? '' : 's'}` :
      gk === 'fixed' ?
      `Fixed (non-gimbal) group — ${slots.length} engine${slots.length === 1 ? '' : 's'}` :
      `${gk} group — ${slots.length} engine${slots.length === 1 ? '' : 's'}`;
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
  const ve = valOf('ve'),
    maxFlow = valOf('maxMassFlowRate');
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
    const handler = () => { updateRcsThrusterDerived();
      updateCapsPreview(); };
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

// PS-C2: standalone payloadSpace role's own params grid (scope 'ps') —
// deliberately separate function/grid/scope from renderPayloadSpaceParams
// above, which still belongs to the deprecated stage-editor nested field
// until PS-C's cleanup removes it.
function renderPsParams(typeId, currentParams) {
  const grid = document.getElementById('psParamsGrid');
  if (!grid) return;
  const type = getComponentType(typeId);
  if (!type) { grid.innerHTML = ''; return; }
  grid.innerHTML = renderParamFieldsHTML(type.parameterSchema, currentParams || {}, 'ps');
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
    payloadSpaceFieldset: ['payloadSpace'],
    noseShapeFieldset: ['nose'],
    aeroFieldset: ['rocket', 'booster', 'stage', 'nose', 'payloadSpace'],
    extraWeightFieldset: ['booster', 'stage'],
    capsBox: ['rocket', 'booster'],
    stageCapsBox: ['stage'],
    massDryField: ['rocket'],
    massFuelField: ['rocket'],
    bodyDesignFieldset: ['rocket', 'booster', 'stage', 'nose', 'payloadSpace'],
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
  applyPayloadSpaceVisibility(role);
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