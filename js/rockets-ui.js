// ============================================================================
// rockets-ui.js — Vehicle Fleet page, PART 2 of 2: page views + CRUD flows.
//
// SPLIT NOTE: continuation of rockets-core.js (loaded right before this
// file — see that file's header for the split rationale and full contract).
// This half owns everything that actually RENDERS a screen or handles a
// user action end-to-end:
//   - Fleet list / family detail / family "add member" flow
//   - Stack list, stack detail (read-only), stack editor (create/edit)
//   - Payload-record list + tiny inline editor
//   - Vehicle detail (read-only "Fly this" panel) + booster-compatibility list
//   - The main vehicle editor form: fill / read / validate / save / delete /
//     duplicate, plus the live capability & stage-capacity preview
//   - escapeHtml() — defined here but used throughout rockets-core.js too;
//     safe because every rockets-core.js call site is inside a function
//     body (evaluated later), never at top-level script-parse time.
//   - Final DOMContentLoaded bootstrap that wires every button/select on
//     the page — this is the single true entry point for the whole file
//     pair, so it necessarily calls functions from BOTH halves.
//
// Depends on every global declared in rockets-core.js (FIELD_MAP,
// TYPE_SLOTS, editingId/viewingId/etc. state, renderParamFields(),
// applyRoleVisibility(), currentParamValues(), ...). rockets.html must load
// rockets-core.js before this file.
// ============================================================================

// ---------------------------------------------------------------------------
// Fleet list
// ---------------------------------------------------------------------------
// Role-aware spec summary — one line per record in the fleet list. Rocket
// and booster reuse the existing capability math; a stage needs its own
// derived numbers (fuel mass, max payload, wet mass) because its flat
// dryMass/fuelMassMax don't exist (see stageDerivedMasses() in fleet.js).
//
// BUGFIX: nose and payloadSpace records used to fall through to the
// rocketCapabilities(r) call at the bottom of this function — but those
// roles carry no engine `params` bag at all (params is null / not engine-
// shaped), which crashed rocketCapabilities() the instant one existed in
// the fleet and took down the ENTIRE fleet list render. Both roles now get
// their own dedicated summary line instead of ever reaching
// rocketCapabilities() — same pattern as the existing 'stage' branch below.
function fleetRowSpecsHTML(r) {
  if (r.stageRole === 'stage') {
    const d = stageDerivedMasses(r);
    if (!d || d.reason) return `<span class="accent">—</span>`;
    const maxP = d.infeasible ?
      '<span style="color:var(--danger)">INFEASIBLE</span>' :
      `payload ${fmtMass(d.maxPayloadMassKg)}`;
    return `
      <span>${r.height} m</span>
      <span class="accent">${fmtForce(d.totalEngineThrust)}</span>
      <span>fuel ${fmtMass(d.fuelMass)}</span>
      <span>${maxP}</span>
      <span>wet ${fmtMass(d.totalWetMassAtMaxPayload)}</span>`;
  }
  if (r.stageRole === 'nose') {
    return `
      <span>${r.height} m</span>
      <span>W ${r.width} m</span>
      <span class="accent">${fmtMass(computeNoseDryMass(r))}</span>`;
  }
  if (r.stageRole === 'payloadSpace') {
    const shapeType = getComponentType(r.payloadSpaceTypeId);
    return `
      <span>${r.height} m</span>
      <span>W ${r.width} m</span>
      <span class="accent">${shapeType ? shapeType.displayName : '—'}</span>`;
  }
  const caps = rocketCapabilities(r);
  const extraRow = (r.stageRole === 'booster') ?
    `<span>cap ${fmtMass(r.maxExtraWeightKg || 0)}</span>` :
    '';
  return `
    <span>${r.height} m</span>
    <span class="accent">${fmtForce(caps.totalMaxThrust)}</span>
    <span>TWR ${caps.twrMax.toFixed(2)}</span>
    <span>Δv ${caps.deltaV.toFixed(0)} m/s</span>
    ${extraRow}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } [c]));
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
    const boosterLabel = bottom ?
      `base: ${escapeHtml(bottom.name)}` :
      '<span style="color:var(--amber)">no booster yet</span>';
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
      if (act === 'fly') { setSelectedId(id);
        showVehicleDetail(id); }
      if (act === 'edit') openEditorFor(id);
      if (act === 'dup') duplicateRocket(id);
      if (act === 'del') deleteRocketFlow(id);
    });
  });
  
  // Row click → view detail (Fly this removed from rows; stack flies now).
  host.querySelectorAll('.family-member-indent .fleet-row').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // ignore button clicks
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
  const allowed = hasBooster ? ['stage', 'nose', 'payloadSpace'] : ['booster'];
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
let editingPayloadId = null;

function setActiveView(view) {
  activeView = view;
  const isFleet = view === 'fleet';
  const isStacks = view === 'stacks';
  const isPayloads = view === 'payloads';
  document.getElementById('fleetPane').style.display = isFleet ? '' : 'none';
  document.getElementById('editorPane').style.display = isFleet ? '' : 'none';
  document.getElementById('stackPane').style.display = isStacks ? '' : 'none';
  document.getElementById('stackEditorPane').style.display = isStacks ? '' : 'none';
  document.getElementById('payloadPane').style.display = isPayloads ? '' : 'none';
  document.getElementById('payloadEditorPane').style.display = isPayloads ? '' : 'none';
  document.querySelectorAll('#viewTabs .view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  if (isStacks) {
    renderStackList();
    if (editingStackId) openStackEditor(editingStackId);
  }
  if (isPayloads) renderPayloadList();
}

function renderStackList() {
  const host = document.getElementById('stackList');
  if (!host) return;
  const stacks = loadStacks();
  const fleet = loadFleet();
  host.innerHTML = '';
  
  if (!stacks.length) return; // :empty::after shows placeholder
  
  stacks.forEach(s => {
    const v = validateStack(s.members, fleet, s);
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
// Payloads view (Step I-b).
// ---------------------------------------------------------------------------
function renderPayloadList() {
  const host = document.getElementById('payloadList');
  if (!host) return;
  const list = loadPayloads();
  host.innerHTML = '';
  if (!list.length) {
    host.innerHTML = '<p style="color:var(--dim);font-size:13px;">No payloads yet — click &quot;+ New Payload&quot; to create one.</p>';
    return;
  }
  list.forEach(p => {
    const row = document.createElement('div');
    row.className = 'fleet-row' + (p.id === editingPayloadId ? ' active' : '');
    row.innerHTML = `
      <div class="fleet-row-top">
        <span class="fleet-row-name">${escapeHtml(p.name)}</span>
      </div>
      <div class="fleet-row-specs">
        <span>${fmtMass(p.mass)}</span>
        <span>H ${p.height} m · W ${p.width} m</span>
        <span>Cd ${p.dragCd}</span>
      </div>
      <div class="fleet-row-actions">
        <button class="btn" data-pl-act="edit" data-id="${p.id}">Edit</button>
        <button class="btn btn-danger" data-pl-act="del" data-id="${p.id}">Delete</button>
      </div>
    `;
    host.appendChild(row);
  });
  host.querySelectorAll('button[data-pl-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.plAct === 'edit') openPayloadEditor(btn.dataset.id);
      if (btn.dataset.plAct === 'del') {
        if (confirm('Delete this payload?')) { deletePayload(btn.dataset.id);
          renderPayloadList(); }
      }
    });
  });
  host.querySelectorAll('.fleet-row').forEach((row, i) => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openPayloadEditor(list[i].id);
    });
  });
}

function openPayloadEditor(id) {
  editingPayloadId = id;
  const p = id ? getPayload(id) : blankPayloadData();
  if (!p) return;
  document.getElementById('payloadEditorTitle').textContent = p.name || 'New Payload';
  document.getElementById('pl-name').value = p.name || '';
  document.getElementById('pl-mass').value = p.mass;
  document.getElementById('pl-height').value = p.height;
  document.getElementById('pl-width').value = p.width;
  document.getElementById('pl-dragCd').value = p.dragCd;
// maxHeatFlux — default 20 kW/m² for legacy payloads that predate
// this field. Bare satellite with minimal TPS.
const mhf = Number.isFinite(p.maxHeatFlux) ? p.maxHeatFlux : 20000;
document.getElementById('pl-maxHeatFlux').value = mhf;
document.getElementById('payloadEditorEmpty').style.display = 'none';
document.getElementById('payloadEditorForm').style.display = '';
  renderPayloadList();
}

function closePayloadEditor() {
  editingPayloadId = null;
  document.getElementById('payloadEditorForm').style.display = 'none';
  document.getElementById('payloadEditorEmpty').style.display = '';
  renderPayloadList();
}

function handlePayloadSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('pl-name').value.trim() || 'Unnamed Payload';
  const mass = parseFloat(document.getElementById('pl-mass').value);
  const height = parseFloat(document.getElementById('pl-height').value);
  const width = parseFloat(document.getElementById('pl-width').value);
  const dragCd = parseFloat(document.getElementById('pl-dragCd').value);
const maxHeatFlux = parseFloat(document.getElementById('pl-maxHeatFlux').value);
if (![mass, height, width, dragCd].every(Number.isFinite)) {
  document.getElementById('payloadFormError').textContent = 'All fields must be valid numbers.';
  document.getElementById('payloadFormError').classList.add('show');
  return;
}
// maxHeatFlux optional — empty/NaN falls back to 20 kW/m².
const maxHeatFluxSafe = Number.isFinite(maxHeatFlux) && maxHeatFlux >= 0 ? maxHeatFlux : 20000;
document.getElementById('payloadFormError').classList.remove('show');
const payloadData = { name, mass, height, width, dragCd, maxHeatFlux: maxHeatFluxSafe };
if (editingPayloadId) updatePayload(editingPayloadId, payloadData);
else editingPayloadId = addPayload(payloadData).id;
renderPayloadList();
  // Keep editor open — user sees the saved state.
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
  const v = validateStack(s.members, fleet, s);
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
      openStackDetail(s.id); // re-render to update FLYING state
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
    const aboveRec = (i + 1 < s.members.length) ? fleet.find(x => x.id === s.members[i + 1]) : null;
    const ownMass = stackMemberOwnMass(rec, aboveRec || null);
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
  // I-c2: payload specs (visible only when stack has a payload assigned).
  const plFieldset = document.getElementById('sd-payloadFieldset');
  const pl = s.payloadId ? getPayload(s.payloadId) : null;
  if (pl && plFieldset) {
    plFieldset.style.display = '';
    document.getElementById('sd-plName').textContent = pl.name;
    document.getElementById('sd-plMass').textContent = fmtMass(pl.mass);
    document.getElementById('sd-plDims').textContent = `H ${pl.height} m · W ${pl.width} m`;
    document.getElementById('sd-plCd').textContent = pl.dragCd;
  } else if (plFieldset) {
    plFieldset.style.display = 'none';
  }
  renderStackPreview(document.getElementById('stackPreviewCanvas'), s.members, fleet);
  
  document.getElementById('stackEditorEmpty').classList.add('hide');
  document.getElementById('stackEditorForm').classList.remove('show');
  document.getElementById('stackDetail').style.display = '';
  
  renderStackList();
}

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

// SEQ-1b: preset sequence → fixed slot roles (bottom → top). Null = custom.
function presetSlotRoles(sequence) {
  const PRESETS = {
    'f9-standard': ['booster', 'stage', 'payloadSpace'],
    'f9-heavy': ['booster', 'stage', 'stage', 'payloadSpace'],
    'sso': ['booster', 'payloadSpace'],
  };
  return PRESETS[sequence] || null;
}


function openStackEditorNew() {
  const name = prompt('Stack name:', 'New Stack');
  if (name === null) return;
  const seqPrompt = prompt(
    'Sequence preset:\n' +
    '1 = Booster + Stage + Payload\n' +
    '2 = Booster + Stage + Stage + Payload\n' +
    '3 = Booster + Payload\n' +
    '4 = Custom',
    '1'
  );
  if (seqPrompt === null) return;
  const seqMap = { '1': 'f9-standard', '2': 'f9-heavy', '3': 'sso', '4': 'custom' };
  const sequence = seqMap[seqPrompt.trim()] || 'custom';
  
  editingStackId = null;
  workingStackSequence = sequence;
  
  const presetRoles = presetSlotRoles(sequence);
  workingStackMembers = presetRoles ? presetRoles.map(() => null) : [];
  workingStackPayloadId = null;
  
  document.getElementById('stackEditorTitle').textContent = 'New Stack';
  document.getElementById('fs-name').value = name.trim() || 'New Stack';
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
  workingStackSequence = s.sequence || 'custom';
  workingStackMembers = [...s.members];
  workingStackPayloadId = s.payloadId || null;
  
  // SEQ-1b: pad preset stacks with null slots so the fixed sequence shows.
  const presetRoles = presetSlotRoles(workingStackSequence);
  if (presetRoles) {
    while (workingStackMembers.length < presetRoles.length) workingStackMembers.push(null);
    if (workingStackMembers.length > presetRoles.length) workingStackMembers.length = presetRoles.length;
  }
  
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

function renderStackSequenceHint() {
  const el = document.getElementById('stackSequenceHint');
  if (!el) return;
  const hints = {
    'f9-standard': 'Preset: Booster → Stage → Payload Space',
    'f9-heavy': 'Preset: Booster → Stage → Stage → Payload Space',
    'sso': 'Preset: Booster → Payload Space',
  };
  const text = hints[workingStackSequence];
  if (!text) { el.style.display = 'none'; return; }
  el.textContent = text;
  el.style.display = '';
}

function renderStackEditorBody() {
  renderStackSequenceHint();
  renderStackMemberChain();
  refreshAddMemberDropdown();
  renderStackValidation();
  renderStackPayloadField();
}


// I-c1: payload dropdown. Visible only when the stack has a payloadSpace
// member. Incompatible payloads appear greyed-out with reason in the title.
function renderStackPayloadField() {
  const fieldset = document.getElementById('stackPayloadFieldset');
  const sel = document.getElementById('fs-payloadId');
  if (!fieldset || !sel) return;
  const fleet = loadFleet();
  const filledMembers = workingStackMembers.filter(Boolean);
  const hasPayloadSpace = filledMembers.some(id => {
    const r = fleet.find(x => x.id === id);
    return r && r.stageRole === 'payloadSpace';
  });
  if (!hasPayloadSpace) {
    fieldset.style.display = 'none';
    workingStackPayloadId = null;
    return;
  }
  fieldset.style.display = '';
  
  const payloads = loadPayloads();
  if (!payloads.length) {
    sel.innerHTML = '<option value="">— no payloads defined —</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const opts = ['<option value="">— none —</option>'];
  payloads.forEach(p => {
    const check = payloadCompatibilityCheck(p, filledMembers, fleet);
    const dis = !check.ok;
    const title = dis ? check.reasons.join(' · ') : '';
    opts.push(`<option value="${p.id}" ${dis ? 'disabled' : ''} title="${escapeHtml(title)}">${escapeHtml(p.name)}${dis ? ' (incompatible)' : ''}</option>`);
  });
  sel.innerHTML = opts.join('');
  
  // Restore selection if still valid.
  if (workingStackPayloadId && sel.querySelector(`option[value="${workingStackPayloadId}"]:not([disabled])`)) {
    sel.value = workingStackPayloadId;
  } else {
    workingStackPayloadId = null;
    sel.value = '';
  }
  
  // Wire once.
  if (!sel.dataset.wired) {
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => {
      workingStackPayloadId = sel.value || null;
      renderStackEditorBody();
    });
  }
}

function renderStackMemberChain() {
  const host = document.getElementById('stackMemberChain');
  if (!host) return;
  const fleet = loadFleet();
  const n = workingStackMembers.length;
  const presetRoles = presetSlotRoles(workingStackSequence);
  
  if (!n) {
    host.innerHTML = `<div class="stack-member-empty">No members yet — add a booster first (bottom of stack).</div>`;
    return;
  }
  
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const id = workingStackMembers[i];
    const rec = id ? fleet.find(r => r.id === id) : null;
    const isBottom = i === 0;
    const isTop = i === n - 1;
    const expectedRole = presetRoles ? presetRoles[i] : null;
    
    // SEQ-1b: empty preset slot → render placeholder with a slot dropdown.
    if (!rec && expectedRole) {
      const roleLabel = expectedRole.toUpperCase();
      const options = fleet.filter(r => {
        if (r.stageRole !== expectedRole) return false;
        return !workingStackMembers.some((mid, mi) => mi !== i && mid === r.id);
      });
      const opts = options.length ?
        options.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('') :
        '<option value="">— no records available —</option>';
      rows.push(`
        <div class="stack-member-row placeholder">
          <div class="stack-member-body">
            <div class="stack-member-name">
              <span class="badge badge-role ${expectedRole}">${roleLabel}</span>
              &nbsp;<em style="color:var(--dim);font-size:12px;">(slot empty)</em>
            </div>
            <select class="stack-slot-select" data-slot-idx="${i}">
              <option value="">— choose ${roleLabel} —</option>
              ${opts}
            </select>
          </div>
        </div>
      `);
      continue;
    }
    
    // Existing member row.
    const role = rec ? (rec.stageRole || 'rocket') : 'missing';
    const roleClass = role === 'rocket' ? 'rocket-role' : (isBottom ? 'bottom' : (isTop ? 'top' : ''));
    const roleLabel = role === 'missing' ? 'MISSING' : role.toUpperCase();
    const name = rec ? escapeHtml(rec.name) : '(missing fleet record)';
    const aboveId = (i + 1 < n) ? workingStackMembers[i + 1] : null;
    const aboveRec = aboveId ? fleet.find(r => r.id === aboveId) : null;
    const ownMass = rec ? stackMemberOwnMass(rec, aboveRec || null) : NaN;
    const specs = rec ?
      `H ${rec.height} m · W ${rec.width} m · ${fmtMass(ownMass)}` :
      '—';
    const badgeClass = (role === 'rocket' || role === 'missing') ? 'badge-role rocket' : `badge-role ${role}`;
    const canReorder = !presetRoles; // preset slots are fixed-order
    
    rows.push(`
      <div class="stack-member-row ${roleClass}">
        ${canReorder ? `
        <div class="stack-member-reorder">
          <button type="button" class="stack-reorder-btn" data-stack-move="up"   data-idx="${i}" ${isTop ? 'disabled' : ''} title="Move up">▲</button>
          <button type="button" class="stack-reorder-btn" data-stack-move="down" data-idx="${i}" ${isBottom ? 'disabled' : ''} title="Move down">▼</button>
        </div>` : ''}
        <div class="stack-member-body">
          <div class="stack-member-name">
            <span class="${badgeClass}">${roleLabel}</span>
            &nbsp;${name}
          </div>
          <div class="stack-member-specs">${specs}</div>
        </div>
        <button type="button" class="stack-member-remove" data-stack-remove="${i}" title="${presetRoles ? 'Clear slot' : 'Remove'}">✕</button>
      </div>
    `);
  }
  host.innerHTML = rows.join('');
  
  // Wire slot dropdowns (preset mode).
  host.querySelectorAll('[data-slot-idx]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.slotIdx, 10);
      workingStackMembers[idx] = sel.value || null;
      renderStackEditorBody();
    });
  });
  
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
      if (presetRoles) workingStackMembers[idx] = null; // clear slot, keep position
      else workingStackMembers.splice(idx, 1);
      renderStackEditorBody();
    });
  });
}

function refreshAddMemberDropdown() {
  const sel = document.getElementById('fs-addMember');
  if (!sel) return;
  const addBtn = document.getElementById('btnStackAddMember');
  const presetRoles = presetSlotRoles(workingStackSequence);
  
  if (presetRoles) {
    // SEQ-1b: preset stacks have fixed slots — no manual add.
    sel.innerHTML = '<option value="">— preset slots are fixed —</option>';
    sel.disabled = true;
    if (addBtn) addBtn.disabled = true;
    return;
  }
  
  const fleet = loadFleet();
  const n = workingStackMembers.length;
  const topRec = n > 0 ? fleet.find(r => r.id === workingStackMembers[n - 1]) : null;
  // 'nose' was missing from this list originally — the role picker hides
  // the nose role from top-level creation (nose records only exist as
  // additions to a family), but the fleet can still contain nose records,
  // and a custom stack must be able to stack one on top. Both 'nose' and
  // 'payloadSpace' are top-only elements: once one of them is the top
  // member, nothing else can go above it.
  const topIsTopOnly = !!(topRec &&
    (topRec.stageRole === 'payloadSpace' || topRec.stageRole === 'nose'));
  const allowedRoles = n === 0 ? ['booster'] :
    (topIsTopOnly ? [] : ['booster', 'stage', 'payloadSpace', 'nose']);
  
  const options = fleet.filter(r => {
    if (!allowedRoles.includes(r.stageRole)) return false;
    if (workingStackMembers.includes(r.id)) return false;
    return true;
  });
  
  if (!options.length) {
    sel.innerHTML = `<option value="">— no valid members available —</option>`;
    sel.disabled = true;
    if (addBtn) addBtn.disabled = true;
    return;
  }
  sel.disabled = false;
  if (addBtn) addBtn.disabled = false;
  sel.innerHTML = options.map(r =>
    `<option value="${r.id}">${escapeHtml(r.name)} (${(r.stageRole || 'rocket').toUpperCase()}, W ${r.width} m)</option>`
  ).join('');
}

function renderStackValidation() {
  const presetRoles = presetSlotRoles(workingStackSequence);
  if (presetRoles) {
    const unfilled = workingStackMembers.filter(m => !m).length;
    if (unfilled > 0) {
      renderStackValidationInto('stackValidationOutput', {
        valid: false,
        errors: [`${unfilled} slot${unfilled === 1 ? '' : 's'} not yet filled.`],
        stackTotalHeight: 0,
        stackTotalMass: 0,
        memberInfo: [],
      });
      return;
    }
  }
  const filled = workingStackMembers.filter(m => !!m);
  const v = validateStack(filled, loadFleet(), { sequence: workingStackSequence, payloadId: workingStackPayloadId });
  renderStackValidationInto('stackValidationOutput', v);
}

function readStackFormData() {
  return {
    name: document.getElementById('fs-name').value.trim() || 'Unnamed Stack',
    members: workingStackMembers.filter(m => !!m),
    sequence: workingStackSequence,
    payloadId: workingStackPayloadId,
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
  const presetRoles = presetSlotRoles(workingStackSequence);
  if (presetRoles) {
    const unfilled = workingStackMembers.filter(m => !m).length;
    if (unfilled > 0) {
      showStackFormError(`${unfilled} slot${unfilled === 1 ? '' : 's'} still empty.`);
      return;
    }
  }
  const data = readStackFormData();
  if (!data.members.length) { showStackFormError('Add at least one member (a booster).'); return; }
  const v = validateStack(data.members, loadFleet(), { sequence: data.sequence });
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
  const isPayloadSpace = role === 'payloadSpace';
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
  
  // Hardware sections — nose and payloadSpace have none of these.
  if (!isNose && !isPayloadSpace) {
    const engineType = getComponentType(r.engineTypeId);
    renderDetailSection('engine', engineType, r.params, engineType ? `(${engineType.frame.slots.length} engines)` : '');
    renderDetailSection('recovery', getComponentType(r.recoveryTypeId), r.params);
    renderDetailSection('rcs', getComponentType(r.rcsTypeId), r.params);
  } else {
    set('d-engineNote', '—');
    document.getElementById('d-engineList').innerHTML = '';
    set('d-recoveryNote', '—');
    document.getElementById('d-recoveryList').innerHTML = '';
    set('d-rcsNote', '—');
    document.getElementById('d-rcsList').innerHTML = '';
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
    const caps = rocketCapabilities(r); // already handles booster derived path
    set('d-c-thrust', fmtForce(caps.totalMaxThrust));
    set('d-c-wet', fmtMass(caps.wetMass));
    set('d-c-twr', caps.twrMax.toFixed(2));
    set('d-c-dv', caps.deltaV.toFixed(0) + ' m/s');
    set('d-c-burn', caps.burnTimeS.toFixed(0) + ' s');
  } else if (isStage) {
    const d = stageDerivedMasses(r);
    if (!d || d.reason) {
      ['d-sc-fuel', 'd-sc-body', 'd-sc-engines', 'd-sc-payload', 'd-sc-legs', 'd-sc-dry',
        'd-sc-pd', 'd-sc-pt', 'd-sc-pmax', 'd-sc-wet'
      ].forEach(k => set(k, '—'));
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
  
  // Payload-space shape/metal/deployment/colour (standalone role only).
  show('d-payloadSpaceFieldset', isPayloadSpace);
  if (isPayloadSpace) {
    const shapeType = getComponentType(r.payloadSpaceTypeId);
    const metalType = getComponentType(r.payloadSpaceMetalTypeId);
    set('d-psShape', shapeType ? shapeType.displayName : '—');
    set('d-psMetal', metalType ? metalType.displayName : '—');
    set('d-psDeployment', r.deploymentDirection === 'hinge' ? 'Hinged nose' : 'Clamshell (two halves)');
    set('d-psColor', r.color || '#e9edf2');
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
  const summary = infeasible ?
    `Stage is infeasible — no compatible booster can be computed.` :
    `Stage wet mass (at max payload): <b>${fmtMass(d.totalWetMassAtMaxPayload)}</b> · Width: <b>${stage.width} m</b>`;
  
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
    height: 6,
    width: 3.9,
    dragCd: 0.4,
    bodyMetalTypeId: 'al-li-alloy',
    noseCurveness: 1,
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
    role === 'payloadSpace' ? blankPayloadSpaceData() :
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
  
  const hasRec = r.hasRecovery !== false; // default true
  const hasRecEl = document.getElementById('f-hasRecovery');
  if (hasRecEl) hasRecEl.checked = hasRec;
  if (role === 'stage' && r.payloadSpace) {
    setVal('f-payloadSpaceType', r.payloadSpace.typeId);
    setVal('f-payloadSpaceMetalType', r.payloadSpace.metalTypeId);
    setVal('f-payloadSpaceDeployment', r.payloadSpace.deploymentDirection || 'clamshell');
    renderPayloadSpaceParams(r.payloadSpace.typeId, r.payloadSpace.params);
  }
  // BUG #2 FIX: checkbox reflects whether this record actually carries a
  // payload space — a brand-new stage (no r.payloadSpace at all) now
  // correctly starts unchecked instead of forcing one to exist.
  const hasPsEl = document.getElementById('f-hasPayloadSpace');
  if (hasPsEl) {
    const hasPs = role === 'stage' && !!r.payloadSpace;
    hasPsEl.checked = hasPs;
    if (!hasPs) {
      const grid = document.getElementById('payloadSpaceParamsGrid');
      if (grid) grid.innerHTML = '';
    }
  }
  if (role === 'nose') {
    setVal('f-bodyMetalType', r.bodyMetalTypeId || 'al-li-alloy');
    setVal('f-noseCurveness', r.noseCurveness || 0);
  }
if (role === 'payloadSpace') {
  setVal('f-psShapeType', r.payloadSpaceTypeId);
  setVal('f-psMetalType', r.payloadSpaceMetalTypeId);
  setVal('f-psDeployment', r.deploymentDirection || 'clamshell');
  setVal('f-psColor', r.color || '#e9edf2');
  // Stale record pointing at a deleted type (e.g. legacy 'cap-standard')
  // would render an empty grid. Fall back to whatever the select
  // currently has, or to 'cap-bulged' if the select is empty too.
  const validTypeId = (r.payloadSpaceTypeId && getComponentType(r.payloadSpaceTypeId)) ?
    r.payloadSpaceTypeId :
    (document.getElementById('f-psShapeType')?.value || 'cap-bulged');
  renderPsParams(validTypeId, r.params);
  // Deferred re-render: covers the case where this runs before the
  // select got its options on the very first editor open.
  requestAnimationFrame(() => {
    const g = document.getElementById('psParamsGrid');
    if (g && g.children.length === 0) {
      renderPsParams(validTypeId, r.params);
    }
  });
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
  validateBodyDslInput(); // reset any prior error display
  
    if (role === 'booster' || role === 'stage') {
    setVal('f-maxExtraWeight', r.maxExtraWeightKg || 0);
  }
  
  if ((role === 'stage' || role === 'booster') && r.fuel) {
    setVal('f-fuelType', r.fuel.typeId);
    setVal('f-fuelTankHeight', r.fuel.tankHeight);
    setVal('f-fuelTankWidth', r.fuel.tankWidth);
    // Phase 2C-extension: default to 0 baffles / 0.8 inner radius for
    // legacy records that predate these fields.
    setVal('f-baffleCount', Number.isFinite(r.fuel.baffleCount) ? r.fuel.baffleCount : 0);
    setVal('f-baffleInnerRadiusFrac', Number.isFinite(r.fuel.baffleInnerRadiusFrac) ? r.fuel.baffleInnerRadiusFrac : 0.8);
    setVal('f-bodyMetalType', r.bodyMetalTypeId);
  }
  // Legs metal — separate dropdown from body metal now. Real F9 legs are
  // carbon-fibre composite over aluminium honeycomb, so a real F9 build
  // selects 'carbon-composite' here while its airframe stays al-li.
  // Falls back to body metal for pre-fix records (migration preserves the
  // old "legs = body metal" behavior exactly).
  // Legs metal — separate dropdown from body metal now. Real F9 legs are
// carbon-fibre composite over aluminium honeycomb, so a real F9 build
// selects 'carbon-composite' here while its airframe stays al-li.
// Falls back to body metal for pre-fix records (migration preserves the
// old "legs = body metal" behavior exactly).
setVal('f-legsMetalType', r.legsMetalTypeId || r.bodyMetalTypeId || 'carbon-composite');
// Per-record shell factor — role-appropriate default if absent.
const shellF = Number.isFinite(r.bodyShellFactor) ?
  r.bodyShellFactor :
  (DEFAULT_SHELL_FACTOR_BY_ROLE[role] || BODY_SHELL_FACTOR);
setVal('f-bodyShellFactor', shellF);
  applyRoleVisibility(role);
  
  // Deferred safety net: agar upar wale kisi bhi step ne psParamsGrid
  // clear kar diya, ya f-psShapeType ka value populate nahi hua, to
  // ab (jab select ke options available hain) dobara try karo.
  if (role === 'payloadSpace') {
    requestAnimationFrame(() => {
      const grid = document.getElementById('psParamsGrid');
      if (!grid || grid.children.length > 0) return; // already populated, skip
      const shapeSel = document.getElementById('f-psShapeType');
      const fallbackTypeId = (shapeSel && shapeSel.value) || r.payloadSpaceTypeId;
      renderPsParams(fallbackTypeId, r.params);
    });
  }
  
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

// Reads + clamps the body-shell-factor input. Wide physical bound — the
// field's real job is to be user-tunable, not to enforce any particular
// engineering envelope; the clamp is just to keep a NaN/negative from
// silently producing a broken mass.
function clampShellFactor(el) {
  if (!el) return BODY_SHELL_FACTOR;
  const raw = parseFloat(el.value);
  if (!Number.isFinite(raw)) return BODY_SHELL_FACTOR;
  return Math.max(0.0001, Math.min(0.5, raw));
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
  
  // Payload-space (standalone role) early return
  if (role === 'payloadSpace') {
    const typeId = document.getElementById('f-psShapeType').value;
    const metalTypeId = document.getElementById('f-psMetalType').value;
    const deploymentDirection = document.getElementById('f-psDeployment').value;
    const color = document.getElementById('f-psColor').value || '#e9edf2';
    const psParams = currentParamValues('ps');
    // Derive the record's own height/width from the shape params instead
    // of a separate manual field — payloadSpaceDimensions() is the same
    // helper fleet.js/stack-width checks use, so there's exactly one place
    // that knows "capHeight IS the height" / "bulge can exceed capWidth".
    const dims = (typeof payloadSpaceDimensions === 'function') ?
      payloadSpaceDimensions({ stageRole: 'payloadSpace', payloadSpaceTypeId: typeId, params: psParams }) :
      { height: 0, width: 0 };
    return {
  name: document.getElementById('f-name').value.trim() || 'Unnamed Payload Space',
  stageRole: 'payloadSpace',
  height: dims.height,
  width: dims.width,
  dragCd: parseFloat(document.getElementById('f-dragCd').value) || 0.4,
  payloadSpaceTypeId: typeId,
  payloadSpaceMetalTypeId: metalTypeId,
  bodyShellFactor: clampShellFactor(document.getElementById('f-bodyShellFactor')),
  deploymentDirection,
  color,
  // Empty string from the "no chute" option → stored as null.
  chuteTypeId: (document.getElementById('f-chuteType').value) || null,
  params: psParams,
      familyId: editingRecordFamilyId(),
      bodyDesign: {
        mode: document.getElementById('f-bodyDesignMode').value || 'solid',
        solidColor: document.getElementById('f-bodySolidColor').value || '#e9edf2',
        dslText: (document.getElementById('f-bodyDslText').value || '').trim(),
      },
    };
  }
  
  // Stage + booster fuel/metal block
  // Legs metal — applies to rocket / booster / stage (nose and
// payloadSpace early-return above). Read once, before the fuel block,
// so a legacy 'rocket' record round-trips its value too.
const legsMetalEl = document.getElementById('f-legsMetalType');
if (legsMetalEl) data.legsMetalTypeId = legsMetalEl.value;

// Stage + booster fuel/metal block
// Stage + booster fuel/metal block
if (role === 'stage' || role === 'booster') {
  data.bodyShellFactor = clampShellFactor(document.getElementById('f-bodyShellFactor'));
  // Phase 2C-extension: baffleCount and baffleInnerRadiusFrac live on  // the vehicle record (per-vehicle tank hardware), not the fuel type.
  const rawBaffleCount = parseFloat(document.getElementById('f-baffleCount').value);
  const rawBaffleFrac = parseFloat(document.getElementById('f-baffleInnerRadiusFrac').value);
  data.fuel = {
    typeId: document.getElementById('f-fuelType').value,
    tankHeight: parseFloat(document.getElementById('f-fuelTankHeight').value),
    tankWidth: parseFloat(document.getElementById('f-fuelTankWidth').value),
    baffleCount: Number.isFinite(rawBaffleCount) ? Math.max(0, Math.round(rawBaffleCount)) : 0,
    baffleInnerRadiusFrac: Number.isFinite(rawBaffleFrac) ?
      Math.max(0, Math.min(1, rawBaffleFrac)) : 0.8,
  };
  data.bodyMetalTypeId = document.getElementById('f-bodyMetalType').value;
}
  if (role === 'stage') {
    const hasPsEl = document.getElementById('f-hasPayloadSpace');
    const hasPs = hasPsEl ? hasPsEl.checked : false;
    data.payloadSpace = hasPs ? {
      typeId: document.getElementById('f-payloadSpaceType').value,
      metalTypeId: document.getElementById('f-payloadSpaceMetalType').value,
      deploymentDirection: document.getElementById('f-payloadSpaceDeployment').value,
      color: document.getElementById('f-payloadSpaceColor').value || '#e9edf2',
      params: currentParamValues('payload'),
    } : null;
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

// Clamp the RCS offset inputs (rcsTopY / rcsBottomY) to the record's own
// height, so the user cannot type a value larger than the member length.
// Runs on every input change; also limits the input's max attribute.


function applyRcsOffsetCaps() {
  const heightEl = document.getElementById('f-height');
  if (!heightEl) return;
  const H = parseFloat(heightEl.value) || 0;
  if (H <= 0) return;
  ['rcsTopY', 'rcsBottomY'].forEach(key => {
    const inp = document.querySelector(
      `[data-param-key="${key}"][data-param-scope="param"]`
    );
    if (!inp) return;
    inp.max = H;
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v > H) inp.value = H;
    if (Number.isFinite(v) && v < 0) inp.value = 0;
  });
}

function updateCapsPreview() {
  applyRcsOffsetCaps();
  const data = readFormData();
  if (data.stageRole === 'nose') {
    safeRenderPreview(document.getElementById('vehiclePreviewCanvas'), previewVehicleFor(data));
    return;
  }
  if (data.stageRole === 'payloadSpace') {
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
    if (!d) {
      ['c-thrust', 'c-wet', 'c-twr', 'c-dv', 'c-burn'].forEach(k => set(k, '—')); return; }
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
  const reset = () => ['sc-fuel', 'sc-body', 'sc-engines', 'sc-payload', 'sc-legs', 'sc-dry',
      'sc-ve', 'sc-thrust', 'sc-pd', 'sc-pt', 'sc-pmax', 'sc-wet'
    ]
    .forEach(id => set(id, '—'));
  
  const derived = stageDerivedMasses(data);
  if (!derived) { reset(); return; }
  if (derived.reason) { reset();
    set('sc-pmax', derived.reason); return; }
  
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
    showFormError('Propellant mass cannot be negative.');
    return;
  }
  if (data.params && data.params.engineFMinFrac !== undefined && data.params.engineFMinFrac >= 1) {
    showFormError('Throttle floor must be less than 1 (100%).');
    return;
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
  
  const hasPsCb = document.getElementById('f-hasPayloadSpace');
  if (hasPsCb) {
    hasPsCb.addEventListener('change', () => {
      applyPayloadSpaceVisibility(editingRole);
      if (hasPsCb.checked) {
        const typeSel = document.getElementById('f-payloadSpaceType');
        renderPayloadSpaceParams(typeSel ? typeSel.value : null, currentParamValues('payload'));
      }
      updateCapsPreview();
    });
  } else {
    console.warn('f-hasPayloadSpace checkbox missing in rockets.html');
  }
  
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
  // Payloads view bindings.
  document.getElementById('btnNewPayload').addEventListener('click', () => openPayloadEditor(null));
  document.getElementById('btnPayloadCancel').addEventListener('click', closePayloadEditor);
  document.getElementById('payloadEditorForm').addEventListener('submit', handlePayloadSubmit);
  
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