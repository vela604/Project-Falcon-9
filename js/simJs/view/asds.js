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
  const ASDS_LENGTH_M = 91;
  const ASDS_HALF = ASDS_LENGTH_M / 2;
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
    const minOffset = zone.startM + ASDS_HALF;
    const maxOffset = zone.endM - ASDS_HALF;
    if (xMeters - ASDS_HALF < zone.startM) {
      return {
        ok: false,
        error: 'Western hull edge would be ' + Math.round(zone.startM - (xMeters - ASDS_HALF)) +
               ' m outside ocean. Minimum valid offset: ' + Math.round(minOffset) + ' m.'
      };
    }
    if (xMeters + ASDS_HALF > zone.endM) {
      return {
        ok: false,
        error: 'Eastern hull edge would be ' + Math.round((xMeters + ASDS_HALF) - zone.endM) +
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
    console.log('[ASDS] Deployed ' + pad.name + ' at ' + (xMeters / 1000).toFixed(1) +
                ' km downrange (' + Math.round(xMeters / CONFIG.EARTH_RADIUS * 180 / Math.PI).toFixed(2) + '° east)');
    return { ok: true, pad };
  }

  window.deployASDS = deployASDS;

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
      const minOffset = zone.startM + ASDS_HALF;
      const maxOffset = zone.endM - ASDS_HALF;
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
      const result = deployASDS(x);
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
