/**
 * loading/detect-pool.js — pool of detect-worker.js workers.
 *
 * `detect()` returns a Promise for the worker's result. Requests go to the
 * worker with the fewest in-flight jobs. Each worker owns its own OpenCV
 * runtime (~10 MB of JS + WASM each), so keep the pool small.
 */

export class DetectorPool {
    /**
     * @param {{size?:number, workerUrl?:string|URL, log?:Function}} [opts]
     */
    constructor(opts = {}) {
        const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        this.size = Math.max(1, opts.size ?? Math.min(4, Math.max(1, hw - 1)));
        this.workerUrl = opts.workerUrl || new URL('./detect-worker.js', import.meta.url);
        this.log = opts.log || (() => {});
        this.workers = [];
        this.pending = new Map();   // requestId -> {resolve, reject, workerIdx}
        this.inFlight = [];
        this.nextId = 1;
        this.boardKey = null;
        this.stats = { detections: 0, totalMs: 0 };
        this._readyPromise = null;
    }

    /** Spawn workers and wait for their OpenCV runtimes. Idempotent. */
    init() {
        if (this._readyPromise) return this._readyPromise;
        this._readyPromise = (async () => {
            const t0 = performance.now();
            const readies = [];
            for (let i = 0; i < this.size; i++) {
                const w = new Worker(this.workerUrl);
                this.workers.push(w);
                this.inFlight.push(0);
                readies.push(new Promise((resolve, reject) => {
                    const onMsg = (e) => {
                        if (e.data.type === 'ready') { w.removeEventListener('message', onMsg); resolve(); }
                        else if (e.data.type === 'error' && !e.data.requestId) { w.removeEventListener('message', onMsg); reject(new Error(e.data.error)); }
                    };
                    w.addEventListener('message', onMsg);
                    w.addEventListener('error', (ev) => reject(new Error(`detect worker ${i}: ${ev.message || 'failed to load'}`)), { once: true });
                }));
                w.addEventListener('message', (e) => this._onMessage(i, e.data));
                w.addEventListener('error', (ev) => this._failAll(i, new Error(ev.message || 'worker error')));
            }
            await Promise.all(readies);
            this.log(`Detection pool ready: ${this.size} worker(s), OpenCV initialized in ${(performance.now() - t0).toFixed(0)} ms`, 'success');
        })();
        return this._readyPromise;
    }

    get totalInFlight() { return this.inFlight.reduce((a, b) => a + b, 0); }

    /** Build detectors for `board` in every worker (cached by config key). */
    async configure(board) {
        await this.init();
        const key = `${board.boardX}x${board.boardY}|${board.squareLength}|${board.markerLength}|${board.dictName}`;
        if (key === this.boardKey) return;
        await Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
            const onMsg = (e) => {
                if (e.data.type === 'configured') { w.removeEventListener('message', onMsg); resolve(); }
                else if (e.data.type === 'error' && !e.data.requestId) { w.removeEventListener('message', onMsg); reject(new Error(e.data.error)); }
            };
            w.addEventListener('message', onMsg);
            w.postMessage({ type: 'configure', board });
        })));
        this.boardKey = key;
    }

    /**
     * Detect on one image. `image` (VideoFrame or ImageBitmap) is TRANSFERRED
     * to the worker and closed there.
     * @returns {Promise<{frame, view, ids:Int32Array, corners:Float32Array, numMarkers, ms, timings, thumb:Blob|null}>}
     */
    detect({ frame, view, image, width, height, wantThumb = false, thumbWidth = 160 }) {
        if (!this.boardKey) return Promise.reject(new Error('DetectorPool: configure(board) first'));
        let idx = 0;
        for (let i = 1; i < this.workers.length; i++) if (this.inFlight[i] < this.inFlight[idx]) idx = i;
        const requestId = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject, workerIdx: idx });
            this.inFlight[idx]++;
            try {
                this.workers[idx].postMessage({ type: 'detect', requestId, frame, view, image, width, height, wantThumb, thumbWidth }, [image]);
            } catch (e) {
                // Some ImageBitmaps/VideoFrames may not be transferable in this context: fall back to clone.
                try { this.workers[idx].postMessage({ type: 'detect', requestId, frame, view, image, width, height, wantThumb, thumbWidth }); }
                catch (e2) { this.pending.delete(requestId); this.inFlight[idx]--; reject(e2); }
            }
        });
    }

    _onMessage(workerIdx, msg) {
        if (msg.type === 'result') {
            const p = this.pending.get(msg.requestId);
            if (!p) return;
            this.pending.delete(msg.requestId);
            this.inFlight[p.workerIdx]--;
            this.stats.detections++;
            this.stats.totalMs += msg.ms;
            p.resolve(msg);
        } else if (msg.type === 'error') {
            if (msg.requestId) {
                const p = this.pending.get(msg.requestId);
                if (p) { this.pending.delete(msg.requestId); this.inFlight[p.workerIdx]--; p.reject(new Error(msg.error)); }
            } else {
                this.log(`detect worker ${workerIdx}: ${msg.error}`, 'error');
            }
        } else if (msg.type === 'log') {
            this.log(`[worker ${workerIdx}] ${msg.msg}`, msg.level || 'info');
        }
    }

    _failAll(workerIdx, err) {
        for (const [id, p] of this.pending) {
            if (p.workerIdx === workerIdx) { this.pending.delete(id); p.reject(err); }
        }
        this.inFlight[workerIdx] = 0;
    }

    terminate() {
        for (const w of this.workers) w.terminate();
        this.workers = [];
        this.inFlight = [];
        this._readyPromise = null;
        this.boardKey = null;
        for (const [, p] of this.pending) p.reject(new Error('pool terminated'));
        this.pending.clear();
    }
}
