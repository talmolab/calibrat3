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
    const maxError = opts.maxError ?? 1000;   // px; a point reprojecting further than this is a failed triangulation, not a measurement
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
    const wasmCamsJs = activeViews.map(v => cams[v]);   // indexed like wasmIdx
    void sba;

    // Pass 1: gather observations per frame/point.
    const frameRecs = [];
    let batch = [];          // observation arrays awaiting triangulation
    let batchRefs = [];      // {rec, pointIdx}
    const flush = async () => {
        if (batch.length === 0) return;
        // Pure-JS DLT (undistort -> normalized coordinates -> nullspace of the 2n x 4 system).
        // The WASM triangulate_points was found to be inaccurate (≈3 mm / 1.5 px on exact
        // synthetic data), which put a floor of several px under every cross-view metric.
        for (let i = 0; i < batch.length; i++) {
            const { rec, pointIdx } = batchRefs[i];
            const p = triangulateDLT(batch[i], wasmCamsJs);
            if (!p) { rec.xyz[pointIdx * 3] = NaN; rec.xyz[pointIdx * 3 + 1] = NaN; rec.xyz[pointIdx * 3 + 2] = NaN; continue; }
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
    let dropped = 0;
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
                if (!(e <= maxError)) { vr.err[i] = NaN; vr.mask[i] = 0; vr.count--; dropped++; continue; }
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

    // No spread over large arrays (Math.max(...arr) throws RangeError past ~100k args).
    const summarize = (arr) => {
        if (!arr.length) return { n: 0, mean: NaN, median: NaN, p95: NaN, max: NaN };
        let sum = 0, max = -Infinity;
        for (const v of arr) { sum += v; if (v > max) max = v; }
        return { n: arr.length, mean: sum / arr.length, median: percentile(arr, 0.5), p95: percentile(arr, 0.95), max };
    };

    const summary = {
        frames: frameRecs.length,
        points: frameRecs.reduce((a, r) => a + r.n, 0),
        observations: frameRecs.reduce((a, r) => a + r.numObs, 0),
        perView: perViewErrs.map(summarize),
        overall: summarize(perViewErrs.flat()),
        frameMeans: summarize(allErrs),
        dropped,          // observations discarded as failed triangulations (> maxError px)
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

/**
 * Undistort a pixel to normalized camera coordinates (OpenCV undistortPoints iteration,
 * Brown model [k1, k2, p1, p2, k3]).
 * @returns {[number, number]}
 */
export function undistortToNormalized(u, v, K, dist) {
    const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2], skew = K[0][1] || 0;
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = dist || [];
    const yd = (v - cy) / fy, xd = (u - cx - skew * yd) / fx;
    let x = xd, y = yd;
    if (k1 === 0 && k2 === 0 && p1 === 0 && p2 === 0 && k3 === 0) return [x, y];
    for (let it = 0; it < 20; it++) {
        const r2 = x * x + y * y, r4 = r2 * r2;
        const icdist = 1 / (1 + k1 * r2 + k2 * r4 + k3 * r4 * r2);
        const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
        const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
        const nx = (xd - dx) * icdist, ny = (yd - dy) * icdist;
        const done = Math.abs(nx - x) < 1e-12 && Math.abs(ny - y) < 1e-12;
        x = nx; y = ny;
        if (done) break;
    }
    return [x, y];
}

/** Eigenvector of the smallest eigenvalue of a symmetric 4x4 (Float64Array(16), row-major), by Jacobi rotations. */
function smallestEigenvector4(N) {
    const A = Float64Array.from(N), V = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;
        for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p * 4 + q] * A[p * 4 + q];
        if (off < 1e-30) break;
        for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
            const apq = A[p * 4 + q];
            if (Math.abs(apq) < 1e-300) continue;
            const theta = (A[q * 4 + q] - A[p * 4 + p]) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
            for (let k = 0; k < 4; k++) { const akp = A[k * 4 + p], akq = A[k * 4 + q]; A[k * 4 + p] = c * akp - sn * akq; A[k * 4 + q] = sn * akp + c * akq; }
            for (let k = 0; k < 4; k++) { const apk = A[p * 4 + k], aqk = A[q * 4 + k]; A[p * 4 + k] = c * apk - sn * aqk; A[q * 4 + k] = sn * apk + c * aqk; }
            for (let k = 0; k < 4; k++) { const vkp = V[k * 4 + p], vkq = V[k * 4 + q]; V[k * 4 + p] = c * vkp - sn * vkq; V[k * 4 + q] = sn * vkp + c * vkq; }
        }
    }
    let best = 0;
    for (let i = 1; i < 4; i++) if (A[i * 4 + i] < A[best * 4 + best]) best = i;
    return [V[best], V[4 + best], V[8 + best], V[12 + best]];
}

/**
 * Linear (DLT) triangulation of one point from >= 2 views, as aniposelib does it:
 * undistort each observation to normalized coordinates, then take the null vector of
 * the stacked [x P3 - P1; y P3 - P2] rows with P = [R | t].
 * @param {{camera_idx:number, x:number, y:number}[]} obs
 * @param {{K:number[][], dist:number[], R:number[][], t:number[]}[]} cams indexed by camera_idx
 * @returns {number[]|null} [X, Y, Z] in world units, or null if degenerate / behind a camera
 */
export function triangulateDLT(obs, cams) {
    if (!obs || obs.length < 2) return null;
    const N = new Float64Array(16);
    for (const o of obs) {
        const cam = cams[o.camera_idx];
        if (!cam) continue;
        const [x, y] = undistortToNormalized(o.x, o.y, cam.K, cam.dist);
        const R = cam.R, t = cam.t;
        const r1 = [R[0][0], R[0][1], R[0][2], t[0]], r2 = [R[1][0], R[1][1], R[1][2], t[1]], r3 = [R[2][0], R[2][1], R[2][2], t[2]];
        const a = [x * r3[0] - r1[0], x * r3[1] - r1[1], x * r3[2] - r1[2], x * r3[3] - r1[3]];
        const b = [y * r3[0] - r2[0], y * r3[1] - r2[1], y * r3[2] - r2[2], y * r3[3] - r2[3]];
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) N[4 * i + j] += a[i] * a[j] + b[i] * b[j];
    }
    const v = smallestEigenvector4(N);
    if (!(Math.abs(v[3]) > 1e-12)) return null;
    const X = [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
    if (!X.every(Number.isFinite)) return null;
    // Cheirality: the point must be in front of the cameras that observed it.
    let behind = 0;
    for (const o of obs) { const c = cams[o.camera_idx]; if (!c) continue; const z = c.R[2][0] * X[0] + c.R[2][1] * X[1] + c.R[2][2] * X[2] + c.t[2]; if (z <= 0) behind++; }
    if (behind > 0) return null;
    return X;
}
