// headless/tuner/eval-worker.js — worker_threads entry. Each worker loads the
// sim once (runner caches the vm instance) and then evaluates jobs forever.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { evalCore } = require('./evaluator');

parentPort.on('message', ({ id, values, opts }) => {
  try {
    parentPort.postMessage({ id, core: evalCore(workerData.cfg, values, opts) });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.stack) || String(e) });
  }
});
