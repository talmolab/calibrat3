/**
 * calib/sba.js — bundle adjustment input preparation and result application
 * for @talmolab/sba-solver-wasm.
 *
 * Points are the triangulated board corners from calib/triangulation.js
 * (one 3D point per frame x corner id); observations are the detected 2D
 * corners in every camera that saw the point.
 */

import { quaternionToMatrix, matrixToRodrigues, toWasmCamera, projectPoint } from './geometry.js';

/**
 * @param {{frames: object[]}} reproj result of computeCrossViewReprojection
 * @param {Array<{K,dist}>} intrinsics per view
 * @param {Array<{R,tvec}>} extrinsics per view
 * @param {{excludedFrames?:Set<number>, maxPoints?:number, viewNames?:string[]}} [opts]
 */
export function prepareSbaInput(reproj, intrinsics, extrinsics, opts = {}) {
    const excluded = opts.excludedFrames || new Set();
    const maxPoints = opts.maxPoints ?? 0;
    const nViews = intrinsics.length;

    // Camera index mapping: only calibrated cameras are sent.
    const camIdx = new Array(nViews).fill(-1);
    const cameras = [];
    const cameraViews = [];
    for (let v = 0; v < nViews; v++) {
        if (!intrinsics[v] || !extrinsics[v] || extrinsics[v].error) continue;
        camIdx[v] = cameras.length;
        cameras.push(toWasmCamera(intrinsics[v], extrinsics[v]));
        cameraViews.push(v);
    }

    let frames = reproj.frames.filter(r => !excluded.has(r.frame) && r.numObs > 0);
    const totalPoints = frames.reduce((a, r) => a + r.n, 0);
    let frameStride = 1;
    if (maxPoints > 0 && totalPoints > maxPoints) {
        frameStride = Math.ceil(totalPoints / maxPoints);
        frames = frames.filter((_, i) => i % frameStride === 0);
    }

    const points = [], observations = [], pointToFrame = [], pointIds = [], pointErr = [];
    for (const rec of frames) {
        for (let i = 0; i < rec.n; i++) {
            const x = rec.xyz[3 * i];
            if (!isFinite(x)) continue;
            let nobs = 0, errSum = 0, errN = 0;
            const obsHere = [];
            for (let v = 0; v < nViews; v++) {
                const vr = rec.views[v];
                if (!vr || !vr.mask[i] || camIdx[v] < 0) continue;
                obsHere.push({ camera_idx: camIdx[v], point_idx: points.length, x: vr.det[2 * i], y: vr.det[2 * i + 1] });
                nobs++;
                if (Number.isFinite(vr.err[i])) { errSum += vr.err[i]; errN++; }
            }
            if (nobs < 2) continue;
            points.push([x, rec.xyz[3 * i + 1], rec.xyz[3 * i + 2]]);
            pointToFrame.push(rec.frame);
            pointIds.push(rec.ids[i]);
            pointErr.push(errN ? errSum / errN : NaN);   // mean reprojection error of the point over its cameras
            for (const o of obsHere) observations.push(o);
        }
    }

    return {
        cameras, points, observations, point_to_frame: pointToFrame,
        meta: {
            cameraViews, pointIds, pointErr, frameStride,
            numCameras: cameras.length, numPoints: points.length, numObservations: observations.length,
            numFrames: frames.length,
        },
    };
}

/**
 * Translate a UI reference-view index into the solver's camera index.
 */
export function sbaReferenceIndex(input, refView) {
    const i = input.meta.cameraViews.indexOf(refView);
    return i < 0 ? 0 : i;
}

/**
 * Apply solver output. Returns NEW intrinsics/extrinsics arrays (inputs untouched).
 * @param {object} result runBundleAdjustment result
 * @param {object} input the prepared input (for camera mapping)
 */
export function applySbaResults(result, input, intrinsics, extrinsics) {
    const newI = intrinsics.slice();
    const newE = extrinsics.slice();
    input.meta.cameraViews.forEach((v, ci) => {
        const cam = result.cameras[ci];
        const K = [[cam.focal[0], 0, cam.principal[0]], [0, cam.focal[1], cam.principal[1]], [0, 0, 1]];
        const dist = cam.distortion.slice(0, 5);
        newI[v] = {
            ...intrinsics[v], K, dist,
            fx: K[0][0], fy: K[1][1], cx: K[0][2], cy: K[1][2],
            k1: dist[0], k2: dist[1], p1: dist[2], p2: dist[3], k3: dist[4],
            refinedBySba: true,
        };
        const R = quaternionToMatrix(cam.rotation);
        newE[v] = { ...extrinsics[v], R, rvec: matrixToRodrigues(R), tvec: cam.translation.slice(), refinedBySba: true };
    });
    return { intrinsics: newI, extrinsics: newE };
}

/**
 * Per-observation reprojection errors of an SBA input against a solver result
 * (refined cameras + points). `result.points[j]` corresponds to `input.points[j]`.
 * @returns {Float32Array} error per observation of `input`
 */
export function evaluateSbaObservations(result, input) {
    const cams = result.cameras.map(c => ({
        K: [[c.focal[0], 0, c.principal[0]], [0, c.focal[1], c.principal[1]], [0, 0, 1]],
        dist: c.distortion, R: quaternionToMatrix(c.rotation), t: c.translation,
    }));
    const errs = new Float32Array(input.observations.length);
    for (let i = 0; i < input.observations.length; i++) {
        const o = input.observations[i];
        const X = result.points[o.point_idx];
        if (!X) { errs[i] = NaN; continue; }
        const [u, v] = projectPoint(X, cams[o.camera_idx]);
        errs[i] = Math.hypot(u - o.x, v - o.y);
    }
    return errs;
}

/**
 * Keep only observations with keep[i] truthy, drop points left with < 2
 * observations, renumber point indices. Returns a new input whose
 * `meta.pointMap[j]` is the original point index of new point j and
 * `meta.obsMap[k]` the original observation index of new observation k.
 */
export function filterSbaInput(input, keep) {
    const obsPerPoint = new Int32Array(input.points.length);
    for (let i = 0; i < input.observations.length; i++) if (keep[i]) obsPerPoint[input.observations[i].point_idx]++;
    const pointMap = [], newIdx = new Int32Array(input.points.length).fill(-1);
    for (let p = 0; p < input.points.length; p++) if (obsPerPoint[p] >= 2) { newIdx[p] = pointMap.length; pointMap.push(p); }
    const observations = [], obsMap = [];
    for (let i = 0; i < input.observations.length; i++) {
        const o = input.observations[i];
        if (!keep[i] || newIdx[o.point_idx] < 0) continue;
        observations.push({ camera_idx: o.camera_idx, point_idx: newIdx[o.point_idx], x: o.x, y: o.y });
        obsMap.push(i);
    }
    return {
        cameras: input.cameras.map(c => ({ ...c, rotation: c.rotation.slice(), translation: c.translation.slice(), focal: c.focal.slice(), principal: c.principal.slice(), distortion: c.distortion.slice() })),
        points: pointMap.map(p => input.points[p].slice()),
        observations,
        point_to_frame: pointMap.map(p => input.point_to_frame[p]),
        meta: { ...input.meta, pointMap, obsMap, numPoints: pointMap.length, numObservations: observations.length },
    };
}

/**
 * Geometric threshold schedule from `start` down to `end` over `rounds` rounds
 * (anipose's bundle_adjust_iter uses start_mu -> end_mu the same way).
 */
export function outlierSchedule(start, end, rounds) {
    if (rounds <= 1) return [end];
    const out = [];
    for (let r = 0; r < rounds; r++) out.push(start * Math.pow(end / start, r / (rounds - 1)));
    return out;
}

/** Default solver config (mirrors the UI defaults). */
export const DEFAULT_SBA_CONFIG = Object.freeze({
    max_iterations: 100,
    robust_loss: 'huber',
    robust_loss_param: 1.0,
    outlier_threshold: 30,
    optimize_extrinsics: true,
    optimize_intrinsics: true,
    optimize_points: true,
    cost_tolerance: 1e-6,
    parameter_tolerance: 1e-8,
    gradient_tolerance: 1e-10,
    reference_camera: 0,
});
