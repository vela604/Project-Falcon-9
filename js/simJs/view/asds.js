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
    // Worker context (guidance worker, worker-sim): no DOM, no toast.
    // Silent no-op — deploy/move must still succeed in worker environments
    // so guidance-driven deploys work.
    if (typeof document === 'undefined') return;
    console.log('[ASDS-TOAST] called:', msg);
    
    let el = document.getElementById('asdsToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'asdsToast';
      // Critical: z-index = max int32 — above EVERYTHING (even FF modal).
      el.style.cssText = [
        'position: fixed',
        'left: 50%',
        'bottom: 32px',
        'transform: translate(-50%, 20px)',
        'z-index: 2147483647',
        'padding: 12px 20px',
        'border-radius: 8px',
        'background: #0d1424',
        'color: #dbe6f5',
        'font-family: "JetBrains Mono", monospace',
        'font-size: 13px',
        'font-weight: 500',
        'box-shadow: 0 12px 32px rgba(0,0,0,0.65)',
        'pointer-events: none',
        'opacity: 0',
        'transition: opacity 0.24s ease, transform 0.24s ease',
        'max-width: 520px',
        'text-align: center',
        'will-change: opacity, transform',
      ].join(' !important;') + ' !important;';
      document.body.appendChild(el);
      console.log('[ASDS-TOAST] element created + appended to body');
    }
    
    el.style.setProperty('border', '1px solid ' + (ok ? '#78afeb' : '#ff5f7e'), 'important');
    el.textContent = msg;
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('transform', 'translate(-50%, 20px)', 'important');
    // Force reflow so the transition kicks in
    void el.offsetHeight;
    void el.offsetWidth;
    // Use rAF — more reliable than immediate setProperty for transitions
    requestAnimationFrame(() => {
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('transform', 'translate(-50%, 0)', 'important');
      console.log('[ASDS-TOAST] shown (opacity=1)');
    });
    
    if (el._hideTimer) clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('transform', 'translate(-50%, 20px)', 'important');
      console.log('[ASDS-TOAST] hidden');
    }, ok ? 2800 : 4200);
  }


  const ASDS_LENGTH_M = 91;
  const ASDS_HALF = ASDS_LENGTH_M / 2;
  // Landing zone center is offset from ship's geometric center because
  // aft (containers + blast wall) occupies the west end.
  // Ship west edge is LZ_WEST_M west of arcOffsetM; east edge is LZ_EAST_M east.
  const LZ_WEST_M = 54;
  const LZ_EAST_M = 37;
  const MIN_GAP_M = 120;
  const LANDING_RADIUS_M = 35;   // usable landing zone half-width
  const DECK_HEIGHT_M = 2;        // deck above sea level (rocket lands here)

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

    // ---- Position: requested, then ±1..±10 km if ocean/gap fail ----
    const zone = _oceanZoneBounds();
    const requestedM = Math.round(km * 1000);
    function validPos(m) {
      if (m - LZ_WEST_M < zone.startM) return false;
      if (m + LZ_EAST_M > zone.endM) return false;
      for (let i = 0; i < existing.length; i++) {
        const gap = Math.abs(m - existing[i].arcOffsetM) - ASDS_LENGTH_M;
        if (gap < MIN_GAP_M) return false;
      }
      return true;
    }
    let appliedM = requestedM;
    let wasPositionAdjusted = false;
    if (!validPos(requestedM)) {
      let found = false;
      for (let d = 1000; d <= 10000; d += 1000) {
        if (validPos(requestedM + d)) { appliedM = requestedM + d; wasPositionAdjusted = true; found = true; break; }
        if (validPos(requestedM - d)) { appliedM = requestedM - d; wasPositionAdjusted = true; found = true; break; }
      }
      if (!found) {
        return {
          ok: false,
          error: 'No valid ASDS position within ±10 km of ' + km + ' km (ocean bounds or 120 m gap conflict).',
          requestedName: name, requestedKm: km, requestedHeightM: heightM,
        };
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

    try { if (typeof refreshFollowBodySelect === 'function') refreshFollowBodySelect(); } catch (e) {}
    try { if (typeof forceRenderResync === 'function') forceRenderResync(); } catch (e) {}

    return {
      ok: true,
      pad: pad,
      requestedName: name,
      appliedName: appliedName,
      requestedKm: km,
      appliedKm: appliedM / 1000,
      requestedHeightM: heightM,
      appliedHeightM: heightM,
      wasNameAdjusted: wasNameAdjusted,
      wasPositionAdjusted: wasPositionAdjusted,
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
      if (result.wasPositionAdjusted) parts.push('(moved from ' + result.requestedKm.toFixed(1) + ' km)');
      _showASDSToast(parts.join(' '), true);
    }
    return result;
  };

  // Expose the toast helper for other modules that need to notify the
  // user without going through deployASDS itself — currently used by
  // workerBridge.js's asdsDeployFailed / asdsMoveFailed handlers when
  // physics rejects a guidance-issued ASDS command.
  window.showASDSToast = _showASDSToast;

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
    try { if (typeof refreshFollowBodySelect === 'function') refreshFollowBodySelect(); } catch (e) {}
    try { if (typeof forceRenderResync === 'function') forceRenderResync(); } catch (e) {}

    return {
      ok: true,
      pad: pad,
      requestedKm: newKm,
      appliedKm: appliedM / 1000,
      wasPositionAdjusted: wasPositionAdjusted,
      oldKm: oldOffset / 1000,
    };
  }

  globalThis.setASDSPosition = setASDSPosition;

  window.listASDS = function () {
    return (CONFIG.LANDING_PADS || [])
      .filter(p => p && (p.isASDS || (Number.isFinite(p.lengthM) && p.lengthM >= 50)))
      .map(p => ({ id: p.id, name: p.name, arcOffsetM: p.arcOffsetM }));
  };

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
      zoneInfo.innerHTML =
        'Deployment zone: <b style="color:#35d6ff;">' + minKm.toFixed(1) + ' – ' + maxKm.toFixed(1) + ' km</b>. ' +
        'Hull: 91 m · Min gap: ' + MIN_GAP_M + ' m.<br>' +
        'Examples: <code>HOPE, 140, 2</code> · <code>HOPE, 140</code> · <code>HOPE</code> · <code>500</code> · <code>(empty)</code>';
    }

    function _parseASDSInput(raw) {
      const s = (raw || '').trim();
      if (!s) return [undefined, undefined, undefined];
      
      // Single value — no comma
      if (s.indexOf(',') === -1) {
        const num = Number(s);
        if (Number.isFinite(num)) {
          // Auto-detect: > 10000 = meters (legacy), else km
          const km = num > 10000 ? num / 1000 : num;
          return [undefined, km, undefined];
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
        if (Number.isFinite(n)) km = n > 10000 ? n / 1000 : n;
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
