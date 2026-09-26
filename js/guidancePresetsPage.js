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

  // Get all guides that have a config API (i.e. that this page cares
// about). Uses the code-resident default-preset registry — every guide
// with a default preset is one the user could tune.
function allConfigurableGuides() {
  return Object.keys(GUIDE_DEFAULT_PRESETS);
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
    return stacks.map(s => ({ id: s.id, name: s.name || s.id }));
  }
  return [{ id: GUIDE_DEFAULT_STACK_ID, name: GUIDE_DEFAULT_STACK_NAME }];
}

// The "active" stack — the one the sim is flying. Reads the selection
// key, resolves it against the stack store, and falls back to the
// first stack (or the code default) if the pointer is stale.
function activeStack() {
  const stacks = listAllStacks();
  const selId = localStorage.getItem(_SEL_STACK_KEY) || '';
  const hit = stacks.find(s => s.id === selId);
  if (hit) return hit;
  return stacks[0] || { id: GUIDE_DEFAULT_STACK_ID, name: GUIDE_DEFAULT_STACK_NAME };
}

  // Active stack from fleet.js — returns null if fleet.js isn't loaded.
  function activeStack() {
    if (typeof getActiveStack !== 'function') return null;
    try { return getActiveStack(); } catch (e) { return null; }
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
      const def = getGuideDefaultPreset(g);
      const users = getUserPresetsForGuide(g);
      let count = (def ? 1 : 0) + users.length;

      // Active-stack filter: keep a guide visible if it (or its default)
      // has any preset bound to the active stack, OR if there are no
      // user presets at all yet (so the user can always add one).
      if (onlyActive && activeId) {
        const matchDefault = def && def.stackId === activeId;
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
    const def = getGuideDefaultPreset(_selectedGuide);
    const users = getUserPresetsForGuide(_selectedGuide);
    $('paneGuideMeta').textContent =
      `${(def ? 1 : 0) + users.length} preset${(def ? 1 : 0) + users.length === 1 ? '' : 's'} ` +
      `· ${users.length} user · ${def ? 1 : 0} default`;

    // Default
    const defSec = $('defaultSection');
    if (def) {
      defSec.innerHTML = '<div class="preset-section-label">Default (protected)</div>';
      defSec.appendChild(renderPresetCard(def, { mode: 'default' }));
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

    // Outdated schema flag — user preset whose constants don't pass
    // strict validation against the current default.
    let outdated = false;
    if (opts.mode === 'user' && typeof validateConstantsStrict === 'function') {
      const def = getGuideDefaultPreset(p.guideName);
      if (def) {
        const v = validateConstantsStrict(p.constants, def.constants);
        if (!v.ok) outdated = true;
      }
    }

    const badges = [];
    if (opts.mode === 'default') badges.push('<span class="preset-badge default">DEFAULT</span>');
    if (p.stackName) badges.push(`<span class="preset-badge stack">${escapeHtml(p.stackName)}</span>`);
    (p.tags || []).forEach(t =>
      badges.push(`<span class="preset-badge tag">${escapeHtml(t)}</span>`));
    if (outdated) badges.push('<span class="preset-badge outdated">OUTDATED SCHEMA</span>');

    card.innerHTML = `
      <div class="preset-head">
        <div>
          <div class="preset-name">${escapeHtml(p.name)}</div>
          <div class="preset-meta">${badges.join('')}</div>
        </div>
      </div>
      ${p.description ? `<div class="preset-desc">${escapeHtml(p.description)}</div>` : ''}
      <div class="preset-actions"></div>
    `;

    const actions = card.querySelector('.preset-actions');
    if (opts.mode === 'default') {
      const copyBtn = mkBtn('Copy', 'btn', () => copyPreset(p.id));
      const cmpBtn  = mkBtn('Compare…', 'btn', () => openDiffPicker(p));
      actions.appendChild(copyBtn);
      actions.appendChild(cmpBtn);
    } else {
      const editBtn = mkBtn('Edit', 'btn', () => openPresetModal(p.id));
      const copyBtn = mkBtn('Copy', 'btn', () => copyPreset(p.id));
      const cmpBtn  = mkBtn('Compare…', 'btn', () => openDiffPicker(p));
      const delBtn  = mkBtn('Delete', 'btn btn-danger', () => deletePreset(p.id));
      actions.appendChild(editBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(cmpBtn);
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
      `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

    // Fill fields
    if (_editingPresetId) {
      const p = getUserPreset(_editingPresetId);
      if (!p) { toast('Preset not found'); return; }
      $('presetModalTitle').textContent = 'Edit Preset';
      $('pmName').value = p.name;
      $('pmDesc').value = p.description || '';
      $('pmTags').value = (p.tags || []).join(', ');
      guideSel.value = p.guideName;
      if (p.stackId) stackSel.value = p.stackId;
      _modalReference = getGuideDefaultPreset(p.guideName)?.constants || null;
      _modalValues = clone(p.constants || {});
      renderModalFields();
    } else {
      $('presetModalTitle').textContent = 'Add Preset';
      $('pmName').value = '';
      $('pmDesc').value = '';
      $('pmTags').value = '';
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
  seen.set(GUIDE_DEFAULT_STACK_ID, { id: GUIDE_DEFAULT_STACK_ID, name: GUIDE_DEFAULT_STACK_NAME });
  const act = activeStack();
  if (act && act.id && !seen.has(act.id)) seen.set(act.id, { id: act.id, name: act.name });
  listAllStacks().forEach(s => {
    if (!seen.has(s.id)) seen.set(s.id, s);
  });
  loadUserPresets().forEach(p => {
    if (p.stackId && !seen.has(p.stackId)) {
      seen.set(p.stackId, { id: p.stackId, name: p.stackName || p.stackId });
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
    const v = validateConstantsStrict(parsed, _modalReference);
    if (!v.ok) {
      $('pmError').textContent = 'Validation: ' + v.error;
      $('pmError').style.display = '';
      return;
    }
    $('pmError').style.display = 'none';
    applyModalValues(parsed);
    $('pmPasteWrap').style.display = 'none';
    toast('Filled from pasted JSON');
  });

  $('presetModalSave').addEventListener('click', () => {
    const name = $('pmName').value.trim();
    const guide = $('pmGuide').value;
    const stackId = $('pmStack').value;
    const stackName = ($('pmStack').selectedOptions[0] || {}).text || stackId;
    if (!name) { $('pmError').textContent = 'Name is required.'; $('pmError').style.display = ''; return; }
    if (!guide) { $('pmError').textContent = 'Guidance is required.'; $('pmError').style.display = ''; return; }
    if (!stackId) { $('pmError').textContent = 'Stack is required.'; $('pmError').style.display = ''; return; }

    const r = readModalValues();
    if (!r.ok) { $('pmError').textContent = 'Invalid value at ' + r.path; $('pmError').style.display = ''; return; }

    const tags = $('pmTags').value.split(',').map(s => s.trim()).filter(Boolean);

    if (_editingPresetId) {
      const u = updateUserPreset(_editingPresetId, {
        name, description: $('pmDesc').value.trim(),
        guideName: guide, stackId, stackName, tags,
        constants: r.values,
      });
      if (!u) { $('pmError').textContent = 'Update failed.'; $('pmError').style.display = ''; return; }
      toast('Saved');
    } else {
      const c = addUserPreset({
        name, description: $('pmDesc').value.trim(),
        guideName: guide, stackId, stackName, tags,
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
    const def = getGuideDefaultPreset(guideName);
    const user = getUserPresetsForGuide(guideName);
    return def ? [def, ...user] : user;
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
  renderStats();
  // Auto-select the first configurable guide so the user sees content
  // immediately on load.
  const guides = allConfigurableGuides();
  if (guides.length) _selectedGuide = guides[0];
  renderSidebar();
  renderMain();

  console.log('[guidancePresetsPage] ready.');
})();