/**
 * calib/sba.js — bundle adjustment input preparation and result application
 * for @talmolab/sba-solver-wasm.
 *
 * Points are the triangulated board corners from calib/triangulation.js
 * (one 3D point per frame x corner id); observations are the detected 2D
 * corners in every camera that saw the point.
 */

import { quaternionToMatrix, matrixToRodrigues, toWasmCamera } from './geometry.js';

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

    const points = [], observations = [], pointToFrame = [], pointIds = [];
    for (const rec of frames) {
        for (let i = 0; i < rec.n; i++) {
            const x = rec.xyz[3 * i];
            if (!isFinite(x)) continue;
            let nobs = 0;
            const obsHere = [];
            for (let v = 0; v < nViews; v++) {
                const vr = rec.views[v];
                if (!vr || !vr.mask[i] || camIdx[v] < 0) continue;
                obsHere.push({ camera_idx: camIdx[v], point_idx: points.length, x: vr.det[2 * i], y: vr.det[2 * i + 1] });
                nobs++;
            }
            if (nobs < 2) continue;
            points.push([x, rec.xyz[3 * i + 1], rec.xyz[3 * i + 2]]);
            pointToFrame.push(rec.frame);
            pointIds.push(rec.ids[i]);
            for (const o of obsHere) observations.push(o);
        }
    }

    return {
        cameras, points, observations, point_to_frame: pointToFrame,
        meta: {
            cameraViews, pointIds, frameStride,
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
