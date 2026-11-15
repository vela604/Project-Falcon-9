// ============================================================================
// guidancePresetsPage.js — page logic for guidance_presets.html.
//
// Loaded after guideConfigDefaults.js + guidancePresets.js. Uses only:
//   - The default-preset registry (guideConfigDefaults.js)
//   - The user-preset storage + validators (guidancePresets.js)
//   - Fleet helpers (getActiveStack) from fleet.js — but fleet.js isn't
//     loaded on this page, so we degrade gracefully if it's missing.
//
// No worker communication — this page never touches the simulation.
// ============================================================================
(function () {
  'use strict';

  // ----------------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  let _toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

// Guides that are LIVE in guidance.js and should appear in this page's
// UI. The full GUIDE_DEFAULT_PRESETS registry still contains old /
// archived guides (leoInsertionV2, ascentAoaHold, predictive*) for
// historical reference, but those aren't registered as active guides
// anymore — showing them here would be misleading.
//
// Extend this list when a new guide becomes the production one.
const _ACTIVE_GUIDES_FULL = ['leoInsertionV3', 'orbitalMissionGNCV1'];
const CURRENT_GUIDES = _ACTIVE_GUIDES_FULL.filter(g => 
  !(typeof GUIDE_HIDDEN_FROM_UI !== 'undefined' && GUIDE_HIDDEN_FROM_UI.has(g)));

// Get all guides that have a config API AND are still current. Used by
// the sidebar, the reference section, and the "Add preset" modal's
// guidance dropdown.
function allConfigurableGuides() {
  return CURRENT_GUIDES.filter(g =>
    Object.prototype.hasOwnProperty.call(GUIDE_DEFAULT_PRESETS, g));
}

// ---------------------------------------------------------------------------
// Local stack helpers — read straight from localStorage instead of
// loading fleet.js (which would drag in componentLibrary.js +
// customDesign.js + config.js just for two array reads).
//
// The keys below are the same ones fleet.js uses. This file only READS
// them; nothing here ever writes to fleet storage.
// ---------------------------------------------------------------------------
const _STACKS_KEY = 'rocketSim.stacks.v1';
const _FLEET_KEY = 'rocketSim.fleet.v1';
const _SEL_STACK_KEY = 'rocketSim.selectedStackId.v1';

function _readLSArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

// All stacks the user has, as { id, name }. Falls back to the code
// default if the stack store is empty (fresh install).
function listAllStacks() {
  const stacks = _readLSArray(_STACKS_KEY);
  if (stacks.length) {
    return stacks.map(s => ({
      id: s.id,
      name: s.name || s.id,
      type: s.sequence || 'custom',
    }));
  }
  return [{ id: GUIDE_DEFAULT_STACK_ID, name: GUIDE_DEFAULT_STACK_NAME, type: 'standard' }];
}

  // The "active" stack — the one the sim is flying. Prefers fleet.js's
  // getActiveStack when available; otherwise reads the selection key
  // straight from localStorage. This page does not load fleet.js, so
  // the localStorage path is the primary one here.
  //
  // (Bug fix: file previously had TWO activeStack() definitions — the
  // second shadowed the first and always returned null since fleet.js
  // is not loaded. The "only active stack" sidebar filter never worked.)
  function activeStack() {
    if (typeof getActiveStack === 'function') {
      try {
        const s = getActiveStack();
        if (s) return s;
      } catch (e) {}
    }
    const stacks = listAllStacks();
    const selId = localStorage.getItem(_SEL_STACK_KEY) || '';
    const hit = stacks.find(s => s.id === selId);
    if (hit) return hit;
    return stacks[0] || { id: GUIDE_DEFAULT_STACK_ID, name: GUIDE_DEFAULT_STACK_NAME };
  }

  // ----------------------------------------------------------------
  // Stats
  // ----------------------------------------------------------------
  function renderStats() {
    const user = loadUserPresets();
    $('statTotalPresets').textContent = user.length;

    const stacks = new Set();
    user.forEach(p => { if (p.stackName) stacks.add(p.stackName); });
    // Also count the default stack, since every default preset is tied
    // to one.
    Object.values(GUIDE_DEFAULT_PRESETS).forEach(d => {
      if (d.stackName) stacks.add(d.stackName);
    });
    $('statStacksCount').textContent = stacks.size;
    $('statStackChips').innerHTML = [...stacks].map(s =>
      `<span class="stat-chip">${escapeHtml(s)}</span>`).join('');

    const guides = new Set();
    user.forEach(p => { if (p.guideName) guides.add(p.guideName); });
    $('statGuidesCount').textContent = guides.size;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

// Reads a target orbit (km ASL) from a preset's constants. Handles both
// the V3 nested path (constants.insertion.TARGET_ORBIT_ALT_KM) and the
// V2 flat path (constants.TARGET_ORBIT_ALT_KM). Returns null if neither
// is a finite number.
function targetOrbitKm(constants) {
  if (!constants) return null;
  const nested = getByPath(constants, 'insertion.TARGET_ORBIT_ALT_KM');
  if (Number.isFinite(nested)) return nested;
  const flat = getByPath(constants, 'TARGET_ORBIT_ALT_KM');
  if (Number.isFinite(flat)) return flat;
  return null;
}

// Formats seconds as HH:MM:SS for the payload deploy tag.
function formatHMS(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return null;
  const s = Math.floor(totalSec);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

  // ----------------------------------------------------------------
  // Sidebar — guidance list
  // ----------------------------------------------------------------
  let _selectedGuide = null;

  function renderSidebar() {
    const host = $('guideList');
    const guides = allConfigurableGuides();
    const onlyActive = $('filterActiveStack').checked;
    const activeStk = activeStack();
    const activeId = activeStk ? activeStk.id : null;

    host.innerHTML = '';
    guides.forEach(g => {
      const defaults = getAllDefaultPresetsForGuide(g);
      const users = getUserPresetsForGuide(g);
      let count = defaults.length + users.length;

      if (onlyActive && activeId) {
        const matchDefault = defaults.some(d => d.stackId === activeId);
        const matchUser = users.some(u => u.stackId === activeId);
        if (!matchDefault && !matchUser) return;
      }

      const item = document.createElement('button');
      item.className = 'guide-item' + (g === _selectedGuide ? ' active' : '');
      item.innerHTML =
        `<span>${escapeHtml(g)}</span><span class="guide-count">${count}</span>`;
      item.addEventListener('click', () => {
        _selectedGuide = g;
        renderSidebar();
        renderMain();
      });
      host.appendChild(item);
    });

    if (!host.children.length) {
      host.innerHTML = '<div style="padding:14px;color:var(--dim);font-size:12px;text-align:center;">No guides match the filter.</div>';
    }
  }

  // ----------------------------------------------------------------
  // Main pane — default + user presets
  // ----------------------------------------------------------------
  function renderMain() {
    if (!_selectedGuide) {
      $('mainEmpty').style.display = '';
      $('mainContent').style.display = 'none';
      return;
    }
    $('mainEmpty').style.display = 'none';
    $('mainContent').style.display = '';

    $('paneGuideName').textContent = _selectedGuide;
    const defaults = getAllDefaultPresetsForGuide(_selectedGuide);
    const users = getUserPresetsForGuide(_selectedGuide);
    const totalCount = defaults.length + users.length;
    $('paneGuideMeta').textContent =
      `${totalCount} preset${totalCount === 1 ? '' : 's'} ` +
      `· ${users.length} user · ${defaults.length} default${defaults.length === 1 ? '' : 's'}`;

    const defSec = $('defaultSection');
    if (defaults.length) {
      defSec.innerHTML = defaults.length > 1
        ? '<div class="preset-section-label">Defaults (protected)</div>'
        : '<div class="preset-section-label">Default (protected)</div>';
      defaults.forEach(d => defSec.appendChild(renderPresetCard(d, { mode: 'default' })));
    } else {
      defSec.innerHTML = '';
    }

    // User
    const userSec = $('userSection');
    userSec.innerHTML = '<div class="preset-section-label">My presets</div>';
    if (!users.length) {
      const empty = document.createElement('div');
      empty.className = 'preset-empty';
      empty.textContent = 'No user presets yet — click "+ Add Preset" to create one.';
      userSec.appendChild(empty);
    } else {
      users.forEach(u => userSec.appendChild(renderPresetCard(u, { mode: 'user' })));
    }
  }

  function renderPresetCard(p, opts) {
    const card = document.createElement('div');
    card.className = 'preset-card' + (opts.mode === 'default' ? ' is-default' : '');

    // Outdated schema flag — user preset whose constants don't match
    // ANY current default for this guide.
    let outdated = false;
    if (opts.mode === 'user' && typeof validateConstantsStrict === 'function') {
      const defs = getAllDefaultPresetsForGuide(p.guideName);
      if (defs.length) {
        const anyMatch = defs.some(d =>
          validateConstantsStrict(p.constants, d.constants).ok);
        outdated = !anyMatch;
      }
    }

        const badges = [];
    if (opts.mode === 'default') badges.push('<span class="preset-badge default">DEFAULT</span>');
    (p.tags || []).forEach(t =>
      badges.push(`<span class="preset-badge tag">${escapeHtml(t)}</span>`));
    if (outdated) badges.push('<span class="preset-badge outdated">OUTDATED SCHEMA</span>');
    
    // Dedicated stack line — this preset is bound to exactly one stack type
    // (and usually one stack name). Show it prominently so the reader knows
    // before trying to apply it elsewhere.
    let stackLine = '';
    if (p.stackName || p.stackType) {
      const parts = [];
      if (p.stackName) parts.push(`<span class="sl-name">${escapeHtml(p.stackName)}</span>`);
      if (p.stackType) parts.push(`<span class="sl-type">${escapeHtml(p.stackType)}</span>`);
      stackLine = `<div class="preset-stackline">Stack: ${parts.join(' ')}</div>`;
    }
// ---- Specs strip — orbit + deploy time, kept OUT of the tag row so
// they read as mission facts, not filterable tags. Rendered as their
// own bordered strip below the name/badge line.
// ---- Specs strip — orbit + MECO + deploy, kept OUT of the tag row
// so they read as mission facts, not filterable tags.
const specs = [];
const orbitKm = targetOrbitKm(p.constants);
if (Number.isFinite(orbitKm)) {
  specs.push(
    `<div class="preset-spec orbit">` +
    `<span class="spec-k">Target orbit</span>` +
    `<span class="spec-v">${orbitKm.toFixed(0)} km</span>` +
    `</div>`
  );
}
const mecoS = Number.isFinite(p.mecoTimeS) ? p.mecoTimeS : null;
if (mecoS != null) {
  const hms = formatHMS(mecoS);
  if (hms) {
    specs.push(
      `<div class="preset-spec meco">` +
      `<span class="spec-k">MECO</span>` +
      `<span class="spec-v">T+${hms}</span>` +
      `</div>`
    );
  }
}
const deployS = Number.isFinite(p.payloadDeployTimeS) ? p.payloadDeployTimeS : null;
if (deployS != null) {
  const hms = formatHMS(deployS);
  if (hms) {
    specs.push(
      `<div class="preset-spec deploy">` +
      `<span class="spec-k">Payload deploy</span>` +
      `<span class="spec-v">T+${hms}</span>` +
      `</div>`
    );
  }
}

card.innerHTML = `
  <div class="preset-head">
    <div>
      <div class="preset-name">${escapeHtml(p.name)}</div>
      <div class="preset-meta">${badges.join('')}</div>
    </div>
  </div>
  ${stackLine}
  ${specs.length ? `<div class="preset-specs">${specs.join('')}</div>` : ''}
  ${p.description ? `<div class="preset-desc">${escapeHtml(p.description)}</div>` : ''}
  <div class="preset-actions"></div>
`;

    const actions = card.querySelector('.preset-actions');
    const _recCount = (typeof getMissionRecordsForPreset === 'function')
      ? getMissionRecordsForPreset(p.id).length : 0;
    const _recLabel = _recCount > 0
      ? '\u{1F4CA} Recorded Data (' + _recCount + ')'
      : '\u{1F4CA} Recorded Data';
    if (opts.mode === 'default') {
      const copyBtn = mkBtn('Copy', 'btn', () => copyPreset(p.id));
      const cmpBtn  = mkBtn('Compare…', 'btn', () => openDiffPicker(p));
      const recBtn  = mkBtn(_recLabel, 'btn', () => openRecordedDataPanel(p));
      actions.appendChild(copyBtn);
      actions.appendChild(cmpBtn);
      actions.appendChild(recBtn);
    } else {
      const editBtn = mkBtn('Edit', 'btn', () => openPresetModal(p.id));
      const copyBtn = mkBtn('Copy', 'btn', () => copyPreset(p.id));
      const cmpBtn  = mkBtn('Compare…', 'btn', () => openDiffPicker(p));
      const recBtn  = mkBtn(_recLabel, 'btn', () => openRecordedDataPanel(p));
      const delBtn  = mkBtn('Delete', 'btn btn-danger', () => deletePreset(p.id));
      actions.appendChild(editBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(cmpBtn);
      actions.appendChild(recBtn);
      actions.appendChild(delBtn);
    }
    return card;
  }

  function mkBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  // Edit-modal reference schema. Starts from the baseline default and
  // merges in any extra keys the preset being edited carries (SERENO
  // FLUX has mission.* / rtls.* that baseline doesn't). Prevents silent
  // drops of those fields on save.
  function _schemaForEdit(guideName, currentConstants) {
    const base = (getGuideDefaultPreset(guideName) || {}).constants || null;
    if (!base) return null;
    if (!currentConstants || typeof currentConstants !== 'object') return base;
    const merged = JSON.parse(JSON.stringify(base));
    function merge(target, source) {
      for (const k in source) {
        const sv = source[k];
        if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
          if (!(k in target) || target[k] === null || typeof target[k] !== 'object') {
            target[k] = {};
          }
          merge(target[k], sv);
        } else if (!(k in target)) {
          target[k] = sv;
        }
      }
    }
    merge(merged, currentConstants);
    return merged;
  }

  // ----------------------------------------------------------------
  // Actions
  // ----------------------------------------------------------------
  function copyPreset(id) {
    const copy = duplicatePreset(id);
    if (!copy) { toast('Copy failed'); return; }
    toast('Created "' + copy.name + '"');
    renderStats();
    renderSidebar();
    renderMain();
    // Straight into the editor so the user can rename / adjust
    openPresetModal(copy.id);
  }

  function deletePreset(id) {
    const p = getUserPreset(id);
    if (!p) return;
    if (!confirm('Delete preset "' + p.name + '"? This cannot be undone.')) return;
    if (deleteUserPreset(id)) {
      toast('Deleted');
      renderStats();
      renderSidebar();
      renderMain();
    } else {
      toast('Delete failed');
    }
  }

  // ----------------------------------------------------------------
  // Add / Edit modal
  // ----------------------------------------------------------------
  let _editingPresetId = null;
  let _modalReference = null;   // schema for the current guide
  let _modalValues    = null;   // live nested values

  function openPresetModal(id) {
    _editingPresetId = id || null;

    // Populate guidance dropdown (all configurable guides)
    const guideSel = $('pmGuide');
    const guides = allConfigurableGuides();
    guideSel.innerHTML = guides.map(g =>
      `<option value="${g}">${g}</option>`).join('');
    guideSel.disabled = !!_editingPresetId;  // locked when editing

    // Populate stack dropdown from known stacks + active stack.
    // Active stack first if present; else fall back to whatever stacks
    // show up in existing presets. Always include the F9 default.
    const stackSel = $('pmStack');
const stacks = collectKnownStacks();
stackSel.innerHTML = stacks.map(s =>
  `<option value="${s.id}" data-stacktype="${escapeHtml(s.type || '')}">${escapeHtml(s.name)}</option>`).join('');

    // Fill fields
    if (_editingPresetId) {
  const p = getUserPreset(_editingPresetId);
  if (!p) { toast('Preset not found'); return; }
  $('presetModalTitle').textContent = 'Edit Preset';
  $('pmName').value = p.name;
  $('pmDesc').value = p.description || '';
  $('pmTags').value = (p.tags || []).join(', ');
  $('pmDeployTime').value = Number.isFinite(p.payloadDeployTimeS) ?
  String(p.payloadDeployTimeS) : '';
$('pmMecoTime').value = Number.isFinite(p.mecoTimeS) ?
  String(p.mecoTimeS) : '';
  guideSel.value = p.guideName;
      if (p.stackId) stackSel.value = p.stackId;
      _modalReference = _schemaForEdit(p.guideName, p.constants);
      _modalValues = clone(p.constants || {});
      renderModalFields();
    } else {
  $('presetModalTitle').textContent = 'Add Preset';
  $('pmName').value = '';
  $('pmDesc').value = '';
  $('pmTags').value = '';
$('pmDeployTime').value = '';
$('pmMecoTime').value = '';
      // Pre-fill guidance with sidebar selection, else first
      guideSel.value = _selectedGuide || guides[0] || '';
      // Pre-fill stack with active, else first
      const act = activeStack();
      if (act && stacks.some(s => s.id === act.id)) stackSel.value = act.id;
      _modalReference = guideSel.value
        ? (getGuideDefaultPreset(guideSel.value)?.constants || null)
        : null;
      _modalValues = _modalReference ? clone(_modalReference) : null;
      renderModalFields();
    }

    $('pmError').style.display = 'none';
    $('pmPasteWrap').style.display = 'none';
    $('presetModal').style.display = 'flex';
    $('pmName').focus();
  }

  function closePresetModal() {
    $('presetModal').style.display = 'none';
    _editingPresetId = null;
    _modalReference = null;
    _modalValues = null;
  }

  // Collect known stacks for the preset modal's stack dropdown:
//   - every stack in the local stack store
//   - every stack id referenced by an existing user preset (covers a
//     preset saved before its stack was renamed or deleted)
//   - the code-default F9 stack (always present)
// Deduped by id, default first, then active, then the rest.
function collectKnownStacks() {
  const seen = new Map();
  seen.set(GUIDE_DEFAULT_STACK_ID, { id: GUIDE_DEFAULT_STACK_ID, name: GUIDE_DEFAULT_STACK_NAME, type: 'standard' });
  const act = activeStack();
  if (act && act.id && !seen.has(act.id)) seen.set(act.id, { id: act.id, name: act.name, type: act.type || 'custom' });
  listAllStacks().forEach(s => {
    if (!seen.has(s.id)) seen.set(s.id, s);
  });
  loadUserPresets().forEach(p => {
    if (p.stackId && !seen.has(p.stackId)) {
      seen.set(p.stackId, { id: p.stackId, name: p.stackName || p.stackId, type: p.stackType || '' });
    }
  });
  return [...seen.values()];
}

  // ---- Render modal constants form ----
  function renderModalFields() {
    const host = $('pmFieldsHost');
    host.innerHTML = '';
    if (!_modalReference) {
      host.innerHTML = '<div class="preset-empty" style="margin-top:12px;">Select a guidance to see its constants.</div>';
      return;
    }
    const important = getGuideImportantFields($('pmGuide').value) || [];
    const impSet = new Set(important);

    if (important.length) {
      const sec = mkCfSection('Important', true, true);
      important.forEach(path => {
        if (getByPath(_modalReference, path) === undefined) return;
        sec.body.appendChild(mkCfField(path));
      });
      host.appendChild(sec.el);
    }

    // Rest grouped by top-level
    const rootScalars = [];
    const objGroups = [];
    for (const k in _modalReference) {
      if (impSet.has(k)) continue;
      const v = _modalReference[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) objGroups.push(k);
      else rootScalars.push(k);
    }
    if (rootScalars.length) {
      const sec = mkCfSection('Root', false, false);
      rootScalars.forEach(k => sec.body.appendChild(mkCfField(k)));
      host.appendChild(sec.el);
    }
    objGroups.forEach(gk => {
      const sec = mkCfSection(gk, false, false);
      const subRef = _modalReference[gk];
      for (const ck in subRef) {
        const childPath = gk + '.' + ck;
        if (impSet.has(childPath)) continue;
        const cv = subRef[ck];
        if (cv !== null && typeof cv === 'object' && !Array.isArray(cv)) {
          const subHead = document.createElement('div');
          subHead.style.gridColumn = '1 / -1';
          subHead.style.fontSize = '10.5px';
          subHead.style.color = 'var(--dim)';
          subHead.style.letterSpacing = '0.6px';
          subHead.style.textTransform = 'uppercase';
          subHead.style.marginTop = '6px';
          subHead.textContent = ck;
          sec.body.appendChild(subHead);
          for (const gck in cv) {
            const deepPath = childPath + '.' + gck;
            if (impSet.has(deepPath)) continue;
            sec.body.appendChild(mkCfField(deepPath));
          }
        } else {
          sec.body.appendChild(mkCfField(childPath));
        }
      }
      host.appendChild(sec.el);
    });
  }

  function mkCfSection(label, isImportant, noToggle) {
    const el = document.createElement('div');
    el.className = 'cf-section' + (isImportant ? ' is-important' : '');
    const header = document.createElement('div');
    header.className = 'cf-section-header';
    header.textContent = label;
    if (!noToggle) {
      header.addEventListener('click', () => {
        el.dataset.collapsed = (el.dataset.collapsed === '1') ? '0' : '1';
      });
    }
    const body = document.createElement('div');
    body.className = 'cf-section-body';
    el.appendChild(header);
    el.appendChild(body);
    return { el, body };
  }

  function mkCfField(path) {
    const refVal = getByPath(_modalReference, path);
    const curVal = getByPath(_modalValues, path);
    const row = document.createElement('div');
    row.className = 'cf-field';
    const lbl = document.createElement('label');
    lbl.textContent = path.split('.').pop();
    lbl.title = path;
    row.appendChild(lbl);
    let inp;
    if (typeof refVal === 'boolean') {
      inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = !!curVal;
      inp.addEventListener('change', () => setByPath(_modalValues, path, !!inp.checked));
    } else if (typeof refVal === 'string') {
      inp = document.createElement('input');
      inp.type = 'text';
      inp.value = curVal != null ? String(curVal) : '';
      inp.addEventListener('input', () => setByPath(_modalValues, path, inp.value));
    } else {
      inp = document.createElement('input');
      inp.type = 'number'; inp.step = 'any';
      inp.value = Number.isFinite(curVal) ? curVal : '';
      inp.dataset.path = path;
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) {
          setByPath(_modalValues, path, v);
          inp.classList.remove('cf-invalid');
        } else {
          inp.classList.add('cf-invalid');
        }
      });
    }
    inp.dataset.path = path;
    row.appendChild(inp);
    return row;
  }

  function applyModalValues(values) {
    _modalValues = clone(values);
    $('pmFieldsHost').querySelectorAll('input[data-path]').forEach(inp => {
      const path = inp.dataset.path;
      const refVal = getByPath(_modalReference, path);
      const v = getByPath(values, path);
      inp.classList.remove('cf-invalid');
      if (typeof refVal === 'boolean') inp.checked = !!v;
      else if (typeof refVal === 'string') inp.value = v != null ? String(v) : '';
      else inp.value = Number.isFinite(v) ? v : '';
    });
  }

  function readModalValues() {
    const out = clone(_modalReference);
    const inputs = $('pmFieldsHost').querySelectorAll('input[data-path]');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      const path = inp.dataset.path;
      const refVal = getByPath(_modalReference, path);
      if (typeof refVal === 'boolean') setByPath(out, path, !!inp.checked);
      else if (typeof refVal === 'string') setByPath(out, path, String(inp.value));
      else {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return { ok: false, path };
        setByPath(out, path, v);
      }
    }
    return { ok: true, values: out };
  }

  // ---- Modal button wiring (done once) ----
  $('presetModalClose').addEventListener('click', closePresetModal);
  $('presetModalCancel').addEventListener('click', closePresetModal);
  $('presetModal').addEventListener('click', (e) => {
    if (e.target === $('presetModal')) closePresetModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('presetModal').style.display === 'flex') closePresetModal();
  });

  $('pmGuide').addEventListener('change', () => {
    if (_editingPresetId) return;   // locked
    const g = $('pmGuide').value;
    _modalReference = getGuideDefaultPreset(g)?.constants || null;
    _modalValues = _modalReference ? clone(_modalReference) : null;
    renderModalFields();
  });

  $('pmLoadDefaults').addEventListener('click', () => {
    if (!_modalReference) return;
    applyModalValues(_modalReference);
    toast('Loaded code defaults into form');
  });

  $('pmPasteJson').addEventListener('click', () => {
    $('pmPasteWrap').style.display = '';
    $('pmPasteText').value = '';
    $('pmPasteText').focus();
  });
  $('pmPasteCancel').addEventListener('click', () => {
    $('pmPasteWrap').style.display = 'none';
  });
  $('pmPasteConfirm').addEventListener('click', () => {
    if (!_modalReference) return;
    let parsed;
    try { parsed = JSON.parse($('pmPasteText').value); }
    catch (e) {
      $('pmError').textContent = 'JSON parse error: ' + e.message;
      $('pmError').style.display = '';
      return;
    }
    let v = validateConstantsStrict(parsed, _modalReference);
    if (!v.ok && _editingPresetId && typeof validateConstantsLenient === 'function') {
      v = validateConstantsLenient(parsed, _modalReference);
    }
    if (!v.ok) {
      $('pmError').textContent = 'Validation: ' + v.error;
      $('pmError').style.display = '';
      return;
    }
    $('pmError').style.display = 'none';
    applyModalValues(v.constants || parsed);
    $('pmPasteWrap').style.display = 'none';
    toast('Filled from pasted JSON');
  });

  $('presetModalSave').addEventListener('click', () => {
    const name = $('pmName').value.trim();
    const guide = $('pmGuide').value;
    const stackSelEl = $('pmStack');
const stackId = stackSelEl.value;
const stackOpt = stackSelEl.selectedOptions[0] || {};
const stackName = stackOpt.text || stackId;
const stackType = (stackOpt.dataset && stackOpt.dataset.stacktype) || '';
if (!name) { $('pmError').textContent = 'Name is required.'; $('pmError').style.display = ''; return; }
    if (!guide) { $('pmError').textContent = 'Guidance is required.'; $('pmError').style.display = ''; return; }
    if (!stackId) { $('pmError').textContent = 'Stack is required.'; $('pmError').style.display = ''; return; }

    const r = readModalValues();
    if (!r.ok) { $('pmError').textContent = 'Invalid value at ' + r.path; $('pmError').style.display = ''; return; }

    const tags = $('pmTags').value.split(',').map(s => s.trim()).filter(Boolean);

// Optional deploy time — blank or invalid input → null (not saved).
// Optional deploy/MECO times — blank or invalid → null (not saved).
const rawDeploy = $('pmDeployTime').value.trim();
let deployTimeS = null;
if (rawDeploy !== '') {
  const parsed = parseFloat(rawDeploy);
  if (!Number.isFinite(parsed) || parsed < 0) {
    $('pmError').textContent = 'Payload deploy time must be a non-negative number of seconds (or blank).';
    $('pmError').style.display = '';
    return;
  }
  deployTimeS = parsed;
}
const rawMeco = $('pmMecoTime').value.trim();
let mecoTimeS = null;
if (rawMeco !== '') {
  const parsed = parseFloat(rawMeco);
  if (!Number.isFinite(parsed) || parsed < 0) {
    $('pmError').textContent = 'MECO time must be a non-negative number of seconds (or blank).';
    $('pmError').style.display = '';
    return;
  }
  mecoTimeS = parsed;
}

if (_editingPresetId) {
  const u = updateUserPreset(_editingPresetId, {
    name, description: $('pmDesc').value.trim(),
    guideName: guide, stackId, stackName, stackType, tags,
    payloadDeployTimeS: deployTimeS,
    mecoTimeS: mecoTimeS,
    constants: r.values,
  });
  if (!u) { $('pmError').textContent = 'Update failed.'; $('pmError').style.display = ''; return; }
  toast('Saved');
} else {
  const c = addUserPreset({
    name, description: $('pmDesc').value.trim(),
    guideName: guide, stackId, stackName, stackType, tags,
    payloadDeployTimeS: deployTimeS,
    mecoTimeS: mecoTimeS,
    constants: r.values,
  });
  if (!c) { $('pmError').textContent = 'Save failed.'; $('pmError').style.display = ''; return; }
  toast('Preset added');
}
    closePresetModal();
    renderStats();
    renderSidebar();
    renderMain();
  });

  // ----------------------------------------------------------------
  // "+ Add Preset" button
  // ----------------------------------------------------------------
  $('btnAddPreset').addEventListener('click', () => openPresetModal(null));

  // ----------------------------------------------------------------
  // Phase 2 — Recorded Data panel
  // Shows all records for the given preset, grouped by env combination.
  // Uses getRecordsGroupedByEnvForPreset() (Phase 1 export).
  // ----------------------------------------------------------------
  function _rdmFormatHMS(sec) {
    if (!Number.isFinite(sec) || sec < 0) return null;
    const s = Math.floor(sec);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  function _rdmEnvLabel(env) {
    if (!env) return 'Unknown environment';
    const parts = [];
    const hasWind = env.wind && env.wind.enabled && Number(env.wind.speed) > 0;
    if (hasWind) {
      parts.push('Wind ' + env.wind.speed + ' m/s @ ' + env.wind.directionDeg + '\u00b0');
    } else {
      parts.push('No wind');
    }
    parts.push(env.atmosphere ? 'Atmosphere' : 'Vacuum');
    if (env.slosh) parts.push('Slosh');
    if (env.imu) parts.push('IMU noise');
    return parts.join(' \u00b7 ');
  }

  function _rdmEnvIcon(env) {
    if (!env) return '?';
    const hasWind = env.wind && env.wind.enabled && Number(env.wind.speed) > 0;
    return hasWind ? '\u{1F32C}' : '\u2600';
  }

  function _rdmRecordCard(rec) {
    const success = rec.success;
    const statusClass = success === true ? 'success' : (success === false ? 'failed' : 'partial');
    const statusText  = success === true ? '\u2713 SUCCESS' : (success === false ? '\u2717 FAILED' : '\u25d0 PARTIAL');

    const captured = rec.metadata && rec.metadata.recordedAt
      ? new Date(rec.metadata.recordedAt).toLocaleString()
      : '\u2014';

    const mecoS    = _rdmFormatHMS(rec.mecoS);
    const landS    = _rdmFormatHMS(rec.boosterLandS);
    const deployS  = _rdmFormatHMS(rec.payloadDeployS);

    const phases = Array.isArray(rec.phases) ? rec.phases : [];
    const events = Array.isArray(rec.events) ? rec.events : [];

    const phasesHtml = phases.map(p => {
      const dur = Number.isFinite(p.durationS) ? '+' + p.durationS.toFixed(1) + 's' : '\u2014';
      return '<div class="rdm-row">'
        + '<span class="rdm-row-label">' + escapeHtml(p.name) + '</span>'
        + '<span class="rdm-row-value">' + dur + '</span>'
        + '</div>';
    }).join('');

    const eventsHtml = events.map(e => {
      const t = _rdmFormatHMS(e.t);
      return '<div class="rdm-row">'
        + '<span class="rdm-row-label">' + escapeHtml(e.name) + '</span>'
        + '<span class="rdm-row-value cyan">' + (t ? 'T+' + t : '\u2014') + '</span>'
        + '</div>';
    }).join('');

    return '<div class="rdm-record">'
      + '<div class="rdm-record-head">'
      + '<span class="rdm-status ' + statusClass + '">' + statusText + '</span>'
      + '<span class="rdm-time">' + escapeHtml(captured) + '</span>'
      + '</div>'
      + '<div class="rdm-timeline">'
      + '<div class="rdm-tl-item">'
      + '<span class="rdm-tl-label">MECO</span>'
      + '<span class="rdm-tl-value' + (mecoS ? '' : ' missing') + '">' + (mecoS ? 'T+' + mecoS : '\u2014') + '</span>'
      + '</div>'
      + '<div class="rdm-tl-item">'
      + '<span class="rdm-tl-label">Booster Land</span>'
      + '<span class="rdm-tl-value' + (landS ? '' : ' missing') + '">' + (landS ? 'T+' + landS : '\u2014') + '</span>'
      + '</div>'
      + '<div class="rdm-tl-item">'
      + '<span class="rdm-tl-label">Payload Deploy</span>'
      + '<span class="rdm-tl-value' + (deployS ? '' : ' missing') + '">' + (deployS ? 'T+' + deployS : '\u2014') + '</span>'
      + '</div>'
      + '</div>'
      + '<button class="rdm-section-btn" type="button">'
      + '<span>Phases (' + phases.length + ')</span>'
      + '<span class="rdm-chevron">\u25b8</span>'
      + '</button>'
      + '<div class="rdm-section-body">' + (phasesHtml || '<em>(no phases captured)</em>') + '</div>'
      + '<button class="rdm-section-btn" type="button">'
      + '<span>Events (' + events.length + ')</span>'
      + '<span class="rdm-chevron">\u25b8</span>'
      + '</button>'
      + '<div class="rdm-section-body">' + (eventsHtml || '<em>(no events captured)</em>') + '</div>'
      + '<div class="rdm-actions">'
      + '<button class="btn" data-copy-record="' + escapeHtml(rec.comboKey || '') + '">Copy JSON</button>'
      + '</div>'
      + '</div>';
  }

  function openRecordedDataPanel(preset) {
    const groups = (typeof getRecordsGroupedByEnvForPreset === 'function')
      ? getRecordsGroupedByEnvForPreset(preset.id) : [];
    const total = groups.reduce((s, g) => s + g.records.length, 0);

    $('recordedDataTitle').textContent = 'RECORDED DATA \u2014 ' + preset.name;
    const body = $('recordedDataBody');

    if (!total) {
      body.innerHTML = '<div class="rdm-empty">'
        + '<strong>No records captured for this preset yet.</strong><br><br>'
        + 'To capture: open <strong>simulation.html</strong>, load this preset from the GCM modal, '
        + 'run a full mission, then click <strong>\u{1F4F8} Record</strong> in the mission phase panel at the end. '
        + 'The record will appear here automatically.'
        + '</div>';
      $('recordedDataModal').style.display = 'flex';
      return;
    }

    const summary = '<div class="rdm-summary">'
      + groups.length + ' environment' + (groups.length === 1 ? '' : 's')
      + ' \u00b7 ' + total + ' record' + (total === 1 ? '' : 's')
      + '</div>';

    const groupsHtml = groups.map(g => {
      const recordsHtml = g.records.map(_rdmRecordCard).join('');
      return '<div class="rdm-env-group">'
        + '<div class="rdm-env-header">'
        + '<span class="rdm-env-label">' + _rdmEnvIcon(g.env) + ' ' + escapeHtml(_rdmEnvLabel(g.env)) + '</span>'
        + '<span class="rdm-env-detail">' + g.records.length + ' record' + (g.records.length === 1 ? '' : 's') + '</span>'
        + '</div>'
        + recordsHtml
        + '</div>';
    }).join('');

    body.innerHTML = summary + groupsHtml;

    // Wire collapsible sections
    body.querySelectorAll('.rdm-section-btn').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('open'));
    });

    // Wire Copy JSON per record
    body.querySelectorAll('[data-copy-record]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-copy-record');
        const allRecs = groups.flatMap(g => g.records);
        const rec = allRecs.find(r => (r.comboKey || '') === key);
        if (!rec) { toast('Record not found'); return; }
        const json = JSON.stringify(rec, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json).then(
            () => toast('Record JSON copied (' + json.length + ' chars)'),
            () => toast('Clipboard write failed')
          );
        } else {
          const ta = document.createElement('textarea');
          ta.value = json;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); toast('Record JSON copied'); }
          catch (e) { toast('Copy failed'); }
          document.body.removeChild(ta);
        }
      });
    });

    $('recordedDataModal').style.display = 'flex';
  }

  // Modal wiring (close handlers)
  if ($('recordedDataClose')) {
    $('recordedDataClose').addEventListener('click', () => { $('recordedDataModal').style.display = 'none'; });
    $('recordedDataCancel').addEventListener('click', () => { $('recordedDataModal').style.display = 'none'; });
    $('recordedDataModal').addEventListener('click', (e) => {
      if (e.target === $('recordedDataModal')) $('recordedDataModal').style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('recordedDataModal').style.display === 'flex') $('recordedDataModal').style.display = 'none';
    });
  }

  // ----------------------------------------------------------------
  // Diff view — minimal path-by-path comparison
  // ----------------------------------------------------------------
  let _diffPendingA = null;

  function openDiffPicker(sourcePreset) {
    // source is one preset; user picks the other from a dropdown shown
    // in the diff modal body.
    _diffPendingA = sourcePreset;
    const others = allPresetsFor(sourcePreset.guideName).filter(p => p.id !== sourcePreset.id);
    const body = $('diffBody');
    if (!others.length) {
      body.innerHTML = '<div class="diff-none">No other presets of this guidance to compare against.</div>';
      $('diffModal').style.display = 'flex';
      return;
    }
    body.innerHTML =
      `<div class="field-label">Compare "<strong>${escapeHtml(sourcePreset.name)}</strong>" against:</div>` +
      `<select class="field-select" id="diffOther">` +
      others.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.isDefault ? ' · DEFAULT' : ''}</option>`).join('') +
      `</select>` +
      `<div id="diffTableHost" style="margin-top:14px;"></div>`;
    $('diffModal').style.display = 'flex';
    const sel = $('diffOther');
    sel.addEventListener('change', () => {
      const other = getPresetById(sel.value);
      if (other) renderDiff(sourcePreset, other);
    });
    renderDiff(sourcePreset, others[0]);
  }

  function allPresetsFor(guideName) {
    const defs = getAllDefaultPresetsForGuide(guideName);
    const user = getUserPresetsForGuide(guideName);
    return [...defs, ...user];
  }

  // Flatten a nested constants object into a Map<path, value>.
  function flatten(obj, prefix, out) {
    out = out || new Map();
    prefix = prefix || '';
    for (const k in obj) {
      const p = prefix ? prefix + '.' + k : k;
      const v = obj[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
      else out.set(p, v);
    }
    return out;
  }

  function renderDiff(a, b) {
    const fa = flatten(a.constants || {});
    const fb = flatten(b.constants || {});
    const paths = new Set([...fa.keys(), ...fb.keys()]);
    const rows = [];
    [...paths].sort().forEach(p => {
      const va = fa.has(p) ? fa.get(p) : undefined;
      const vb = fb.has(p) ? fb.get(p) : undefined;
      let kind;
      if (!fa.has(p)) kind = 'added';
      else if (!fb.has(p)) kind = 'removed';
      else if (va !== vb) kind = 'changed';
      else return;   // skip identical
      rows.push(
        `<tr class="diff-${kind}">` +
        `<td class="path">${escapeHtml(p)}</td>` +
        `<td class="val-a">${formatVal(va)}</td>` +
        `<td class="val-b">${formatVal(vb)}</td>` +
        `</tr>`
      );
    });
    const host = $('diffTableHost');
    if (!rows.length) {
      host.innerHTML = '<div class="diff-none">Identical — no differences.</div>';
      return;
    }
    host.innerHTML =
      `<table class="diff-table"><thead><tr>` +
      `<th>Path</th><th>${escapeHtml(a.name)}</th><th>${escapeHtml(b.name)}</th>` +
      `</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function formatVal(v) {
    if (v === undefined) return '<em>(absent)</em>';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NaN';
    return escapeHtml(String(v));
  }

  $('diffModalClose').addEventListener('click', () => { $('diffModal').style.display = 'none'; });
  $('diffModalCancel').addEventListener('click', () => { $('diffModal').style.display = 'none'; });
  $('diffModal').addEventListener('click', (e) => {
    if (e.target === $('diffModal')) $('diffModal').style.display = 'none';
  });

  // ----------------------------------------------------------------
  // Backup export / import
  // ----------------------------------------------------------------
  $('btnBackupExport').addEventListener('click', () => {
    const backup = exportFullBackup();
    const json = JSON.stringify(backup, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(
        () => { $('backupStatus').textContent = 'Copied ' + backup.presets.length + ' presets to clipboard'; },
        () => { $('backupStatus').textContent = 'Clipboard write failed'; }
      );
    } else {
      // Fallback: download as file
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'rocketSim-guidancePresets.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      $('backupStatus').textContent = 'Downloaded ' + backup.presets.length + ' presets';
    }
  });

  $('btnBackupImport').addEventListener('click', () => {
    $('backupImportText').value = '';
    $('backupImportError').style.display = 'none';
    $('backupImportModal').style.display = 'flex';
    $('backupImportText').focus();
  });
  $('backupImportClose').addEventListener('click', () => { $('backupImportModal').style.display = 'none'; });
  $('backupImportCancel').addEventListener('click', () => { $('backupImportModal').style.display = 'none'; });
  $('backupImportModal').addEventListener('click', (e) => {
    if (e.target === $('backupImportModal')) $('backupImportModal').style.display = 'none';
  });

  $('backupImportConfirm').addEventListener('click', () => {
    const raw = $('backupImportText').value;
    if (!raw.trim()) {
      $('backupImportError').textContent = 'Paste backup JSON first.';
      $('backupImportError').style.display = '';
      return;
    }
    const res = importFullBackup(raw);
    if (!res.ok) {
      $('backupImportError').textContent = res.error;
      $('backupImportError').style.display = '';
      return;
    }
    $('backupImportError').style.display = 'none';
    $('backupImportModal').style.display = 'none';
    const summary = 'Imported ' + res.imported +
      (res.skipped ? ' · skipped ' + res.skipped : '') +
      (res.warnings.length ? ' · ' + res.warnings.length + ' warnings' : '');
    $('backupStatus').textContent = summary;
    if (res.warnings.length) {
      console.warn('[backup import] warnings:', res.warnings);
    }
    toast(summary);
    renderStats();
    renderSidebar();
    renderMain();
  });

  // ----------------------------------------------------------------
  // Filters
  // ----------------------------------------------------------------
  $('filterActiveStack').addEventListener('change', () => {
    renderSidebar();
  });

  // ----------------------------------------------------------------
  // Boot
  // ----------------------------------------------------------------
    // ----------------------------------------------------------------
  // Constants reference section
  // ----------------------------------------------------------------
  // Renders every configurable guide's constants with descriptions from
  // GUIDE_CONSTANT_DESCRIPTIONS. Grouped Important-first (mirrors the
  // modal form), then by top-level parent. Purely read-only.
  //
  // One guide's section auto-opens: whichever guide is selected in the
  // sidebar. Changing the sidebar selection also toggles the reference
  // — a small visual link between the two panels.
  
  function renderReference() {
    const host = $('refGuideList');
    if (!host) return;
    host.innerHTML = '';
    const guides = allConfigurableGuides();
    guides.forEach(g => {
      const descMap = (typeof GUIDE_CONSTANT_DESCRIPTIONS !== 'undefined' &&
        GUIDE_CONSTANT_DESCRIPTIONS[g]) ? GUIDE_CONSTANT_DESCRIPTIONS[g] : {};
      const def = getGuideDefaultPreset(g);
      const schema = def ? def.constants : null;
      const important = (typeof getGuideImportantFields === 'function') ?
        getGuideImportantFields(g) : [];
      const impSet = new Set(important);
      
      const wrapper = document.createElement('div');
      wrapper.className = 'ref-guide' + (g === _selectedGuide ? ' open' : '');
      wrapper.dataset.guide = g;
      
      const header = document.createElement('div');
      header.className = 'ref-guide-header';
      header.innerHTML =
        `<span>${escapeHtml(g)}</span>` +
        `<span class="ref-guide-chevron">▸</span>`;
      header.addEventListener('click', () => {
        wrapper.classList.toggle('open');
      });
      wrapper.appendChild(header);
      
      const body = document.createElement('div');
      body.className = 'ref-guide-body';
      
      // If the guide has no schema, we can't enumerate — show a message.
      if (!schema) {
        body.innerHTML = '<div class="ref-missing">No constants schema registered for this guide.</div>';
        wrapper.appendChild(body);
        host.appendChild(wrapper);
        return;
      }
      
      // ---- Important section ----
      if (important.length) {
        const sec = document.createElement('div');
        sec.className = 'ref-section is-important';
        sec.innerHTML = '<div class="ref-section-label">Important</div>';
        important.forEach(path => {
          if (getByPath(schema, path) === undefined) return;
          sec.appendChild(mkRefRow(path, descMap[path]));
        });
        body.appendChild(sec);
      }
      
      // ---- Root scalars (not in Important) ----
      const rootScalars = [];
      const objectGroups = [];
      for (const k in schema) {
        if (impSet.has(k)) continue;
        const v = schema[k];
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) objectGroups.push(k);
        else rootScalars.push(k);
      }
      
      if (rootScalars.length) {
        const sec = document.createElement('div');
        sec.className = 'ref-section';
        sec.innerHTML = '<div class="ref-section-label">Root</div>';
        rootScalars.forEach(k => sec.appendChild(mkRefRow(k, descMap[k])));
        body.appendChild(sec);
      }
      
      // ---- Object groups ----
      objectGroups.forEach(gk => {
        const subRef = schema[gk];
        const sec = document.createElement('div');
        sec.className = 'ref-section';
        sec.innerHTML = `<div class="ref-section-label">${escapeHtml(gk)}</div>`;
        let emittedAny = false;
        for (const ck in subRef) {
          const childPath = gk + '.' + ck;
          if (impSet.has(childPath)) continue;
          const cv = subRef[ck];
          if (cv !== null && typeof cv === 'object' && !Array.isArray(cv)) {
            // Depth-3 subgroup — its own sub-label
            const subLabel = document.createElement('div');
            subLabel.className = 'ref-section-label';
            subLabel.style.marginTop = '8px';
            subLabel.textContent = ck;
            sec.appendChild(subLabel);
            for (const gck in cv) {
              const deepPath = childPath + '.' + gck;
              if (impSet.has(deepPath)) continue;
              sec.appendChild(mkRefRow(deepPath, descMap[deepPath]));
              emittedAny = true;
            }
          } else {
            sec.appendChild(mkRefRow(childPath, descMap[childPath]));
            emittedAny = true;
          }
        }
        if (emittedAny) body.appendChild(sec);
      });
      
      wrapper.appendChild(body);
      host.appendChild(wrapper);
    });
  }
  
  function mkRefRow(path, description) {
    const row = document.createElement('div');
    row.className = 'ref-row';
    const keyEl = document.createElement('div');
    keyEl.className = 'ref-key';
    keyEl.textContent = path;
    row.appendChild(keyEl);
    const descEl = document.createElement('div');
    descEl.className = 'ref-desc';
    if (description) {
      descEl.textContent = description;
    } else {
      descEl.textContent = '(no description yet)';
      descEl.style.fontStyle = 'italic';
      descEl.style.opacity = '0.55';
    }
    row.appendChild(descEl);
    return row;
  }
  
  // When the sidebar selection changes, keep the reference section in
  // sync — auto-open the selected guide, close the rest.
  const _origRenderMain = renderMain;
  renderMain = function() {
    _origRenderMain();
    const host = $('refGuideList');
    if (!host) return;
    host.querySelectorAll('.ref-guide').forEach(el => {
      el.classList.toggle('open', el.dataset.guide === _selectedGuide);
    });
  };
  
  // ----------------------------------------------------------------
  // Boot
  // ----------------------------------------------------------------
  renderStats();
  const guides = allConfigurableGuides();
  if (guides.length) _selectedGuide = guides[0];
  renderSidebar();
  renderMain();
  renderReference();
  
  console.log('[guidancePresetsPage] ready.');
  })();