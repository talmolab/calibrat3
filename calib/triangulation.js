/**
 * calib/triangulation.js — cross-view triangulation and reprojection.
 *
 * For every frame, each corner id seen by >= 2 cameras is triangulated
 * (batched DLT in sba-solver-wasm) and reprojected into every camera that
 * observed it. Results are stored compactly per frame as typed arrays:
 *
 *   {
 *     frame, n, ids: Int32Array(n), xyz: Float64Array(3n),
 *     views: Array<null | {mask:Uint8Array(n), det:Float32Array(2n), proj:Float32Array(2n), err:Float32Array(n), mean, max, count}>,
 *     meanErr, maxErr, numObs
 *   }
 *
 * Nothing per point is a JS object, so 1000 frames x 70 points x 4 cameras
 * is a few MB rather than a few hundred.
 *
 * `sba` is the imported sba-solver-wasm wrapper module (already initialized).
 */

import { projectPoint, toWasmCamera, percentile } from './geometry.js';

/**
 * @param {object} sba wrapper module with triangulatePoints()
 * @param {import('./detection-store.js').DetectionStore} store
 * @param {Array<{K,dist}>} intrinsics per view
 * @param {Array<{R,tvec}>} extrinsics per view (null entries are skipped)
 * @param {{frames?:number[], minCorners?:number, minViews?:number, batchPoints?:number, onProgress?:Function}} [opts]
 */
export async function computeCrossViewReprojection(sba, store, intrinsics, extrinsics, opts = {}) {
    const minCorners = opts.minCorners ?? 4;
    const minViews = opts.minViews ?? 2;
    const batchPoints = opts.batchPoints ?? 4000;
    const progress = opts.onProgress || (() => {});
    const frames = opts.frames || store.frames();
    const nViews = store.numViews;
    const t0 = performance.now();

    const activeViews = [];
    const cams = new Array(nViews).fill(null);
    const wasmCams = [];
    const wasmIdx = new Array(nViews).fill(-1);
    for (let v = 0; v < nViews; v++) {
        if (intrinsics[v] && extrinsics[v] && !extrinsics[v].error) {
            cams[v] = { K: intrinsics[v].K, dist: intrinsics[v].dist, R: extrinsics[v].R, t: extrinsics[v].tvec };
            wasmIdx[v] = wasmCams.length;
            wasmCams.push(toWasmCamera(intrinsics[v], extrinsics[v]));
            activeViews.push(v);
        }
    }
    if (activeViews.length < 2) throw new Error('Need at least two calibrated cameras');

    // Pass 1: gather observations per frame/point.
    const frameRecs = [];
    let batch = [];          // observation arrays awaiting triangulation
    let batchRefs = [];      // {rec, pointIdx}
    const flush = async () => {
        if (batch.length === 0) return;
        const res = await sba.triangulatePoints(batch, wasmCams);
        const failed = new Set(res.failed_indices || []);
        for (let i = 0; i < batch.length; i++) {
            const { rec, pointIdx } = batchRefs[i];
            const p = res.points[i];
            if (failed.has(i) || !p || !isFinite(p[0])) { rec.xyz[pointIdx * 3] = NaN; rec.xyz[pointIdx * 3 + 1] = NaN; rec.xyz[pointIdx * 3 + 2] = NaN; continue; }
            rec.xyz[pointIdx * 3] = p[0]; rec.xyz[pointIdx * 3 + 1] = p[1]; rec.xyz[pointIdx * 3 + 2] = p[2];
        }
        batch = []; batchRefs = [];
    };

    let processed = 0;
    for (const frame of frames) {
        const views = store.viewsWithMin(frame, minCorners).filter(v => cams[v]);
        if (views.length < minViews) { processed++; continue; }
        // Union of ids with per-id view count
        const count = new Map();
        for (const v of views) for (const id of store.get(frame, v).ids) count.set(id, (count.get(id) || 0) + 1);
        const ids = Array.from(count.entries()).filter(([, c]) => c >= minViews).map(([id]) => id).sort((a, b) => a - b);
        if (ids.length === 0) { processed++; continue; }
        const n = ids.length;
        const rec = {
            frame, n, ids: Int32Array.from(ids), xyz: new Float64Array(3 * n),
            views: new Array(nViews).fill(null), meanErr: NaN, maxErr: NaN, numObs: 0,
        };
        for (const v of views) {
            rec.views[v] = { mask: new Uint8Array(n), det: new Float32Array(2 * n), proj: new Float32Array(2 * n), err: new Float32Array(n), mean: NaN, max: NaN, count: 0 };
        }
        for (let i = 0; i < n; i++) {
            const obs = [];
            for (const v of views) {
                const pt = store.cornerForId(frame, v, ids[i]);
                if (!pt) continue;
                const vr = rec.views[v];
                vr.mask[i] = 1; vr.det[2 * i] = pt[0]; vr.det[2 * i + 1] = pt[1]; vr.count++;
                obs.push({ camera_idx: wasmIdx[v], x: pt[0], y: pt[1] });
            }
            batch.push(obs);
            batchRefs.push({ rec, pointIdx: i });
        }
        frameRecs.push(rec);
        if (batch.length >= batchPoints) { await flush(); progress(processed / frames.length, `triangulated ${processed}/${frames.length} frames`); }
        processed++;
    }
    await flush();

    // Pass 2: reproject and summarize.
    const perViewErrs = Array.from({ length: nViews }, () => []);
    const allErrs = [];
    for (const rec of frameRecs) {
        let sum = 0, cnt = 0, max = 0;
        for (let v = 0; v < nViews; v++) {
            const vr = rec.views[v];
            if (!vr) continue;
            let vs = 0, vc = 0, vm = 0;
            for (let i = 0; i < rec.n; i++) {
                if (!vr.mask[i]) { vr.err[i] = NaN; continue; }
                const X = [rec.xyz[3 * i], rec.xyz[3 * i + 1], rec.xyz[3 * i + 2]];
                if (!isFinite(X[0])) { vr.err[i] = NaN; vr.mask[i] = 0; vr.count--; continue; }
                const [u, w] = projectPoint(X, cams[v]);
                vr.proj[2 * i] = u; vr.proj[2 * i + 1] = w;
                const e = Math.hypot(u - vr.det[2 * i], w - vr.det[2 * i + 1]);
                vr.err[i] = e;
                if (isFinite(e)) { vs += e; vc++; if (e > vm) vm = e; perViewErrs[v].push(e); }
            }
            vr.mean = vc ? vs / vc : NaN; vr.max = vc ? vm : NaN;
            sum += vs; cnt += vc; if (vm > max) max = vm;
        }
        rec.meanErr = cnt ? sum / cnt : NaN;
        rec.maxErr = cnt ? max : NaN;
        rec.numObs = cnt;
        if (cnt) allErrs.push(rec.meanErr);
    }

    const summarize = (arr) => arr.length ? {
        n: arr.length, mean: arr.reduce((a, b) => a + b, 0) / arr.length,
        median: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: Math.max(...arr),
    } : { n: 0, mean: NaN, median: NaN, p95: NaN, max: NaN };

    const summary = {
        frames: frameRecs.length,
        points: frameRecs.reduce((a, r) => a + r.n, 0),
        observations: frameRecs.reduce((a, r) => a + r.numObs, 0),
        perView: perViewErrs.map(summarize),
        overall: summarize(perViewErrs.flat()),
        frameMeans: summarize(allErrs),
        ms: performance.now() - t0,
    };
    progress(1, 'done');
    return { frames: frameRecs, summary };
}

/** Index a reprojection result by frame for O(1) overlay lookups. */
export function indexReprojectionByFrame(reproj) {
    const m = new Map();
    if (reproj) for (const rec of reproj.frames) m.set(rec.frame, rec);
    return m;
}
