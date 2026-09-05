/**
 * calib/motion.js — per-frame board motion from consecutive detections.
 *
 * Cross-view consistency of a moving board depends on exposure timing: with
 * sub-frame offsets between cameras (software triggering, rolling shutter) the
 * reprojection error grows with board speed. This scores every sampled frame by
 * the mean corner displacement per frame step to the nearest sampled neighbour
 * (max over cameras), so callers can keep only slow frames for extrinsics /
 * bundle adjustment. Pure JS over a DetectionStore.
 */

/**
 * @param {import('./detection-store.js').DetectionStore} store
 * @param {{minCorners?:number}} [opts]
 * @returns {Map<number, number>} frame -> px per frame (NaN when no neighbour with matching corners)
 */
export function boardMotionScores(store, opts = {}) {
    const minCorners = opts.minCorners ?? 6;
    const frames = store.frames();
    const nV = store.numViews;
    const out = new Map();
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        let worst = -1;
        for (let v = 0; v < nV; v++) {
            const d = store.get(f, v);
            if (!d || d.ids.length < minCorners) continue;
            for (const j of [i - 1, i + 1]) {
                if (j < 0 || j >= frames.length) continue;
                const g = frames[j];
                const e = store.get(g, v);
                if (!e || e.ids.length < minCorners) continue;
                let sum = 0, n = 0;
                for (let k = 0; k < d.ids.length; k++) {
                    const p = store.cornerForId(g, v, d.ids[k]);
                    if (!p) continue;
                    sum += Math.hypot(p[0] - d.corners[2 * k], p[1] - d.corners[2 * k + 1]);
                    n++;
                }
                if (n >= minCorners) worst = Math.max(worst, sum / n / Math.abs(g - f));
            }
        }
        out.set(f, worst < 0 ? NaN : worst);
    }
    return out;
}

/** Frames whose motion score exceeds `maxPxPerFrame` (NaN scores are kept). */
export function framesAboveMotion(scores, maxPxPerFrame) {
    const out = new Set();
    if (!(maxPxPerFrame > 0)) return out;
    for (const [f, m] of scores) if (Number.isFinite(m) && m > maxPxPerFrame) out.add(f);
    return out;
}

/** Summary percentiles of finite scores. */
export function motionSummary(scores) {
    const v = Array.from(scores.values()).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
    return { n: v.length, median: q(0.5), p25: q(0.25), p75: q(0.75), p90: q(0.9), max: v[v.length - 1] };
}
