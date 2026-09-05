/**
 * calib/frame-selection.js — choose a well-spread subset of frames for
 * intrinsic calibration.
 *
 * cv.calibrateCamera is LM over one pose per frame; past ~60–100 well-spread
 * frames the accuracy gain is nil and the cost is superlinear. We greedily
 * pick frames that cover the most not-yet-covered image cells (a GxG grid),
 * with a tie-break on corner count, and then top up with frames that add
 * pose diversity (board apparent size = distance proxy).
 *
 * Pure JS. Input samples: [{frame, ids:Int32Array, corners:Float32Array}].
 */

/**
 * @param {Array<{frame:number, corners:Float32Array}>} samples
 * @param {{width:number,height:number}} imageSize
 * @param {object} [opts]
 * @param {number} [opts.maxFrames=80]
 * @param {number} [opts.grid=8]  grid cells per axis
 * @returns {number[]} selected frames in ascending order
 */
export function selectFramesForCoverage(samples, imageSize, opts = {}) {
    const maxFrames = opts.maxFrames ?? 80;
    const G = opts.grid ?? 8;
    if (samples.length <= maxFrames) return samples.map(s => s.frame).sort((a, b) => a - b);

    const cellW = imageSize.width / G, cellH = imageSize.height / G;
    // Per-sample occupied cell set + coverage stats
    const info = samples.map(s => {
        const cells = new Set();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const n = s.corners.length / 2;
        for (let i = 0; i < n; i++) {
            const x = s.corners[i * 2], y = s.corners[i * 2 + 1];
            const cx = Math.min(G - 1, Math.max(0, Math.floor(x / cellW)));
            const cy = Math.min(G - 1, Math.max(0, Math.floor(y / cellH)));
            cells.add(cy * G + cx);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const extent = n > 1 ? Math.hypot(maxX - minX, maxY - minY) : 0;
        return { frame: s.frame, cells, n, extent };
    });

    const covered = new Uint16Array(G * G);   // how many selected frames touch each cell
    const selected = new Set();
    const chosen = [];

    // Phase 1: greedy coverage — maximise sum over cells of 1/(1+covered).
    while (chosen.length < maxFrames) {
        let best = -1, bestScore = 0;
        for (let i = 0; i < info.length; i++) {
            if (selected.has(i)) continue;
            let score = 0;
            for (const c of info[i].cells) score += 1 / (1 + covered[c]);
            score += info[i].n * 1e-3;  // tie-break: more corners
            if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best < 0) break;
        selected.add(best);
        chosen.push(best);
        for (const c of info[best].cells) covered[c]++;
        // Stop the coverage phase once every cell that any frame can cover is covered twice.
        if (chosen.length >= maxFrames) break;
    }

    // Phase 2 (if room remains because of early break): add by extent diversity.
    if (chosen.length < maxFrames) {
        const rest = info.map((_, i) => i).filter(i => !selected.has(i))
            .sort((a, b) => info[b].extent - info[a].extent);
        // interleave large / small apparent sizes
        let lo = 0, hi = rest.length - 1, flip = false;
        while (chosen.length < maxFrames && lo <= hi) {
            const i = flip ? rest[hi--] : rest[lo++];
            flip = !flip;
            selected.add(i); chosen.push(i);
        }
    }

    return chosen.map(i => info[i].frame).sort((a, b) => a - b);
}

/**
 * Fraction of GxG image cells touched by any of the given samples.
 */
export function coverageFraction(samples, imageSize, G = 8) {
    const cellW = imageSize.width / G, cellH = imageSize.height / G;
    const cells = new Set();
    for (const s of samples) {
        const n = s.corners.length / 2;
        for (let i = 0; i < n; i++) {
            const cx = Math.min(G - 1, Math.max(0, Math.floor(s.corners[i * 2] / cellW)));
            const cy = Math.min(G - 1, Math.max(0, Math.floor(s.corners[i * 2 + 1] / cellH)));
            cells.add(cy * G + cx);
        }
    }
    return cells.size / (G * G);
}

/**
 * Evenly strided frame sample: floor(total / target) stride, starting at 0.
 * @returns {{frames:number[], stride:number}}
 */
export function stridedFrames(totalFrames, targetSamples) {
    const target = Math.max(1, Math.min(targetSamples, totalFrames));
    const stride = Math.max(1, Math.floor(totalFrames / target));
    const frames = [];
    for (let f = 0; f < totalFrames; f += stride) frames.push(f);
    return { frames, stride };
}
