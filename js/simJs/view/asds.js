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
    // DIAGNOSTIC: log to confirm the function is being CALLED. If this
    // line doesn't appear in console, the deploy code path is broken
    // before reaching this. If it appears but toast isn't visible, it's
    // a CSS/stacking issue below.
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
  const MIN_GAP_M = 250;
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

  function deployASDS(xMeters) {
    if (!Number.isFinite(xMeters)) {
      return { ok: false, error: 'Offset must be a finite number.' };
    }
    xMeters = Math.round(xMeters);
    const zone = _oceanZoneBounds();

    // Ocean zone bounds check (with margin so hull edges stay inside)
    const minOffset = zone.startM + LZ_WEST_M;
    const maxOffset = zone.endM - LZ_EAST_M;
    if (xMeters - LZ_WEST_M < zone.startM) {
      return {
        ok: false,
        error: 'Western hull edge would be ' + Math.round(zone.startM - (xMeters - LZ_WEST_M)) +
               ' m outside ocean. Minimum valid offset: ' + Math.round(minOffset) + ' m.'
      };
    }
    if (xMeters + LZ_EAST_M > zone.endM) {
      return {
        ok: false,
        error: 'Eastern hull edge would be ' + Math.round((xMeters + LZ_EAST_M) - zone.endM) +
               ' m outside ocean. Maximum valid offset: ' + Math.round(maxOffset) + ' m.'
      };
    }

    // Distance check against existing ASDS
    const existing = _existingASDS();
    for (let i = 0; i < existing.length; i++) {
      const other = existing[i];
      const centerGap = Math.abs(xMeters - other.arcOffsetM);
      const hullEdgeGap = centerGap - ASDS_LENGTH_M;
      if (hullEdgeGap < MIN_GAP_M) {
        return {
          ok: false,
          error: 'Too close to ' + other.name +
                 '. Hull-edge gap: ' + Math.round(hullEdgeGap) + ' m (minimum: ' + MIN_GAP_M +
                 ' m). Need at least ' + (Math.abs(other.arcOffsetM) + ASDS_LENGTH_M + MIN_GAP_M) +
                 ' m separation from ' + other.name + ' (or ' +
                 Math.max(0, Math.abs(other.arcOffsetM) - ASDS_LENGTH_M - MIN_GAP_M) + ' m on the near side).'
        };
      }
    }

    // Deploy
    const idx = existing.length + 1;
    const pad = {
      id: 'asds-' + idx,
      name: 'ASDS-' + idx,
      radiusM: LANDING_RADIUS_M,
      arcOffsetM: xMeters,
      heightM: DECK_HEIGHT_M,
      lengthM: ASDS_LENGTH_M,
      enabled: true,
      isASDS: true,
      lights: false,
    };
    CONFIG.LANDING_PADS.push(pad);
    // Broadcast to workers — each has its OWN CONFIG instance (loaded
    // via importScripts at worker boot). Without this, ASDS appears on
    // main thread's CONFIG but render/physics workers never see it →
    // planet view shows no marker (LZ-1/2/3 exist at init in all threads,
    // but runtime-added ASDS is invisible to workers).
    const _padSnapshot = JSON.parse(JSON.stringify(pad));
    try {
      if (typeof WorkerBridge !== 'undefined' && WorkerBridge.send) {
        WorkerBridge.send({ type: 'addLandingPad', pad: _padSnapshot });
        console.log('[ASDS] physics worker notified');
      }
    } catch (e) { console.warn('[ASDS] physics broadcast failed', e); }
    try {
      if (window._renderWorker) {
        window._renderWorker.postMessage({ type: 'addLandingPad', pad: _padSnapshot });
        console.log('[ASDS] render worker notified');
      }
    } catch (e) { console.warn('[ASDS] render broadcast failed', e); }
    try {
      if (window._serenoPool && typeof window._serenoPool.broadcast === 'function') {
        const n = window._serenoPool.broadcast({ type: 'addLandingPad', pad: _padSnapshot });
        if (n > 0) console.log('[ASDS] ' + n + ' pool worker(s) notified');
      }
    } catch (e) { console.warn('[ASDS] pool broadcast failed', e); }
    console.log('[ASDS] Pad object:', JSON.stringify(pad));
  console.log('[ASDS] Deployed ' + pad.name + ' at ' + (xMeters / 1000).toFixed(1) +
                ' km downrange (' + Math.round(xMeters / CONFIG.EARTH_RADIUS * 180 / Math.PI).toFixed(2) + '° east)');
    // Refresh follow-body dropdown so the new ASDS appears as a selectable
    // camera target (alongside LZ-1/2/3). Without this the dropdown stays
    // at its old contents until the next state-change event (body count
    // change, FF complete) — user would never see ASDS-1 in the dropdown.
    if (typeof refreshFollowBodySelect === 'function') refreshFollowBodySelect();
    _showASDSToast('🛳 ' + pad.name + ' deployed at ' + (xMeters / 1000).toFixed(1) + ' km', true);
    return { ok: true, pad };
  }

  // Wrap deployASDS so any caller (modal, guidance, future API) gets
  // the toast — even on validation failure. Single point of notification.
  const _origDeployASDS = deployASDS;
  window.deployASDS = function (xMeters) {
    const result = _origDeployASDS(xMeters);
    if (result && !result.ok && result.error) {
      _showASDSToast('⚠ ' + result.error, false);
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
  function setASDSPosition(padId, newXOffsetM) {
    if (typeof padId !== 'string') {
      return { ok: false, error: 'padId must be a string.' };
    }
    const pad = (CONFIG.LANDING_PADS || []).find(p => p.id === padId);
    if (!pad) {
      return { ok: false, error: 'Pad "' + padId + '" not found.' };
    }
    const isASDS = !!(pad.isASDS || (Number.isFinite(pad.lengthM) && pad.lengthM >= 50));
    if (!isASDS) {
      return { ok: false, error: 'Pad "' + padId + '" is not an ASDS.' };
    }
    if (!Number.isFinite(newXOffsetM)) {
      return { ok: false, error: 'newXOffsetM must be a finite number.' };
    }
    newXOffsetM = Math.round(newXOffsetM);
    const zone = _oceanZoneBounds();

    if (newXOffsetM - LZ_WEST_M < zone.startM) {
      return {
        ok: false,
        error: 'Western hull edge would be ' +
               Math.round(zone.startM - (newXOffsetM - LZ_WEST_M)) +
               ' m outside ocean. Minimum offset: ' + Math.round(zone.startM + LZ_WEST_M) + ' m.'
      };
    }
    if (newXOffsetM + LZ_EAST_M > zone.endM) {
      return {
        ok: false,
        error: 'Eastern hull edge would be ' +
               Math.round((newXOffsetM + LZ_EAST_M) - zone.endM) +
               ' m outside ocean. Maximum offset: ' + Math.round(zone.endM - LZ_EAST_M) + ' m.'
      };
    }

    const others = _existingASDS().filter(p => p.id !== padId);
    for (let i = 0; i < others.length; i++) {
      const other = others[i];
      const centerGap = Math.abs(newXOffsetM - other.arcOffsetM);
      const hullEdgeGap = centerGap - ASDS_LENGTH_M;
      if (hullEdgeGap < MIN_GAP_M) {
        return {
          ok: false,
          error: 'Too close to ' + other.name +
                 '. Hull-edge gap: ' + Math.round(hullEdgeGap) + ' m (min: ' + MIN_GAP_M + ' m).'
        };
      }
    }

    const oldOffsetM = pad.arcOffsetM;
    pad.arcOffsetM = newXOffsetM;

    const _padSnapshot = JSON.parse(JSON.stringify(pad));
    try {
      if (typeof WorkerBridge !== 'undefined' && WorkerBridge.send) {
        WorkerBridge.send({ type: 'moveLandingPad', pad: _padSnapshot });
      }
    } catch (e) { console.warn('[ASDS] physics move broadcast failed', e); }
    try {
      if (window._renderWorker) {
        window._renderWorker.postMessage({ type: 'moveLandingPad', pad: _padSnapshot });
      }
    } catch (e) { console.warn('[ASDS] render move broadcast failed', e); }
    try {
      if (window._serenoPool && typeof window._serenoPool.broadcast === 'function') {
        window._serenoPool.broadcast({ type: 'moveLandingPad', pad: _padSnapshot });
      }
    } catch (e) { console.warn('[ASDS] pool move broadcast failed', e); }

    console.log('[ASDS] Moved ' + pad.name + ': ' +
                (oldOffsetM / 1000).toFixed(2) + ' km -> ' +
                (newXOffsetM / 1000).toFixed(2) + ' km');
    return { ok: true, pad };
  }

  window.setASDSPosition = setASDSPosition;

  window.listASDS = function () {
    return (CONFIG.LANDING_PADS || [])
      .filter(p => p && (p.isASDS || (Number.isFinite(p.lengthM) && p.lengthM >= 50)))
      .map(p => ({ id: p.id, name: p.name, arcOffsetM: p.arcOffsetM }));
  };

  // ---------------------------------------------------------------
  // Modal wiring
  // ---------------------------------------------------------------
  function _initASDSModal() {
    const modal = document.getElementById('asdsModal');
    const btn = document.getElementById('btnDeployASDS');
    const input = document.getElementById('asdsOffsetInput');
    const zoneInfo = document.getElementById('asdsZoneInfo');
    const errEl = document.getElementById('asdsError');
    const cancelBtn = document.getElementById('asdsCancelBtn');
    const deployBtn = document.getElementById('asdsDeployBtn');
    if (!modal || !btn || !input || !deployBtn) return;

    function _refreshZoneInfo() {
      const zone = _oceanZoneBounds();
      const minOffset = zone.startM + LZ_WEST_M;
      const maxOffset = zone.endM - LZ_EAST_M;
      zoneInfo.textContent = 'Deployment zone: ' + Math.round(minOffset).toLocaleString() +
        ' – ' + Math.round(maxOffset).toLocaleString() + ' m (' +
        zone.startDeg.toFixed(0) + '° – ' + zone.endDeg.toFixed(0) + '° east). ' +
        'Hull length: 91 m, minimum gap: 250 m between ships.';
      if (Number.isFinite(Number(input.value))) {
        input.min = Math.round(minOffset);
        input.max = Math.round(maxOffset);
      }
    }

    btn.addEventListener('click', () => {
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

    deployBtn.addEventListener('click', () => {
      const x = parseFloat(input.value);
      const result = window.deployASDS(x);
      if (!result.ok) {
        errEl.textContent = result.error;
        errEl.style.display = 'block';
        return;
      }
      _close();
      // Force a redraw so the new ASDS shows immediately even if sim is paused
      if (typeof forceRenderResync === 'function') forceRenderResync();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') deployBtn.click();
    });

    // Escape closes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display === 'block') _close();
    });
  }

  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initASDSModal);
    } else {
      _initASDSModal();
    }
  }
})();
