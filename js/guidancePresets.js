// ============================================================================
// guidancePresets.js — storage layer for user-authored guidance presets.
//
// SCOPE:
//   - CRUD over localStorage-backed user presets
//   - Strict validator (full-parity against a reference schema) for Apply /
//     Paste / Import-from-tester paths
//   - Lenient validator (missing / invalid → reference fallback) for the
//     full-backup restore path only
//   - Path helpers for nested access (used by the Important-fields UI)
//   - Full-backup export / import (single JSON with all user presets)
//
// WHAT THIS FILE DOES NOT DO:
//   - Any DOM / UI. That lives in controls.js (sim panel) and the presets
//     page script.
//   - Any worker communication. Preset selection is a purely local
//     operation — the caller resolves a preset to its `constants` bag and
//     hands that to Guidance.applyGuideConfig via the worker bridge.
//   - Any default-preset definition. Those are code-resident in
//     guideConfigDefaults.js and NEVER live in localStorage.
// ============================================================================

const GUIDANCE_PRESETS_KEY = 'rocketSim.guidancePresets.v1';

// ---------------------------------------------------------------------------
// Storage primitives
// ---------------------------------------------------------------------------
function loadUserPresets() {
  try {
    const raw = localStorage.getItem(GUIDANCE_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    console.warn('[guidancePresets] load failed — returning empty', e);
    return [];
  }
}

function saveUserPresets(list) {
  try {
    localStorage.setItem(GUIDANCE_PRESETS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('[guidancePresets] save failed', e);
    return false;
  }
}

function genPresetId() {
  return 'preset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
function getUserPreset(id) {
  return loadUserPresets().find(p => p.id === id) || null;
}

function getUserPresetsForGuide(guideName) {
  return loadUserPresets().filter(p => p.guideName === guideName);
}

// Union of default + user presets for a given guide. Default always first.
// Order within each group is insertion order (default = single, user = chronological).
function getAllPresetsForGuide(guideName) {
  const def = getGuideDefaultPreset(guideName);
  const user = getUserPresetsForGuide(guideName);
  return def ? [def, ...user] : user;
}

// Resolve any preset id (default or user). Returns null if not found.
function getPresetById(id) {
  if (!id) return null;
  if (id.startsWith('default:')) {
    const guideName = id.slice('default:'.length);
    return getGuideDefaultPreset(guideName);
  }
  return getUserPreset(id);
}

function addUserPreset(data) {
  const list = loadUserPresets();
  const now = Date.now();
  const rec = {
    id: genPresetId(),
    name: (data && data.name ? String(data.name).trim() : '') || 'Unnamed Preset',
    description: (data && data.description ? String(data.description).trim() : '') || '',
    guideName: (data && data.guideName) || '',
    stackId: (data && data.stackId) || '',
    stackName: (data && data.stackName) || '',
    tags: Array.isArray(data && data.tags) ? data.tags.map(String) : [],
    constants: (data && data.constants) ? JSON.parse(JSON.stringify(data.constants)) : {},
    createdAt: now,
    updatedAt: now,
    isDefault: false,
  };
  if (!rec.guideName) {
    console.warn('[guidancePresets] addUserPreset: missing guideName, refusing');
    return null;
  }
  list.push(rec);
  saveUserPresets(list);
  return rec;
}

function updateUserPreset(id, patch) {
  const list = loadUserPresets();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return null;
  const merged = { ...list[idx], ...patch, id, isDefault: false, updatedAt: Date.now() };
  // Constants deep-copied so caller's object can't be mutated later
  if (patch.constants) {
    merged.constants = JSON.parse(JSON.stringify(patch.constants));
  }
  list[idx] = merged;
  saveUserPresets(list);
  return merged;
}

function deleteUserPreset(id) {
  const list = loadUserPresets();
  const tgt = list.find(p => p.id === id);
  if (!tgt) return false;
  if (tgt.isDefault) {
    console.warn('[guidancePresets] refusing to delete a default preset');
    return false;
  }
  saveUserPresets(list.filter(p => p.id !== id));
  return true;
}

// Create a "(copy)" of any preset (default or user). Name auto-suffixed;
// if a copy of that name already exists, appends a numeric index.
function duplicatePreset(id) {
  const src = getPresetById(id);
  if (!src) return null;
  const baseName = src.name.replace(/\s*\(\d*\)?\s*$/, '').trim() + ' (copy)';
  const list = loadUserPresets();
  let finalName = baseName;
  let n = 1;
  while (list.some(p => p.name === finalName)) {
    n++;
    finalName = baseName.replace('(copy)', `(copy ${n})`);
  }
  return addUserPreset({
    name: finalName,
    description: src.description,
    guideName: src.guideName,
    stackId: src.stackId,
    stackName: src.stackName,
    tags: [...(src.tags || [])],
    constants: src.constants,
  });
}

// ---------------------------------------------------------------------------
// Path helpers — dot notation for nested keys.
//   getByPath(obj, 'ASCENT.PUSH_T_S')   → obj.ASCENT.PUSH_T_S
//   getByPath(obj, 'MECO_APOGEE_KM')    → obj.MECO_APOGEE_KM
// ---------------------------------------------------------------------------
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setByPath(obj, path, value) {
  if (!obj || !path) return false;
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

// ---------------------------------------------------------------------------
// Type inference — a leaf's expected type is derived from the reference
// value, NOT from the key name. Handles the case (noted during Step 1)
// where a config contains non-number leaves, e.g.
// FAIRING_OPEN_ENABLED: true.
// ---------------------------------------------------------------------------
function _leafTypeOf(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string')  return 'string';
  if (typeof v === 'number')  return 'number';
  if (v === null)             return 'null';
  if (Array.isArray(v))       return 'array';
  return 'object';
}

function _leafOk(value, expected) {
  switch (expected) {
    case 'boolean': return typeof value === 'boolean';
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'null':    return value === null;
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:        return false;
  }
}

// ---------------------------------------------------------------------------
// STRICT VALIDATOR — full-parity against a reference schema.
//
//   - Every reference key must be present in `values` (else missing-path error)
//   - No extra keys allowed (else extra-path error)
//   - Every leaf must match the reference leaf's type
//   - Any failure short-circuits and returns { ok:false, error, path }
//
// Used for: Apply (sim), Paste JSON (sim + presets), Import (tester).
// ---------------------------------------------------------------------------
function validateConstantsStrict(values, reference) {
  if (values === null || values === undefined) {
    return { ok: false, error: 'Values is empty', path: '' };
  }
  if (typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'Values must be a JSON object', path: '' };
  }
  return _strictRecurse(values, reference, '');
}

function _strictRecurse(values, reference, path) {
  // reference may be an object (sub-schema) or a leaf
  const refType = _leafTypeOf(reference);

  if (refType === 'object') {
    // Reference is a nested section → values must also be an object.
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return { ok: false, error: `Expected nested object at "${path || '(root)'}"`, path };
    }
    // Missing keys
    for (const k in reference) {
      if (!(k in values)) {
        const p = path ? path + '.' + k : k;
        return { ok: false, error: `Missing key "${p}"`, path: p };
      }
    }
    // Extra keys
    for (const k in values) {
      if (!(k in reference)) {
        const p = path ? path + '.' + k : k;
        return { ok: false, error: `Unexpected key "${p}"`, path: p };
      }
    }
    // Recurse
    for (const k in reference) {
      const child = path ? path + '.' + k : k;
      const r = _strictRecurse(values[k], reference[k], child);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  // Reference is a leaf.
  if (!_leafOk(values, refType)) {
    return {
      ok: false,
      error: `Value at "${path || '(root)'}" must be ${refType} (got ${_leafTypeOf(values)})`,
      path,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// LENIENT VALIDATOR — same shape, but any missing / extra / invalid value
// silently falls back to the reference (default-preset) value.
//
// Used ONLY for the presets page's full-backup import path (Suggestion 6).
// Returns { ok, constants, warnings:[] }. `ok:false` only when the top-level
// input is unusable (not an object at all).
// ---------------------------------------------------------------------------
function validateConstantsLenient(values, reference) {
  const warnings = [];
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'Values must be a JSON object', warnings };
  }
  const out = _lenientRecurse(values, reference, '', warnings);
  return { ok: true, constants: out, warnings };
}

function _lenientRecurse(values, reference, path, warnings) {
  const refType = _leafTypeOf(reference);

  if (refType === 'object') {
    const src = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
    const out = {};
    for (const k in reference) {
      const child = path ? path + '.' + k : k;
      if (!(k in src)) {
        warnings.push(`Missing "${child}" — using default`);
        out[k] = JSON.parse(JSON.stringify(reference[k]));
      } else {
        out[k] = _lenientRecurse(src[k], reference[k], child, warnings);
      }
    }
    // Extra keys — drop + warn
    if (values && typeof values === 'object') {
      for (const k in values) {
        if (!(k in reference)) {
          const child = path ? path + '.' + k : k;
          warnings.push(`Unknown "${child}" — dropped`);
        }
      }
    }
    return out;
  }

  // Leaf
  if (_leafOk(values, refType)) return values;
  const child = path || '(root)';
  warnings.push(`Invalid "${child}" — using default`);
  return JSON.parse(JSON.stringify(reference));
}

// ---------------------------------------------------------------------------
// FULL BACKUP — single JSON with all user presets. Default presets are
// code-resident and never included.
// ---------------------------------------------------------------------------
function exportFullBackup() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    presets: loadUserPresets(),
  };
}

// Import a full backup. Lenient:
//   - Non-object / missing `presets` array → hard fail
//   - Each preset missing `name` or `guideName` → skipped + warning
//   - Missing / invalid `constants` → filled from that guide's default preset
//   - Extra top-level preset fields → dropped
//   - Replaces the entire user preset list (caller must confirm beforehand)
// Returns { ok, imported, skipped, warnings:[] }
function importFullBackup(raw) {
  const warnings = [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch (e) { return { ok: false, error: 'JSON parse error: ' + e.message, imported: 0, skipped: 0, warnings }; }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) {
    return { ok: false, error: 'Backup must be an object with a "presets" array', imported: 0, skipped: 0, warnings };
  }
  const incoming = [];
  let skipped = 0;
  for (let i = 0; i < parsed.presets.length; i++) {
    const p = parsed.presets[i];
    if (!p || typeof p !== 'object') { skipped++; warnings.push(`Preset #${i + 1}: not an object — skipped`); continue; }
    const guideName = typeof p.guideName === 'string' ? p.guideName : '';
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!guideName || !name) { skipped++; warnings.push(`Preset #${i + 1}: missing name or guideName — skipped`); continue; }

    // Lenient constants fill-in against the guide's default preset schema
    const defaultPreset = getGuideDefaultPreset(guideName);
    let constants;
    if (defaultPreset) {
      const res = validateConstantsLenient(p.constants || {}, defaultPreset.constants);
      if (!res.ok) {
        skipped++;
        warnings.push(`Preset "${name}": constants unusable — skipped`);
        continue;
      }
      constants = res.constants;
      res.warnings.forEach(w => warnings.push(`Preset "${name}": ${w}`));
    } else {
      // Guide not recognised — keep raw constants (best-effort), warn.
      constants = (p.constants && typeof p.constants === 'object') ? p.constants : {};
      warnings.push(`Preset "${name}": unknown guide "${guideName}" — schema unchecked`);
    }

    incoming.push({
      id: genPresetId(),
      name,
      description: typeof p.description === 'string' ? p.description : '',
      guideName,
      stackId: typeof p.stackId === 'string' ? p.stackId : '',
      stackName: typeof p.stackName === 'string' ? p.stackName : '',
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      constants,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isDefault: false,
    });
  }
  saveUserPresets(incoming);
  return { ok: true, imported: incoming.length, skipped, warnings };
}

// ---------------------------------------------------------------------------
// Tag helpers — for the presets page filter chips.
// ---------------------------------------------------------------------------
function getAllUserTags() {
  const set = new Set();
  loadUserPresets().forEach(p => {
    (p.tags || []).forEach(t => set.add(t));
  });
  return [...set].sort();
}