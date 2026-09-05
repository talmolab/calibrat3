/**
 * loading/calib-client.js — main-thread client for calib-worker.js.
 *
 * A small pool: intrinsics for N cameras run in parallel (one request per
 * camera, dispatched to the least-loaded worker); everything else is a single
 * request and lands on whichever worker is idle. Every worker has OpenCV +
 * the calib modules + the sba wrapper, so any request can go anywhere.
 *
 *   const cw = new CalibWorker({log, size: 3});
 *   const res = await cw.request('intrinsics', payload, {onProgress: (f, msg) => ...});
 */

export class CalibWorker {
    constructor(opts = {}) {
        this.log = opts.log || (() => {});
        this.workerUrl = opts.workerUrl || new URL('./calib-worker.js', import.meta.url);
        const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        this.size = Math.max(1, opts.size ?? Math.min(4, Math.max(1, hw - 2)));
        this.workers = [];
        this.inFlight = [];
        this.pending = new Map();   // requestId -> {resolve, reject, onProgress, workerIdx}
        this.nextId = 1;
        this._ready = null;
    }

    init() {
        if (this._ready) return this._ready;
        const t0 = performance.now();
        this._ready = Promise.all(Array.from({ length: this.size }, (_, i) => this._spawn(i))).then(() => {
            this.log(`Calibration worker pool ready (${this.size} worker${this.size > 1 ? 's' : ''}: OpenCV + calib modules) in ${(performance.now() - t0).toFixed(0)} ms`, 'success');
        });
        return this._ready;
    }

    _spawn(idx) {
        return new Promise((resolve, reject) => {
            const w = new Worker(this.workerUrl);
            this.workers[idx] = w;
            this.inFlight[idx] = 0;
            w.addEventListener('message', (e) => {
                const m = e.data;
                if (m.type === 'ready') { resolve(); return; }
                if (m.type === 'log') { this.log(`[calib${this.size > 1 ? ' ' + idx : ''}] ${m.msg}`, m.level || 'info'); return; }
                const p = m.requestId ? this.pending.get(m.requestId) : null;
                if (m.type === 'progress') { p && p.onProgress && p.onProgress(m.fraction, m.msg); return; }
                if (m.type === 'result') { if (p) { this._finish(m.requestId, p); p.resolve(m.result); } return; }
                if (m.type === 'error') {
                    if (p) { this._finish(m.requestId, p); p.reject(Object.assign(new Error(m.error), { stack: m.stack })); }
                    else { this.log(`calib worker ${idx}: ${m.error}`, 'error'); reject(new Error(m.error)); }
                }
            });
            w.addEventListener('error', (ev) => {
                const err = new Error(`calib worker ${idx} failed: ${ev.message || 'load error'}`);
                for (const [id, p] of this.pending) if (p.workerIdx === idx) { this.pending.delete(id); p.reject(err); }
                this.inFlight[idx] = 0;
                reject(err);
            });
        });
    }

    _finish(requestId, p) {
        this.pending.delete(requestId);
        this.inFlight[p.workerIdx] = Math.max(0, this.inFlight[p.workerIdx] - 1);
    }

    /**
     * @param {string} type  intrinsics | extrinsics | reprojection | sba | ping
     * @param {object} payload
     * @param {{onProgress?:Function}} [opts]
     */
    async request(type, payload, opts = {}) {
        await this.init();
        let idx = 0;
        for (let i = 1; i < this.workers.length; i++) if (this.inFlight[i] < this.inFlight[idx]) idx = i;
        const requestId = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject, onProgress: opts.onProgress, workerIdx: idx });
            this.inFlight[idx]++;
            this.workers[idx].postMessage({ type, requestId, ...payload });
        });
    }

    terminate() {
        for (const w of this.workers) w.terminate();
        this.workers = [];
        this.inFlight = [];
        this._ready = null;
        for (const [, p] of this.pending) p.reject(new Error('calib worker terminated'));
        this.pending.clear();
    }
}
