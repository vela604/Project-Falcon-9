// ============================================================================
// boot-checks.js — runtime enforcement of ARCHITECTURE.md contracts.
//
// Runs once at sim boot. Non-fatal — logs to console. Any console.error
// here is a real bug: fix the source, don't silence this file.
//
// Load AFTER: guideConfigDefaults.js, guidancePresets.js, guidance.js
// Load BEFORE: any code that depends on the verified state
// ============================================================================
(function bootChecks() {
  const fails = [];
  const warns = [];
  const add = (msg) => fails.push('[ARCH] ' + msg);
  const warn = (msg) => warns.push('[ARCH] ' + msg);

  // ---- Stack type values ----
  const VALID_STACK_TYPES = ['standard', 'legacy', 'heavy', 'sso', 'custom'];

  // ---- Every default preset's stackType must be known ----
  if (typeof GUIDE_DEFAULT_PRESETS === 'object') {
    Object.entries(GUIDE_DEFAULT_PRESETS).forEach(([g, p]) => {
      if (!p || typeof p !== 'object') return;
      if (p.stackType && !VALID_STACK_TYPES.includes(p.stackType)) {
        add('default preset "' + p.name + '" (guide ' + g +
            ') declares unknown stackType "' + p.stackType + '"');
      }
      if (!p.stackType) {
        warn('default preset "' + p.name + '" missing stackType — defaulting to "standard"');
      }
    });
  }

  // ---- Every registered guide should have a default preset ----
  if (typeof Guidance !== 'undefined' && Guidance.listGuides
      && typeof GUIDE_DEFAULT_PRESETS === 'object') {
    const guides = Guidance.listGuides();
    guides.forEach(g => {
      if (!GUIDE_DEFAULT_PRESETS[g]) {
        warn('guide "' + g + '" has no entry in GUIDE_DEFAULT_PRESETS');
      }
    });
  }

  // ---- Every compatibility entry must reference known stack types ----
  if (typeof GUIDE_COMPATIBLE_STACK_TYPES === 'object') {
    Object.entries(GUIDE_COMPATIBLE_STACK_TYPES).forEach(([g, list]) => {
      if (!Array.isArray(list)) return;
      list.forEach(t => {
        if (!VALID_STACK_TYPES.includes(t)) {
          add('GUIDE_COMPATIBLE_STACK_TYPES["' + g + '"] references unknown stack type "' + t + '"');
        }
      });
    });
  }

  // ---- User presets' stackType (if set) must be known ----
  if (typeof loadUserPresets === 'function') {
    try {
      loadUserPresets().forEach(p => {
        if (p.stackType && !VALID_STACK_TYPES.includes(p.stackType)) {
          warn('user preset "' + p.name + '" has unknown stackType "' + p.stackType + '" — will be treated as any-stack');
        }
      });
    } catch (e) { /* storage unavailable */ }
  }

  // ---- Live stacks must have a valid sequence ----
  if (typeof loadStacks === 'function') {
    try {
      loadStacks().forEach(s => {
        if (s.sequence && !VALID_STACK_TYPES.includes(s.sequence)) {
          add('stack "' + s.name + '" has unknown sequence "' + s.sequence + '"');
        }
      });
    } catch (e) { /* storage unavailable */ }
  }

  // ---- Report ----
  if (warns.length) {
    console.warn('%c[ARCH] ' + warns.length + ' warning(s):',
      'color:#ffd23f;font-weight:bold');
    warns.forEach(w => console.warn('  ' + w));
  }
  if (fails.length) {
    console.error('%c[ARCH] ' + fails.length + ' violation(s) — see ARCHITECTURE.md:',
      'color:#ff5f7e;font-weight:bold');
    fails.forEach(f => console.error('  ' + f));
  } else if (!warns.length) {
    console.log('%c[ARCH] ✓ all contracts satisfied',
      'color:#4ade80;font-weight:bold');
  }
})();