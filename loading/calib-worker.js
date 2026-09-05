/**
 * loading/calib-worker.js — runs the heavy calibration math off the main
 * thread: intrinsics (calibrateCameraExtended + per-frame solvePnP),
 * extrinsics (covisibility -> relative poses -> chain), cross-view
 * triangulation/reprojection (sba-solver-wasm DLT), and bundle adjustment.
 *
 * Classic worker so it can importScripts() opencv.js; the ESM calib modules
 * and the sba wrapper are pulled in with dynamic import().
 *
 * Protocol:
 *   -> {type, requestId, ...payload}   type in: intrinsics | extrinsics | reprojection | sba | ping
 *   <- {type:'ready'}
 *   <- {type:'progress', requestId, fraction, msg}
 *   <- {type:'result', requestId, result}
 *   <- {type:'error', requestId, error, stack}
 *   <- {type:'log', level, msg}
 */

/* global importScripts, cv */

importScripts('../lib/opencv/opencv.js');

let CV = null;
let M = null;      // calib modules
let SBA = null;    // sba wrapper
const queue = [];
let ready = false;

const post = (m, transfer) => postMessage(m, transfer || []);
const log = (msg, level = 'info') => post({ type: 'log', level, msg });

/**
 * Resolve the initialized OpenCV module. Emscripten's MODULARIZE build exposes
 * `cv.then(cb)` but that `then` RETURNS THE MODULE (a thenable) — so `await cv`
 * or `resolve(cv)` recurses forever. Never await the module directly; hand it
 * back wrapped in a plain object.
 */
function whenOpenCVReady(cvObj) {
    return new Promise((resolve, reject) => {
        if (!cvObj) { reject(new Error('cv global is undefined')); return; }
        const done = (m) => resolve({ module: m });
        if (typeof cvObj.Mat === 'function') { done(cvObj); return; }
        if (typeof cvObj.then === 'function') {
            cvObj.then((m) => done(m && typeof m.Mat === 'function' ? m : cvObj));
            return;
        }
        const prev = cvObj.onRuntimeInitialized;
        cvObj.onRuntimeInitialized = () => { if (typeof prev === 'function') prev(); done(cvObj); };
    });
}

(async () => {
    try {
        const { module: m } = await whenOpenCVReady(cv);
        CV = m;
        const [store, cov, intr, extr, tri, sba, geom] = await Promise.all([
            import('../calib/detection-store.js'),
            import('../calib/covisibility.js'),
            import('../calib/intrinsics.js'),
            import('../calib/extrinsics.js'),
            import('../calib/triangulation.js'),
            import('../calib/sba.js'),
            import('../calib/geometry.js'),
        ]);
        M = { store, cov, intr, extr, tri, sba, geom };
        ready = true;
        post({ type: 'ready' });
        while (queue.length) handle(queue.shift());
    } catch (e) {
        post({ type: 'error', error: `calib worker init failed: ${e.message || e}`, stack: e.stack });
    }
})();

onmessage = (e) => { if (!ready) queue.push(e.data); else handle(e.data); };

async function ensureSba() {
    if (SBA) return SBA;
    const t0 = performance.now();
    SBA = await import('../lib/sba-solver-wasm/wrapper.js');
    await SBA.initSBA();
    log(`sba-solver-wasm initialized in ${(performance.now() - t0).toFixed(0)} ms`);
    return SBA;
}

function progressFn(requestId) {
    let last = 0;
    return (fraction, msg) => {
        const now = performance.now();
        if (now - last < 40 && fraction < 1) return;
        last = now;
        post({ type: 'progress', requestId, fraction, msg });
    };
}

async function handle(msg) {
    const { type, requestId } = msg;
    try {
        let result;
        switch (type) {
            case 'ping': result = { ok: true, cvVersion: CV.getBuildInformation ? CV.getBuildInformation().split('\n')[0] : 'unknown' }; break;
            case 'intrinsics': result = runIntrinsics(msg); break;
            case 'extrinsics': result = runExtrinsics(msg); break;
            case 'reprojection': result = await runReprojection(msg); break;
            case 'sba': result = await runSba(msg); break;
            default: throw new Error(`unknown request type ${type}`);
        }
        post({ type: 'result', requestId, result });
    } catch (e) {
        post({ type: 'error', requestId, error: e.message || String(e), stack: e.stack });
    }
}

// ---- intrinsics -------------------------------------------------------------

function runIntrinsics({ requestId, samples, imageSize, board, opts }) {
    const progress = progressFn(requestId);
    const o = { ...(opts || {}), exclusions: new Set(opts?.exclusions || []), onProgress: progress };
    return M.intr.computeIntrinsicsForCamera(CV, samples, imageSize, board, o);
}

// ---- extrinsics -------------------------------------------------------------

function runExtrinsics({ requestId, store: plain, intrinsics, board, refIdx, minCovisible, minCorners, excluded, maxFramesPerPair }) {
    const progress = progressFn(requestId);
    const t0 = performance.now();
    const store = M.store.DetectionStore.fromPlain(plain);
    progress(0.02, 'building covisibility graph');
    const graph = M.cov.buildCovisibilityGraph(store, minCovisible, new Set(excluded || []));
    // Cameras without intrinsics cannot anchor a relative pose: drop their edges
    // so the BFS never routes through them (they end up "unreachable").
    for (let v = 0; v < store.numViews; v++) {
        if (intrinsics[v]) continue;
        for (let u = 0; u < store.numViews; u++) { graph.pairCounts[v][u] = 0; graph.pairCounts[u][v] = 0; }
    }
    const chain = M.cov.findPoseChain(graph, refIdx);
    const tGraph = performance.now() - t0;
    progress(0.08, 'solving relative poses');
    const rel = M.extr.computeRelativePoses(CV, store, graph, chain, intrinsics, board, {
        minCorners: minCorners ?? 6, maxFramesPerPair: maxFramesPerPair ?? 0,
        onProgress: (f, m) => progress(0.08 + 0.87 * f, m),
    });
    progress(0.96, 'chaining poses');
    const extrinsics = M.extr.chainAbsoluteExtrinsics(rel, chain, refIdx, store.numViews);
    // Map isn't the friendliest across the wire for the UI; ship as entries.
    return {
        pairCounts: graph.pairCounts,
        chain,
        relativePoses: Array.from(rel.entries()),
        extrinsics,
        timings: { graphMs: tGraph, totalMs: performance.now() - t0 },
    };
}

// ---- cross-view reprojection --------------------------------------------------

async function runReprojection({ requestId, store: plain, intrinsics, extrinsics, opts }) {
    const progress = progressFn(requestId);
    const sba = await ensureSba();
    const store = M.store.DetectionStore.fromPlain(plain);
    return M.tri.computeCrossViewReprojection(sba, store, intrinsics, extrinsics, { ...(opts || {}), onProgress: progress });
}

// ---- bundle adjustment --------------------------------------------------------

async function runSba({ requestId, input, config, chunkIters }) {
    const sba = await ensureSba();
    const maxIters = Math.max(1, config.max_iterations || 100);
    const chunk = Math.max(1, Math.min(chunkIters || 10, maxIters));
    const total = input.observations.length;
    const t0 = performance.now();
    post({ type: 'progress', requestId, fraction: 0.02, msg: `optimizing ${input.points.length} points / ${total} observations`, detail: { iteration: 0, maxIters } });
    // The WASM solver is one blocking call. Run it in chunks of `chunk` iterations, feeding
    // the refined cameras/points back in, so the UI gets live iteration/cost progress.
    // (LM damping restarts each chunk; convergence status of the last chunk is reported.)
    let cameras = input.cameras, points = input.points;
    let done = 0, initialCost = null, history = [], last = null;
    const chunkCosts = [];
    while (done < maxIters) {
        const n = Math.min(chunk, maxIters - done);
        const r = await sba.runBundleAdjustment({ cameras, points, observations: input.observations, point_to_frame: input.point_to_frame }, { ...config, max_iterations: n });
        if (initialCost === null) initialCost = r.initial_cost;
        chunkCosts.push([r.initial_cost, r.final_cost, r.iterations, r.status]);
        if (last && r.final_cost > last.final_cost) {
            // Should not happen (LM only accepts descent), but never hand back a worse state.
            chunkCosts.push(['rejected chunk: cost rose', r.final_cost]);
            break;
        }
        // cost_history includes the starting cost of each chunk; skip it after the first chunk
        const h = r.cost_history || [];
        history = history.concat(done === 0 ? h : h.slice(1));
        done += r.iterations;
        cameras = r.cameras; points = r.points; last = r;
        const rmsNow = Math.sqrt(r.final_cost / Math.max(1, r.num_observations_used || total));
        post({ type: 'progress', requestId, fraction: 0.02 + 0.96 * Math.min(1, done / maxIters),
            msg: `iteration ${done}/${maxIters} · cost ${r.final_cost.toFixed(0)} (−${((initialCost - r.final_cost) / Math.max(1e-9, initialCost) * 100).toFixed(1)}%) · fit RMS ≈ ${rmsNow.toFixed(2)} px`,
            detail: { iteration: done, maxIters, cost: r.final_cost, initialCost, rms: rmsNow, status: r.status, costHistory: history, ms: performance.now() - t0 } });
        if (r.status !== 'MaxIterationsReached') break;   // converged (or stopped) inside this chunk
    }
    const result = { ...last, initial_cost: initialCost, iterations: done, cost_history: history, ms: performance.now() - t0, chunks: Math.ceil(done / chunk), chunkCosts };
    post({ type: 'progress', requestId, fraction: 1, msg: 'done', detail: { iteration: done, maxIters, cost: result.final_cost, initialCost, status: result.status, costHistory: history, ms: result.ms } });
    return result;
}
