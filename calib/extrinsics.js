/**
 * calib/extrinsics.js — initial multi-camera extrinsics from covisible
 * board observations.
 *
 * 1. For every camera pair on the pose chain, solvePnP the board in both
 *    cameras on each covisible frame and form the relative pose
 *    R_rel = R_b R_a^T, t_rel = t_b - R_rel t_a.
 * 2. Robustly average the relative poses (quaternion mean with iterative
 *    outlier rejection, weighted by per-frame PnP quality).
 * 3. Compose along the BFS chain from the reference camera.
 *
 * Takes the initialized `cv` module explicitly (runs in calib-worker.js).
 */

import { objectPointsForIds } from './board.js';
import { pairFrames, pathToRoot } from './covisibility.js';
import {
    rodriguesToMatrix, matrixToRodrigues, relativePose, robustAveragePoses,
    composePoses, projectPoints, rmsPointError, IDENTITY_R,
} from './geometry.js';

/**
 * Board pose in one camera. Returns null if PnP fails or too few corners.
 * @returns {{R:number[][], rvec:number[], tvec:number[], err:number}|null}
 */
export function solveBoardPose(cv, ids, corners, K, dist, board, minCorners = 6) {
    const n = ids.length;
    if (n < Math.max(4, minCorners)) return null;
    const obj = objectPointsForIds(ids, board);
    const objMat = cv.matFromArray(n, 3, cv.CV_64F, Array.from(obj));
    const imgMat = cv.matFromArray(n, 2, cv.CV_64F, Array.from(corners));
    const Kmat = cv.matFromArray(3, 3, cv.CV_64F, K.flat());
    const Dmat = cv.matFromArray(5, 1, cv.CV_64F, dist);
    const rvec = new cv.Mat(), tvec = new cv.Mat();
    try {
        let ok = false;
        try { ok = cv.solvePnP(objMat, imgMat, Kmat, Dmat, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE); } catch (_) { ok = false; }
        if (!ok) return null;
        const r = [rvec.doubleAt(0, 0), rvec.doubleAt(1, 0), rvec.doubleAt(2, 0)];
        const t = [tvec.doubleAt(0, 0), tvec.doubleAt(1, 0), tvec.doubleAt(2, 0)];
        const R = rodriguesToMatrix(r);
        const err = rmsPointError(projectPoints(obj, { K, dist, R, t }), corners);
        if (!isFinite(err) || t[2] <= 0) return null;
        return { R, rvec: r, tvec: t, err };
    } finally {
        objMat.delete(); imgMat.delete(); Kmat.delete(); Dmat.delete(); rvec.delete(); tvec.delete();
    }
}

/**
 * Relative poses for every (parent -> child) edge of the pose chain.
 *
 * @param {import('./detection-store.js').DetectionStore} store
 * @param {object} graph from buildCovisibilityGraph
 * @param {{parent:Array<number|null>, order:number[]}} chain from findPoseChain
 * @param {Array<{K:number[][], dist:number[]}>} intrinsics per view index
 * @param {object} board
 * @param {{minCorners?:number, maxFramesPerPair?:number, onProgress?:Function}} [opts]
 * @returns {Map<string, object>} key "p->c" -> {R, rvec, tvec, framesUsed, inliers, tStd, rotStdDeg, residuals:[{frame, errA, errB}]}
 */
export function computeRelativePoses(cv, store, graph, chain, intrinsics, board, opts = {}) {
    const minCorners = opts.minCorners ?? 6;
    const maxPerPair = opts.maxFramesPerPair ?? 0;
    const progress = opts.onProgress || (() => {});
    const poseCache = new Map();   // "frame,view" -> pose|null
    const getPose = (frame, view) => {
        const key = `${frame},${view}`;
        if (poseCache.has(key)) return poseCache.get(key);
        const d = store.get(frame, view);
        const intr = intrinsics[view];
        const pose = (d && intr) ? solveBoardPose(cv, d.ids, d.corners, intr.K, intr.dist, board, minCorners) : null;
        poseCache.set(key, pose);
        return pose;
    };

    const result = new Map();
    const edges = chain.order.filter(v => chain.parent[v] !== null && chain.parent[v] !== -1).map(v => [chain.parent[v], v]);
    let done = 0;
    for (const [p, c] of edges) {
        let frames = pairFrames(graph, p, c);
        if (maxPerPair > 0 && frames.length > maxPerPair) {
            // Even subsample across time; the robust average does the rest.
            const step = frames.length / maxPerPair;
            frames = Array.from({ length: maxPerPair }, (_, i) => frames[Math.floor(i * step)]);
        }
        const poses = [], weights = [], residuals = [];
        for (let i = 0; i < frames.length; i++) {
            const { frame } = frames[i];
            const a = getPose(frame, p), b = getPose(frame, c);
            if (!a || !b) continue;
            const rel = relativePose(a.R, a.tvec, b.R, b.tvec);
            poses.push(rel);
            weights.push(1 / (0.25 + a.err + b.err));
            residuals.push({ frame, errA: a.err, errB: b.err });
            if (i % 25 === 0) progress((done + i / frames.length) / edges.length, `pair ${p}->${c}: ${i}/${frames.length}`);
        }
        done++;
        if (poses.length === 0) {
            result.set(`${p}->${c}`, { error: 'no usable covisible frames', framesUsed: 0 });
            continue;
        }
        const avg = robustAveragePoses(poses, { weights });
        result.set(`${p}->${c}`, {
            R: avg.R, rvec: avg.rvec, tvec: avg.t,
            framesUsed: poses.length, inliers: avg.inliers.length,
            tStd: avg.tStd, rotStdDeg: avg.rotStdDeg,
            residuals,
            inlierFrames: avg.inliers.map(i => residuals[i].frame),
        });
        progress(done / edges.length, `pair ${p}->${c} done`);
    }
    return result;
}

/**
 * Compose relative poses along the chain into absolute (ref-camera-frame) extrinsics.
 * @returns {Array<{R:number[][], rvec:number[], tvec:number[], chain:number[], pairStd:number, error?:string}|null>}
 */
export function chainAbsoluteExtrinsics(relPoses, chain, refIdx, numViews) {
    const out = new Array(numViews).fill(null);
    out[refIdx] = { R: IDENTITY_R(), rvec: [0, 0, 0], tvec: [0, 0, 0], chain: [refIdx], pairStd: 0 };
    for (let v = 0; v < numViews; v++) {
        if (v === refIdx) continue;
        if (chain.parent[v] === -1) { out[v] = { error: 'unreachable from reference camera' }; continue; }
        const path = pathToRoot(chain.parent, v);   // ref ... v
        let R = IDENTITY_R(), t = [0, 0, 0], stdSum = 0, broken = null;
        for (let i = 1; i < path.length; i++) {
            const rel = relPoses.get(`${path[i - 1]}->${path[i]}`);
            if (!rel || rel.error) { broken = `${path[i - 1]}->${path[i]}`; break; }
            const c = composePoses(R, t, rel.R, rel.tvec);
            R = c.R; t = c.t; stdSum += rel.tStd || 0;
        }
        out[v] = broken
            ? { error: `missing relative pose ${broken}` }
            : { R, rvec: matrixToRodrigues(R), tvec: t, chain: path, pairStd: stdSum };
    }
    return out;
}
