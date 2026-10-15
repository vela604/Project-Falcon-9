// worker-pool.js — manages N Web Worker sim instances.
//
// Usage:
//   const pool = new TunerCore.WorkerPool(4);   // 4 workers
//   await pool.waitReady();
//   const metrics = await pool.runEval(point, { stopAt: 'COAST_WAIT_ENTRY' });
//
// Each worker keeps its own sim instance. Jobs are queued and dispatched to
// the next free worker. Results come back via Promise.
//
// Path resolution: the Worker URL is relative to the page. Default assumes
// the page lives in atlas-prism/ (so 'lib/worker-sim.js' resolves).

(function() {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const T = root.TunerCore = root.TunerCore || {};

  // Resolve worker-sim.js path ONCE at module load time (when document.currentScript
  // is still valid). At constructor time (click handler), currentScript is null.
  const _DEFAULT_WORKER_PATH = (function () {
    try {
      const cur = (typeof document !== 'undefined' && document.currentScript) ? document.currentScript.src : '';
      if (cur) {
        const dir = cur.substring(0, cur.lastIndexOf('/'));
        return dir + '/worker-sim.js';
      }
    } catch (e) {}
    return 'worker-sim.js';
  })();
  
  const LS_KEYS = [
    'rocketSim.fleet.v1', 'rocketSim.selectedId.v1',
    'rocketSim.stacks.v1', 'rocketSim.selectedStackId.v1',
    'rocketSim.families.v1', 'rocketSim.selectedFamilyId.v1',
    'rocketSim.componentLibrary.v1', 'rocketSim.payloads.v1',
    'rocketSim.payloadSplitDone.v1',
  ];
  
  // Main-thread LRU of SA checkpoints. Entry: { snap } (resume point) or { fail } (run ended before SA -> final metrics).
  class SnapStore {
    constructor(max) { this.max = max || 200; this.map = new Map(); }
    get(k) { if (!this.map.has(k)) return undefined; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
    set(k, v) { this.map.delete(k); this.map.set(k, v); while (this.map.size > this.max) { this.map.delete(this.map.keys().next().value); this.evicted++; } }
    clear() { this.map.clear(); }
    get size() { return this.map.size; }
  }
  SnapStore.prototype.evicted = 0;

  class WorkerPool {
    constructor(n, opts) {
      opts = opts || {};
      this.n = Math.max(1, n | 0);
      this.workerPath = opts.workerPath || _DEFAULT_WORKER_PATH;
      this.workers = [];
      this.ready = new Array(this.n).fill(false);
      this.readyErrors = new Array(this.n).fill(null);
      this.available = [];
      this.queue = [];
      this.pending = new Map(); // jobId -> { resolve, reject, type }
      this.nextId = 0;
      this._stats = { dispatched: 0, completed: 0, errored: 0 };
      this.snaps = new SnapStore(opts.snapMax || 200);
      this._saInflight = new Map();
      this.saStats = { build: 0, hit: 0, failHit: 0 };
      this._initPromise = null;
      this._init();
    }
    
    _init() {
      const keys = {};
      LS_KEYS.forEach(k => {
        try { keys[k] = localStorage.getItem(k); } catch (e) { keys[k] = null; }
      });
      
      for (let i = 0; i < this.n; i++) {
        let w;
        try {
          w = new Worker(this.workerPath + (this.workerPath.indexOf('?') < 0 ? '?v=' + Date.now() : ''));   // cache-bust: workers aggressively cache
        } catch (e) {
          this.readyErrors[i] = 'Worker construction failed: ' + e.message;
          continue;
        }
        w.onmessage = (e) => this._onMessage(i, e);
        w.onerror = (err) => {
          this.readyErrors[i] = 'Worker error: ' + (err.message || 'unknown');
          console.error('[WorkerPool] worker ' + i + ' error:', err);
        };
        w.postMessage({ type: 'hydrate', payload: { keys } });
        this.workers.push(w);
      }
    }
    
    _onMessage(i, e) {
      const msg = e.data || {};
      if (msg.type === 'progress') {
        if (this.onProgress) { try { this.onProgress(msg); } catch (_) {} }
        return;
      }
      if (msg.type === 'ready') {
        if (msg.error) {
          this.readyErrors[i] = msg.error;
          console.error('[WorkerPool] worker ' + i + ' boot failed:', msg.error);
          // still mark ready so we don't hang; jobs on this worker will fail
        }
        this.ready[i] = true;
        this.available.push(i);
        this._dispatch();
        return;
      }
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.pending.delete(msg.id);
      this.available.push(i);
      if (msg.ok) {
        this._stats.completed++;
        job.resolve(msg.result);
      } else {
        this._stats.errored++;
        job.reject(new Error(msg.error));
      }
      this._dispatch();
    }
    
    _dispatch() {
      while (this.queue.length && this.available.length) {
        const job = this.queue.shift();
        const wIdx = this.available.shift();
        const w = this.workers[wIdx];
        if (!w) { this.available.push(wIdx); continue; }
        this._stats.dispatched++;
        this.pending.set(job.id, job);
        w.postMessage({ id: job.id, type: job.type, payload: job.payload });
      }
    }
    
    runJob(type, payload) {
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        this.queue.push({ id, type, payload, resolve, reject });
        this._dispatch();
      });
    }
    
    async waitReady() {
      while (this.ready.filter(Boolean).length < this.workers.length) {
        await new Promise(r => setTimeout(r, 30));
      }
      const errs = this.readyErrors.filter(Boolean);
      if (errs.length === this.workers.length) {
        throw new Error('All workers failed to boot: ' + errs[0]);
      }
    }
    
    runEval(point, opts) {
      return this.runJob('runEval', { point, opts });
    }
    
    // Level 2: same result as runEval(point, opts), but points sharing (alt, G, T, MECO) share one SA checkpoint.
    // First caller per key runs live (and captures); the rest resume from the checkpoint. Call pool.snaps.clear() when config/env changes.
    async runEvalSA(point, opts) {
      opts = opts || {};
      const alt = opts.targetAltKm != null ? opts.targetAltKm : '';
      const key = alt + '|' + point.Gi + '|' + point.Tn + '|' + point.meco;
      for (;;) {
        const ent = this.snaps.get(key);
        if (ent) {
          if (ent.fail) { this.saStats.failHit++; return ent.fail; }
          this.saStats.hit++;
          return (await this.runJob('saRun', { point, opts, snap: ent.snap })).metrics;
        }
        const inf = this._saInflight.get(key);
        if (inf) { await inf.catch(() => {}); continue; }
        this.saStats.build++;
        // Leader runs ascent ONLY (stopAtCheckpoint) -> snap published right away -> waiters unblock after ~2s, not after a full eval.
        const p = this.runJob('saRun', { point, opts, build: true }).then((r) => {
          this.snaps.set(key, r.snap ? { snap: r.snap } : { fail: r.metrics });
          return r;
        });
        this._saInflight.set(key, p);
        let r;
        try { r = await p; } finally { this._saInflight.delete(key); }
        if (!r.snap) return r.metrics;   // run ended before SA: metrics are final (bias-independent)
        return (await this.runJob('saRun', { point, opts, snap: r.snap })).metrics;   // leader resumes like everyone else
      }
    }

    runEvalValues(values, opts) {
      return this.runJob('runEvalValues', { values, opts });
    }
    
    ping() {
      return this.runJob('ping', {});
    }
    
    stats() {
      return Object.assign({}, this._stats, {
        n: this.n,
        ready: this.ready.filter(Boolean).length,
        queued: this.queue.length,
        inFlight: this.pending.size,
      });
    }
    
    async terminate() {
      this.workers.forEach(w => { try { w.terminate(); } catch (e) {} });
      this.workers = [];
      this.queue.forEach(j => j.reject(new Error('pool terminated')));
      this.pending.forEach(j => j.reject(new Error('pool terminated')));
      this.queue = [];
      this.pending.clear();
    }
  }
  
  // Auto-detect a safe worker count.
  function defaultWorkers() {
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ?
      navigator.hardwareConcurrency :
      4;
    // Leave 1 for the main thread, cap at 8 (browsers throttle beyond that).
    return Math.max(1, Math.min(8, hc - 1));
  }
  
  T.WorkerPool = WorkerPool;
  T.SnapStore = SnapStore;
  T.defaultWorkers = defaultWorkers;
})();