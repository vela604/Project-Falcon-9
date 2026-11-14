// ============================================================================
// asds.js — Autonomous Spaceport Drone Ship deployment + validation.
//
// Real ASDS specs (SpaceX Of Course I Still Love You / A Shortfall of Gravitas):
//   - Length: 91 m (300 ft)
//   - Beam:   52 m (170 ft) — irrelevant for 2D side view
//   - Hull depth below waterline: ~5 m (draft)
//   - Freeboard (deck above waterline): ~2 m
//   - Deck landing zone: ~70 × 50 m, center marked with X
//   - Aft containers + steel blast wall
//
// Deployment rules:
//   - Entire ASDS (both hull edges) must be within ocean phi range
//   - Minimum 250 m gap between hull edges of any two ASDS ships
// ============================================================================
(function () {
  'use strict';

  // ============================================================
  // Toast — small bottom-center popup shown on every ASDS deploy.
  // Visible regardless of call source (manual modal, guidance, future
  // API). Auto-dismisses after ~2.8s. Self-created on first call.
  // ============================================================
  function _showASDSToast(msg, ok) {
    // Worker context — no DOM. Silent no-op (guidance worker uses this
    // to satisfy function dependency, actual toast appears on main).
    if (typeof document === 'undefined') return;
    
    let el = document.getElementById('asdsToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'asdsToast';
      el.className = 'asds-toast';
      document.body.appendChild(el);
    }
    
    // Track visibility — if toast is ALREADY visible, just update text
    // and border (NO show-class toggle, NO timer reset mid-animation).
    // This kills the flicker on rapid double-calls.
    const wasVisible = el.classList.contains('show');
    el.textContent = msg;
    el.className = 'asds-toast ' + (ok ? 'asds-toast-ok' : 'asds-toast-err') + (wasVisible ? ' show' : '');
    
    // Clear any pending hide timer
    if (el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }
    
    if (!wasVisible) {
      // Fresh show — force reflow then add 'show' class for CSS transition
      void el.offsetWidth;
      el.classList.add('show');
    }
    
    // Set hide timer (refreshes even when toast was already visible —
    // so user has full duration from LAST call)
    el._hideTimer = setTimeout(function () {
      el.classList.remove('show');
      el._hideTimer = null;
    }, ok ? 2800 : 4200);
  }


  const ASDS_LENGTH_M = 91;
  const ASDS_HALF = ASDS_LENGTH_M / 2;
  // Landing zone center is offset from ship's geometric center because
  // aft (containers + blast wall) occupies the west end.
  // Ship west edge is LZ_WEST_M west of arcOffsetM; east edge is LZ_EAST_M east.
  const LZ_WEST_M = 54;
  const LZ_EAST_M = 37;
  const MIN_GAP_M = 200;
  const LANDING_RADIUS_M = 35;   // usable landing zone half-width
  const DECK_HEIGHT_M = 2;        // deck above sea level (rocket lands here)

  // Earth circumference wrap — like 410° → 50° for angles.
  // If km >= circumference or km < 0, wrap into [0, circumference).
  // Example: 40500 km → 470 km (one full lap + 470 km).
  function _wrapKmAroundEarth(km) {
    const C = 2 * Math.PI * CONFIG.EARTH_RADIUS / 1000;   // km
    if (!Number.isFinite(km)) return { km: km, wasWrapped: false };
    if (km < 0 || km >= C) {
      const wrapped = ((km % C) + C) % C;
      console.log('[ASDS] Wrapped ' + km.toFixed(2) + ' km → ' + wrapped.toFixed(2) +
                  ' km (circumference = ' + C.toFixed(2) + ' km)');
      return { km: wrapped, wasWrapped: true, circumferenceKm: C };
    }
    return { km: km, wasWrapped: false };
  }

  function _oceanZoneBounds() {
    const R = CONFIG.EARTH_RADIUS;
    const startDeg = (typeof CONFIG.OCEAN_ZONE_EAST_START_DEG === 'number') ? CONFIG.OCEAN_ZONE_EAST_START_DEG : 2;
    const endDeg = (typeof CONFIG.OCEAN_ZONE_EAST_END_DEG === 'number') ? CONFIG.OCEAN_ZONE_EAST_END_DEG : 60;
    const startM = startDeg * Math.PI / 180 * R;
    const endM = endDeg * Math.PI / 180 * R;
    return { startM, endM, startDeg, endDeg };
  }

  function _existingASDS() {
    if (!CONFIG.LANDING_PADS) CONFIG.LANDING_PADS = [];
    return CONFIG.LANDING_PADS.filter(p => p && p.isASDS);
  }

  function deployASDS(arg0, arg1, arg2) {
    // Signature: deployASDS(name?, km?, heightM?)
    //   deployASDS()               -> ASDS @ 185 km, height 2 m
    //   deployASDS('HOPE')         -> HOPE @ 185 km, height 2 m
    //   deployASDS('HOPE', 140)    -> HOPE @ 140 km, height 2 m
    //   deployASDS('HOPE', 140, 3) -> HOPE @ 140 km, height 3 m
    // Legacy: deployASDS(xMeters) -> ASDS @ xMeters/1000 km, height 2 m
    let name = 'ASDS', km = 185, heightM = 2;
    if (typeof arg0 === 'number' && arg1 === undefined) {
      km = arg0 / 1000;
    } else {
      if (typeof arg0 === 'string') name = String(arg0).trim() || 'ASDS';
      if (typeof arg1 === 'number') km = arg1;
      if (typeof arg2 === 'number') heightM = arg2;
    }
    if (!Number.isFinite(km)) {
      return { ok: false, error: 'km must be a finite number', requestedName: name, requestedKm: km, requestedHeightM: heightM };
    }
    // Earth circumference wrap — 40500 km becomes 470 km (like 410° → 50°)
    const _originalKm = km;
    const _wrap = _wrapKmAroundEarth(km);
    km = _wrap.km;
    const _wasWrapped = _wrap.wasWrapped;
    if (!Number.isFinite(heightM) || heightM < 0) heightM = 2;

    if (!CONFIG.LANDING_PADS) CONFIG.LANDING_PADS = [];
    const existing = CONFIG.LANDING_PADS.filter(function (p) { return p && p.isASDS; });

    // ---- Name collision: HOPE -> HOPE-1 -> HOPE-2 ... ----
    const takenNames = new Set();
    for (let i = 0; i < CONFIG.LANDING_PADS.length; i++) {
      const p = CONFIG.LANDING_PADS[i];
      if (p && p.name) takenNames.add(p.name);
      if (p && p.id) takenNames.add(p.id);
    }
    let appliedName = name;
    let wasNameAdjusted = false;
    if (takenNames.has(name)) {
      let found = false;
      for (let i = 1; i < 100; i++) {
        const cand = name + '-' + i;
        if (!takenNames.has(cand)) { appliedName = cand; wasNameAdjusted = true; found = true; break; }
      }
      if (!found) {
        return { ok: false, error: 'Could not find a free name based on "' + name + '"', requestedName: name, requestedKm: km, requestedHeightM: heightM };
      }
    }

    // ---- Position policy: new pad deploys at EXACT requested position;
    // ---- existing pads that conflict are shifted to nearest valid spot.
    // Rationale: user may have manual-deployed HOPE @ 328.204, then the
    // guide (or another script) issues deployASDS at the same spot. Under
    // the old ±10km nudge fallback, the new pad moved to 329.204 (1 km
    // east of intended), which made booster aim at the wrong pad. Under
    // the new policy the pre-existing HOPE shifts out of the way and the
    // new pad takes 328.204 exactly. Out-of-ocean-bounds is a physical
    // constraint so it still falls back ±10 km; gap conflicts between
    // existing pads are handled by shifting the OLD pad, not the new one.
    const zone = _oceanZoneBounds();
    const requestedM = Math.round(km * 1000);
    function boundsOk(m) {
      if (m - LZ_WEST_M < zone.startM) return false;
      if (m + LZ_EAST_M > zone.endM) return false;
      return true;
    }
    let appliedM = requestedM;
    let wasPositionAdjusted = false;
    if (!boundsOk(requestedM)) {
      let found = false;
      for (let d = 1000; d <= 10000; d += 1000) {
        if (boundsOk(requestedM + d)) { appliedM = requestedM + d; wasPositionAdjusted = true; found = true; break; }
        if (boundsOk(requestedM - d)) { appliedM = requestedM - d; wasPositionAdjusted = true; found = true; break; }
      }
      if (!found) {
        return {
          ok: false,
          error: 'Requested position ' + (requestedM/1000).toFixed(2) + ' km is outside ocean bounds and no valid ±10 km fallback exists.',
          requestedName: name, requestedKm: km, requestedHeightM: heightM,
        };
      }
    }

    // ---- Shift conflicting existing pads out of the way ----
    const conflicting = existing.filter(function (p) {
      return (Math.abs(appliedM - p.arcOffsetM) - ASDS_LENGTH_M) < MIN_GAP_M;
    });
    const shifts = [];
    if (conflicting.length) {
      const otherPads = [];
      for (let i = 0; i < existing.length; i++) {
        if (conflicting.indexOf(existing[i]) < 0) {
          otherPads.push({ arcOffsetM: existing[i].arcOffsetM, name: existing[i].name });
        }
      }
      otherPads.push({ arcOffsetM: appliedM, name: appliedName });
      // Minimum center-to-center shift = half_hull + MIN_GAP + half_hull = 45.5 + 120 + 45.5 = 211m
      const _MIN_SHIFT_M = Math.round(ASDS_LENGTH_M / 2 + MIN_GAP_M + ASDS_LENGTH_M / 2);
      for (let i = 0; i < conflicting.length; i++) {
        const p = conflicting[i];
        let newM = null;
        for (let d = _MIN_SHIFT_M; d <= 10000; d += 100) {
          let hit = false;
          for (let sgn = 1; sgn >= -1; sgn -= 2) {  // east (+1) first, west (-1) fallback
            const cand = Math.round(p.arcOffsetM + sgn * d);
            if (!boundsOk(cand)) continue;
            let ok = true;
            for (let j = 0; j < otherPads.length; j++) {
              const gap = Math.abs(cand - otherPads[j].arcOffsetM) - ASDS_LENGTH_M;
              if (gap < MIN_GAP_M) { ok = false; break; }
            }
            if (ok) { newM = cand; hit = true; break; }
          }
          if (hit) break;
        }
        if (newM == null) {
          return {
            ok: false,
            error: 'Cannot place ' + appliedName + ' at ' + (appliedM/1000).toFixed(2) +
              ' km — conflicting pad ' + p.name + ' has no valid shift position within ±10 km.',
            requestedName: name, requestedKm: km, requestedHeightM: heightM,
          };
        }
        shifts.push({ id: p.id, name: p.name, oldM: p.arcOffsetM, newM: newM });
        p.arcOffsetM = newM;
        otherPads.push({ arcOffsetM: newM, name: p.name });
      }
    }

    // ---- Deploy ----
    const pad = {
      id: appliedName,
      name: appliedName,
      radiusM: LANDING_RADIUS_M,
      arcOffsetM: appliedM,
      heightM: heightM,
      lengthM: ASDS_LENGTH_M,
      enabled: true,
      isASDS: true,
      lights: false,
    };
    CONFIG.LANDING_PADS.push(pad);

    // ---- Broadcast to other contexts (worker-safe) ----
    // Broadcast shifts FIRST, then the add — consumers see moved pads
    // before the new arrival, no transient 2-pads-at-same-spot.
    for (let i = 0; i < shifts.length; i++) {
      const sh = shifts[i];
      const movedPad = CONFIG.LANDING_PADS.find(function (x) { return x.id === sh.id; });
      if (!movedPad) continue;
      const _mSnap = JSON.parse(JSON.stringify(movedPad));
      try {
        if (typeof WorkerBridge !== 'undefined' && WorkerBridge.send) WorkerBridge.send({ type: 'moveLandingPad', pad: _mSnap });
      } catch (e) { console.warn('[ASDS] shift WorkerBridge failed', e); }
      try {
        if (typeof window !== 'undefined' && window._renderWorker) window._renderWorker.postMessage({ type: 'moveLandingPad', pad: _mSnap });
      } catch (e) { console.warn('[ASDS] shift render failed', e); }
      try {
        if (typeof window !== 'undefined' && window._serenoPool && typeof window._serenoPool.broadcast === 'function') window._serenoPool.broadcast({ type: 'moveLandingPad', pad: _mSnap });
      } catch (e) { console.warn('[ASDS] shift sereno failed', e); }
      try {
        if (typeof importScripts === 'function' && typeof self !== 'undefined' && self.postMessage) self.postMessage({ type: 'moveLandingPad', pad: _mSnap });
      } catch (e) { console.warn('[ASDS] shift self failed', e); }
    }

    const _snap = JSON.parse(JSON.stringify(pad));
    try {
      if (typeof WorkerBridge !== 'undefined' && WorkerBridge.send) {
        WorkerBridge.send({ type: 'addLandingPad', pad: _snap });
      }
    } catch (e) { console.warn('[ASDS] WorkerBridge broadcast failed', e); }
    try {
      if (typeof window !== 'undefined' && window._renderWorker) {
        window._renderWorker.postMessage({ type: 'addLandingPad', pad: _snap });
      }
    } catch (e) { console.warn('[ASDS] render broadcast failed', e); }
    try {
      if (typeof window !== 'undefined' && window._serenoPool && typeof window._serenoPool.broadcast === 'function') {
        window._serenoPool.broadcast({ type: 'addLandingPad', pad: _snap });
      }
    } catch (e) { console.warn('[ASDS] sereno pool broadcast failed', e); }
    // Worker-context broadcast — critical for guidance-triggered deploys.
    // Guidance worker modifies ITS OWN CONFIG; without this, main thread
    // never sees the pad. self.postMessage reaches the parent thread
    // (main.js adds a window 'message' listener to catch it).
    try {
      if (typeof importScripts === 'function' && typeof self !== 'undefined' && self.postMessage) {
        self.postMessage({ type: 'addLandingPad', pad: _snap });
      }
    } catch (e) { console.warn('[ASDS] self.postMessage (add) failed', e); }

    try { if (typeof refreshFollowBodySelect === 'function') refreshFollowBodySelect(); } catch (e) {}
    try { if (typeof forceRenderResync === 'function') forceRenderResync(); } catch (e) {}

    return {
      ok: true,
      pad: pad,
      shifts: shifts,
      requestedName: name,
      appliedName: appliedName,
      requestedKm: _originalKm,
      appliedKm: appliedM / 1000,
      requestedHeightM: heightM,
      appliedHeightM: heightM,
      wasNameAdjusted: wasNameAdjusted,
      wasPositionAdjusted: wasPositionAdjusted || _wasWrapped,
      wasWrapped: _wasWrapped,
      wrappedFromKm: _wasWrapped ? _originalKm : undefined,
      wrappedToKm: _wasWrapped ? km : undefined,
    };
  }

  // Wrap deployASDS so any caller (modal, guidance, future API) gets
  // the toast — even on validation failure. Single point of notification.
  const _origDeployASDS = deployASDS;
  globalThis.deployASDS = function (arg0, arg1, arg2) {
    const result = _origDeployASDS(arg0, arg1, arg2);
    if (result && !result.ok && result.error) {
      _showASDSToast('⚠ ' + result.error, false);
    } else if (result && result.ok) {
      const parts = ['🛳 ' + result.appliedName + ' @ ' + result.appliedKm.toFixed(1) + ' km'];
      if (result.wasNameAdjusted) parts.push('(renamed from ' + result.requestedName + ')');
      if (result.wasWrapped) parts.push('(wrapped from ' + result.wrappedFromKm.toFixed(1) + ' km)');
      else if (result.wasPositionAdjusted) parts.push('(moved from ' + result.requestedKm.toFixed(1) + ' km)');
      if (result.shifts && result.shifts.length) {
        for (let i = 0; i < result.shifts.length; i++) {
          const sh = result.shifts[i];
          const _dm = sh.newM - sh.oldM;
          parts.push(sh.name + ' shifted to ' + (sh.newM / 1000).toFixed(1) + ' km (' + (_dm >= 0 ? '+' : '') + (_dm / 1000).toFixed(1) + ' km)');
        }
      }
      _showASDSToast(parts.join(', '), true);
    }
    return result;
  };

  // Expose the toast helper for other modules that need to notify the
  // user without going through deployASDS itself — currently used by
  // workerBridge.js's asdsDeployFailed / asdsMoveFailed handlers when
  // physics rejects a guidance-issued ASDS command.
  if (typeof window !== 'undefined') window.showASDSToast = _showASDSToast;
  // Worker fallback — expose on globalThis (worker's window is undefined)
  if (typeof globalThis !== 'undefined') globalThis.showASDSToast = _showASDSToast;

  // ============================================================
  // Internal command: setASDSPosition(padId, newXOffsetM)
  // Change an existing ASDS ship's downrange position.
  // SILENT (no toast) — designed for tuner engine batch calls.
  // Validates ocean bounds + 250m gap (self excluded from gap check).
  // ============================================================
  function setASDSPosition(padIdOrName, newKm) {
    if (typeof padIdOrName !== 'string') {
      return { ok: false, error: 'pad id/name must be a string.' };
    }
    const pad = (CONFIG.LANDING_PADS || []).find(function (p) {
      return p && (p.id === padIdOrName || p.name === padIdOrName);
    });
    if (!pad) return { ok: false, error: 'Pad "' + padIdOrName + '" not found.' };
    const isASDS = !!(pad.isASDS || (Number.isFinite(pad.lengthM) && pad.lengthM >= 50));
    if (!isASDS) return { ok: false, error: 'Pad "' + padIdOrName + '" is not an ASDS.' };
    if (!Number.isFinite(newKm)) return { ok: false, error: 'newKm must be a finite number.' };

    // Earth circumference wrap (same as deployASDS)
    const _originalNewKm = newKm;
    const _wrap = _wrapKmAroundEarth(newKm);
    newKm = _wrap.km;
    const _wasWrapped = _wrap.wasWrapped;

    const xM = Math.round(newKm * 1000);
    const zone = _oceanZoneBounds();
    const others = _existingASDS().filter(function (p) { return p !== pad; });
    function validPos(m) {
      if (m - LZ_WEST_M < zone.startM) return false;
      if (m + LZ_EAST_M > zone.endM) return false;
      for (let i = 0; i < others.length; i++) {
        const gap = Math.abs(m - others[i].arcOffsetM) - ASDS_LENGTH_M;
        if (gap < MIN_GAP_M) return false;
      }
      return true;
    }
    let appliedM = xM;
    let wasPositionAdjusted = false;
    if (!validPos(xM)) {
      let found = false;
      for (let d = 1000; d <= 10000; d += 1000) {
        if (validPos(xM + d)) { appliedM = xM + d; wasPositionAdjusted = true; found = true; break; }
        if (validPos(xM - d)) { appliedM = xM - d; wasPositionAdjusted = true; found = true; break; }
      }
      if (!found) {
        return { ok: false, error: 'No valid ASDS position within ±10 km of ' + newKm + ' km.', requestedKm: newKm };
      }
    }
    const oldOffset = pad.arcOffsetM;
    pad.arcOffsetM = appliedM;

    const _snap = JSON.parse(JSON.stringify(pad));
    try { if (typeof WorkerBridge !== 'undefined' && WorkerBridge.send) WorkerBridge.send({ type: 'moveLandingPad', pad: _snap }); } catch (e) {}
    try { if (typeof window !== 'undefined' && window._renderWorker) window._renderWorker.postMessage({ type: 'moveLandingPad', pad: _snap }); } catch (e) {}
    try { if (typeof window !== 'undefined' && window._serenoPool && typeof window._serenoPool.broadcast === 'function') window._serenoPool.broadcast({ type: 'moveLandingPad', pad: _snap }); } catch (e) {}
    try { if (typeof importScripts === 'function' && typeof self !== 'undefined' && self.postMessage) self.postMessage({ type: 'moveLandingPad', pad: _snap }); } catch (e) {}
    try { if (typeof refreshFollowBodySelect === 'function') refreshFollowBodySelect(); } catch (e) {}
    try { if (typeof forceRenderResync === 'function') forceRenderResync(); } catch (e) {}

    return {
      ok: true,
      pad: pad,
      requestedKm: _originalNewKm,
      appliedKm: appliedM / 1000,
      wasPositionAdjusted: wasPositionAdjusted || _wasWrapped,
      wasWrapped: _wasWrapped,
      wrappedFromKm: _wasWrapped ? _originalNewKm : undefined,
      wrappedToKm: _wasWrapped ? newKm : undefined,
      oldKm: oldOffset / 1000,
    };
  }

  globalThis.setASDSPosition = setASDSPosition;

  const _listASDS = function () {
    return (CONFIG.LANDING_PADS || [])
      .filter(function (p) { return p && (p.isASDS || (Number.isFinite(p.lengthM) && p.lengthM >= 50)); })
      .map(function (p) { return { id: p.id, name: p.name, arcOffsetM: p.arcOffsetM }; });
  };
  if (typeof window !== 'undefined') window.listASDS = _listASDS;
  if (typeof globalThis !== 'undefined') globalThis.listASDS = _listASDS;

  // ---------------------------------------------------------------
  // Modal wiring
  // ---------------------------------------------------------------
  function _initASDSModal() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('asdsModal');
    const btn = document.getElementById('btnDeployASDS');
    const input = document.getElementById('asdsOffsetInput');
    const zoneInfo = document.getElementById('asdsZoneInfo');
    const errEl = document.getElementById('asdsError');
    const cancelBtn = document.getElementById('asdsCancelBtn');
    const deployBtn = document.getElementById('asdsDeployBtn');
    if (!modal || !btn || !input || !deployBtn) return;

    function _isGuideActive() {
      return document.body.classList.contains('guide-active');
    }

    function _refreshZoneInfo() {
      const zone = _oceanZoneBounds();
      const minKm = (zone.startM + LZ_WEST_M) / 1000;
      const maxKm = (zone.endM - LZ_EAST_M) / 1000;
      const C = 2 * Math.PI * CONFIG.EARTH_RADIUS / 1000;
      zoneInfo.innerHTML =
        'Deployment zone: <b style="color:#35d6ff;">' + minKm.toFixed(1) + ' – ' + maxKm.toFixed(1) + ' km</b>. ' +
        'Hull: 91 m · Min gap: ' + MIN_GAP_M + ' m.<br>' +
        'Values ≥ ' + C.toFixed(0) + ' km wrap around Earth (like 410° → 50°).<br>' +
        'Examples: <code>HOPE, 140, 2</code> · <code>HOPE, 140</code> · <code>HOPE</code> · <code>500</code> · <code>40500</code> (wraps to ' + (40500 % C).toFixed(0) + ')';
    }

    function _parseASDSInput(raw) {
      const s = (raw || '').trim();
      if (!s) return [undefined, undefined, undefined];
      
      // Single value — no comma
      if (s.indexOf(',') === -1) {
        const num = Number(s);
        if (Number.isFinite(num)) {
          // Always interpret as km (label says km; no meter auto-detect)
          return [undefined, num, undefined];
        }
        return [s, undefined, undefined]; // name only
      }
      
      // Comma-separated: NAME, ARC_KM, HEIGHT_M
      const parts = s.split(',').map(function (p) { return p.trim(); });
      let name;
      if (parts[0]) name = parts[0];
      
      let km;
      if (parts[1]) {
        const n = Number(parts[1]);
        if (Number.isFinite(n)) km = n;
      }
      
      let heightM;
      if (parts[2]) {
        const n = Number(parts[2]);
        if (Number.isFinite(n)) heightM = n;
      }
      
      return [name, km, heightM];
    }

    btn.addEventListener('click', function () {
      if (_isGuideActive()) return;
      modal.style.display = 'block';
      errEl.style.display = 'none';
      _refreshZoneInfo();
      input.focus();
      input.select();
    });

    function _close() {
      modal.style.display = 'none';
      errEl.style.display = 'none';
    }

    cancelBtn.addEventListener('click', _close);

    deployBtn.addEventListener('click', function () {
      if (_isGuideActive()) {
        errEl.textContent = 'Guidance is running — ASDS deployment is locked.';
        errEl.style.display = 'block';
        return;
      }
      const args = _parseASDSInput(input.value);
      const result = window.deployASDS(args[0], args[1], args[2]);
      if (!result.ok) {
        errEl.textContent = result.error;
        errEl.style.display = 'block';
        return;
      }
      _close();
      if (typeof forceRenderResync === 'function') forceRenderResync();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') deployBtn.click();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.style.display === 'block') _close();
    });
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initASDSModal);
    } else {
      _initASDSModal();
    }
  }
})();
