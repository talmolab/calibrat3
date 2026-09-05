/**
 * loading/calib-client.js — main-thread client for calib-worker.js.
 *
 *   const cw = new CalibWorker({log});
 *   const res = await cw.request('intrinsics', payload, {onProgress: (f, msg) => ...});
 */

export class CalibWorker {
    constructor(opts = {}) {
        this.log = opts.log || (() => {});
        this.workerUrl = opts.workerUrl || new URL('./calib-worker.js', import.meta.url);
        this.worker = null;
        this.pending = new Map();
        this.nextId = 1;
        this._ready = null;
    }

    init() {
        if (this._ready) return this._ready;
        this._ready = new Promise((resolve, reject) => {
            const t0 = performance.now();
            this.worker = new Worker(this.workerUrl);
            this.worker.addEventListener('message', (e) => {
                const m = e.data;
                if (m.type === 'ready') { this.log(`Calibration worker ready (OpenCV + calib modules) in ${(performance.now() - t0).toFixed(0)} ms`, 'success'); resolve(); return; }
                if (m.type === 'log') { this.log(`[calib] ${m.msg}`, m.level || 'info'); return; }
                const p = m.requestId ? this.pending.get(m.requestId) : null;
                if (m.type === 'progress') { p && p.onProgress && p.onProgress(m.fraction, m.msg); return; }
                if (m.type === 'result') { if (p) { this.pending.delete(m.requestId); p.resolve(m.result); } return; }
                if (m.type === 'error') {
                    if (p) { this.pending.delete(m.requestId); p.reject(Object.assign(new Error(m.error), { stack: m.stack })); }
                    else { this.log(`calib worker: ${m.error}`, 'error'); reject(new Error(m.error)); }
                }
            });
            this.worker.addEventListener('error', (ev) => {
                const err = new Error(`calib worker failed: ${ev.message || 'load error'}`);
                for (const [, p] of this.pending) p.reject(err);
                this.pending.clear();
                reject(err);
            });
        });
        return this._ready;
    }

    /**
     * @param {string} type
     * @param {object} payload
     * @param {{onProgress?:Function}} [opts]
     */
    async request(type, payload, opts = {}) {
        await this.init();
        const requestId = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject, onProgress: opts.onProgress });
            this.worker.postMessage({ type, requestId, ...payload });
        });
    }

    terminate() {
        if (this.worker) this.worker.terminate();
        this.worker = null;
        this._ready = null;
        for (const [, p] of this.pending) p.reject(new Error('calib worker terminated'));
        this.pending.clear();
    }
}
