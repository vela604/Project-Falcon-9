// ============================================================================
// rockets.js — Vehicle Fleet page. All persistence goes through fleet.js
// (localStorage). No page reload needed for CRUD — just re-render.
// ============================================================================

const FIELD_MAP = [
  { id: 'f-height', key: 'height' },
  { id: 'f-width', key: 'width' },
  { id: 'f-dryMass', key: 'dryMass' },
  { id: 'f-fuelMassMax', key: 'fuelMassMax' },
  { id: 'f-octaRadius', key: 'octaRadius' },
  { id: 'f-engineFMax', key: 'engineFMax' },
  { id: 'f-engineFMinFrac', key: 'engineFMinFrac' },
  { id: 'f-engineVe', key: 'engineVe' },
  { id: 'f-engineThrustRate', key: 'engineThrustRate' },
  { id: 'f-gimbalMaxDeg', key: 'gimbalMaxDeg' },
  { id: 'f-gimbalRateDegS', key: 'gimbalRateDegS' },
  { id: 'f-rcsThrust', key: 'rcsThrust' },
  { id: 'f-rcsVe', key: 'rcsVe' },
  { id: 'f-rcsXOffset', key: 'rcsXOffset' },
  { id: 'f-rcsTopMargin', key: 'rcsTopMargin' },
  { id: 'f-rcsBottomMargin', key: 'rcsBottomMargin' },
  { id: 'f-rcsPwmPeriod', key: 'rcsPwmPeriod' },
  { id: 'f-dragCd', key: 'dragCd' },
];

let editingId = null; // null = creating a new (unsaved) vehicle

function fmtMass(kg) { return (kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' t'; }
function fmtForce(n) { return (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' kN'; }

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
    row.className = 'fleet-row' + (r.id === editingId ? ' active' : '');
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
      if (act === 'fly') { setSelectedId(id); renderFleetList(); }
      if (act === 'edit') openEditorFor(id);
      if (act === 'dup') duplicateRocket(id);
      if (act === 'del') deleteRocketFlow(id);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function openEditorFor(id) {
  const fleet = loadFleet();
  const r = fleet.find(v => v.id === id);
  if (!r) return;
  editingId = id;
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
  hideFormError();
}

function showEditor() {
  document.getElementById('editorEmpty').classList.add('hide');
  document.getElementById('editorForm').classList.add('show');
}

function closeEditor() {
  editingId = null;
  document.getElementById('editorForm').classList.remove('show');
  document.getElementById('editorEmpty').classList.remove('hide');
  renderFleetList();
}

function readFormData() {
  const data = { name: document.getElementById('f-name').value.trim() || 'Unnamed Vehicle' };
  FIELD_MAP.forEach(f => { data[f.key] = parseFloat(document.getElementById(f.id).value); });
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
  const valid = FIELD_MAP.every(f => Number.isFinite(data[f.key])) && data.dryMass > 0 && data.engineVe > 0;
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
  if (data.engineFMinFrac >= 1) { showFormError('Throttle floor must be less than 1 (100%).'); return; }
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
  if (editingId === id) closeEditor();
  else renderFleetList();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  renderFleetList();

  document.getElementById('btnNew').addEventListener('click', openEditorNew);
  document.getElementById('btnCancel').addEventListener('click', closeEditor);
  document.getElementById('btnDelete').addEventListener('click', () => editingId && deleteRocketFlow(editingId));
  document.getElementById('btnDuplicate').addEventListener('click', () => editingId && duplicateRocket(editingId));
  document.getElementById('editorForm').addEventListener('submit', handleSubmit);
  document.getElementById('editorForm').addEventListener('input', updateCapsPreview);
});
