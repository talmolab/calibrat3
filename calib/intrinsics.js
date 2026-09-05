/**
 * calib/intrinsics.js — per-camera intrinsic calibration on top of OpenCV.js.
 *
 * Every function takes the initialized `cv` module as its first argument so
 * the same code runs in loading/calib-worker.js (normal) or on the main
 * thread (tests / fallback). Inputs and outputs are plain objects + typed
 * arrays so they cross postMessage cheaply.
 *
 * Sample shape: {frame:number, ids:Int32Array, corners:Float32Array(2n)}.
 */

import { objectPointsForIds } from './board.js';
import { selectFramesForCoverage, coverageFraction } from './frame-selection.js';
import { projectPoints, rmsPointError, rodriguesToMatrix } from './geometry.js';

/**
 * Run cv.calibrateCameraExtended over `samples`.
 * @returns {{K:number[][], dist:number[], rms:number, perView:Float64Array, rvecs:Float64Array, tvecs:Float64Array, stdIntrinsics:number[]}}
 */
export function calibrateIntrinsics(cv, samples, imageSize, board, opts = {}) {
    if (samples.length < 3) throw new Error(`Need at least 3 frames to calibrate (got ${samples.length})`);
    const objVec = new cv.MatVector();
    const imgVec = new cv.MatVector();
    const mats = [];
    try {
        for (const s of samples) {
            const n = s.ids.length;
            const obj = objectPointsForIds(s.ids, board);
            const objMat = cv.matFromArray(n, 1, cv.CV_32FC3, Array.from(obj));
            const imgMat = cv.matFromArray(n, 1, cv.CV_32FC2, Array.from(s.corners));
            mats.push(objMat, imgMat);
            objVec.push_back(objMat);
            imgVec.push_back(imgMat);
        }
        const f0 = opts.focalGuess ?? imageSize.width / (2 * Math.tan(30 * Math.PI / 180));
        const K = cv.matFromArray(3, 3, cv.CV_64F, [f0, 0, imageSize.width / 2, 0, f0, imageSize.height / 2, 0, 0, 1]);
        const dist = cv.Mat.zeros(5, 1, cv.CV_64F);
        const rvecs = new cv.MatVector(), tvecs = new cv.MatVector();
        const stdI = new cv.Mat(), stdE = new cv.Mat(), perViewErr = new cv.Mat();
        const size = new cv.Size(imageSize.width, imageSize.height);
        let flags = cv.CALIB_USE_INTRINSIC_GUESS;
        if (opts.fixK3) flags |= cv.CALIB_FIX_K3;
        if (opts.fixK2) flags |= cv.CALIB_FIX_K2;
        if (opts.zeroTangent) flags |= cv.CALIB_ZERO_TANGENT_DIST;
        if (opts.fixAspect) flags |= cv.CALIB_FIX_ASPECT_RATIO;
        mats.push(K, dist, stdI, stdE, perViewErr);
        let rms;
        try {
            rms = cv.calibrateCameraExtended(objVec, imgVec, size, K, dist, rvecs, tvecs, stdI, stdE, perViewErr, flags);
        } finally {
            // MatVectors need explicit cleanup of contents
        }
        const Kout = [[K.doubleAt(0, 0), K.doubleAt(0, 1), K.doubleAt(0, 2)], [K.doubleAt(1, 0), K.doubleAt(1, 1), K.doubleAt(1, 2)], [K.doubleAt(2, 0), K.doubleAt(2, 1), K.doubleAt(2, 2)]];
        const distOut = [0, 1, 2, 3, 4].map(i => dist.doubleAt(i, 0));
        const nS = samples.length;
        const perView = new Float64Array(nS);
        for (let i = 0; i < perViewErr.rows && i < nS; i++) perView[i] = perViewErr.doubleAt(i, 0);
        const rv = new Float64Array(nS * 3), tv = new Float64Array(nS * 3);
        for (let i = 0; i < rvecs.size(); i++) {
            const r = rvecs.get(i), t = tvecs.get(i);
            rv[i * 3] = r.doubleAt(0, 0); rv[i * 3 + 1] = r.doubleAt(1, 0); rv[i * 3 + 2] = r.doubleAt(2, 0);
            tv[i * 3] = t.doubleAt(0, 0); tv[i * 3 + 1] = t.doubleAt(1, 0); tv[i * 3 + 2] = t.doubleAt(2, 0);
            r.delete(); t.delete();
        }
        const stdIntrinsics = [];
        for (let i = 0; i < stdI.rows; i++) stdIntrinsics.push(stdI.doubleAt(i, 0));
        rvecs.delete(); tvecs.delete();
        return { K: Kout, dist: distOut, rms, perView, rvecs: rv, tvecs: tv, stdIntrinsics };
    } finally {
        for (const m of mats) { try { m.delete(); } catch (_) { /* */ } }
        objVec.delete(); imgVec.delete();
    }
}

/**
 * For each sample, solvePnP the board with fixed intrinsics and compute the
 * RMS reprojection error. Returns typed arrays aligned with `samples`.
 */
export function reprojectFrames(cv, K, dist, samples, board, onProgress) {
    const n = samples.length;
    const errors = new Float32Array(n);
    const rvecs = new Float64Array(n * 3), tvecs = new Float64Array(n * 3);
    const Kmat = cv.matFromArray(3, 3, cv.CV_64F, K.flat());
    const Dmat = cv.matFromArray(5, 1, cv.CV_64F, dist);
    const rvec = new cv.Mat(), tvec = new cv.Mat();
    const cam = { K, dist, R: null, t: null };
    try {
        for (let i = 0; i < n; i++) {
            const s = samples[i];
            const m = s.ids.length;
            const obj = objectPointsForIds(s.ids, board);
            const objMat = cv.matFromArray(m, 3, cv.CV_64F, Array.from(obj));
            const imgMat = cv.matFromArray(m, 2, cv.CV_64F, Array.from(s.corners));
            let ok = false;
            try { ok = cv.solvePnP(objMat, imgMat, Kmat, Dmat, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE); }
            catch (_) { ok = false; }
            objMat.delete(); imgMat.delete();
            if (!ok) { errors[i] = NaN; continue; }
            const r = [rvec.doubleAt(0, 0), rvec.doubleAt(1, 0), rvec.doubleAt(2, 0)];
            const t = [tvec.doubleAt(0, 0), tvec.doubleAt(1, 0), tvec.doubleAt(2, 0)];
            rvecs.set(r, i * 3); tvecs.set(t, i * 3);
            cam.R = rodriguesToMatrix(r); cam.t = t;
            errors[i] = rmsPointError(projectPoints(obj, cam), s.corners);
            if (onProgress && (i % 50 === 0)) onProgress(i / n);
        }
    } finally {
        Kmat.delete(); Dmat.delete(); rvec.delete(); tvec.delete();
    }
    return { errors, rvecs, tvecs };
}

/**
 * Full per-camera intrinsics pipeline: filter by corner count, drop excluded
 * frames, pick a spread subset (optional), calibrate, then evaluate every
 * valid frame (including excluded / unselected) so the UI can show them all.
 *
 * @param {object[]} allSamples every detection for this view
 * @param {{width,height}} imageSize
 * @param {object} board
 * @param {{minCorners?:number, exclusions?:Set<number>, maxFrames?:number, onProgress?:Function, flags?:object}} opts
 */
export function computeIntrinsicsForCamera(cv, allSamples, imageSize, board, opts = {}) {
    const minCorners = opts.minCorners ?? 6;
    const exclusions = opts.exclusions || new Set();
    const maxFrames = opts.maxFrames ?? 0;
    const progress = opts.onProgress || (() => {});
    const t0 = performance.now();

    const valid = allSamples.filter(s => s.ids.length >= minCorners).sort((a, b) => a.frame - b.frame);
    const candidates = valid.filter(s => !exclusions.has(s.frame));
    if (candidates.length < 3) {
        return { error: `Only ${candidates.length} usable frame(s) (need >= 3 with >= ${minCorners} corners)`, validFrames: valid.map(s => s.frame) };
    }
    progress(0.05, 'selecting frames');
    let selectedFrames;
    if (maxFrames > 0 && candidates.length > maxFrames) {
        selectedFrames = selectFramesForCoverage(candidates, imageSize, { maxFrames });
    } else {
        selectedFrames = candidates.map(s => s.frame);
    }
    const selSet = new Set(selectedFrames);
    const selected = candidates.filter(s => selSet.has(s.frame));

    progress(0.1, `calibrating on ${selected.length} frames`);
    const tCal = performance.now();
    const cal = calibrateIntrinsics(cv, selected, imageSize, board, opts.flags || {});
    const calMs = performance.now() - tCal;

    progress(0.6, `evaluating ${valid.length} frames`);
    const tRe = performance.now();
    const re = reprojectFrames(cv, cal.K, cal.dist, valid, board, (p) => progress(0.6 + 0.4 * p, 'evaluating frames'));
    const reMs = performance.now() - tRe;

    const frames = Int32Array.from(valid.map(s => s.frame));
    const used = new Uint8Array(valid.length);
    for (let i = 0; i < valid.length; i++) used[i] = selSet.has(valid[i].frame) ? 1 : 0;
    const counts = Int32Array.from(valid.map(s => s.ids.length));

    return {
        imageSize: { width: imageSize.width, height: imageSize.height },
        K: cal.K, dist: cal.dist,
        fx: cal.K[0][0], fy: cal.K[1][1], cx: cal.K[0][2], cy: cal.K[1][2],
        k1: cal.dist[0], k2: cal.dist[1], p1: cal.dist[2], p2: cal.dist[3], k3: cal.dist[4],
        rmsError: cal.rms,
        stdIntrinsics: cal.stdIntrinsics,
        framesUsed: selected.length,
        framesValid: valid.length,
        framesExcluded: valid.length - candidates.length,
        selectedFrames,
        coverage: coverageFraction(selected, imageSize),
        perFrame: { frames, errors: re.errors, rvecs: re.rvecs, tvecs: re.tvecs, used, counts },
        timings: { calibrateMs: calMs, reprojectMs: reMs, totalMs: performance.now() - t0 },
    };
}
