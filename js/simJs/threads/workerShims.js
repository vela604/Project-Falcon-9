// ============================================================================
// workerShims.js — DOM/storage shims for Worker contexts. Lives at
// js/simJs/threads/workerShims.js. Its only consumer is guidance.worker.js
// (physics.worker.js and render.worker.js each inline their own
// localStorage shim rather than importScripts this file).
// ============================================================================
if (typeof localStorage === 'undefined') {
  const _store = Object.create(null);
  globalThis.localStorage = {
    getItem: (k) => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
    clear: () => { for (const k in _store) delete _store[k]; },
    key: (i) => Object.keys(_store)[i] ?? null,
    get length() { return Object.keys(_store).length; },
  };
}