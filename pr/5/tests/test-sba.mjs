import { test, run, assert, approx } from './harness.mjs';
import { prepareSbaInput, filterSbaInput, evaluateSbaObservations, outlierSchedule, applySbaResults, sbaReferenceIndex, pairErrorBounds } from '../calib/sba.js';
import { matrixToQuaternion, rodriguesToMatrix, projectPoint } from '../calib/geometry.js';

// Two calibrated cameras, three frames, a handful of points with known errors.
const K = [[800, 0, 320], [0, 800, 240], [0, 0, 1]];
const intr = [{ K, dist: [0, 0, 0, 0, 0] }, { K, dist: [0, 0, 0, 0, 0] }];
const extr = [
    { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], tvec: [0, 0, 0] },
    { R: rodriguesToMatrix([0, 0.1, 0]), tvec: [-100, 0, 0] },
];
function rec(frame, ids, errs) {
    const n = ids.length;
    const r = { frame, n, ids: Int32Array.from(ids), xyz: new Float64Array(3 * n), views: [], meanErr: 0, maxErr: 0, numObs: 2 * n };
    for (let i = 0; i < n; i++) { r.xyz[3 * i] = 10 * i; r.xyz[3 * i + 1] = 5; r.xyz[3 * i + 2] = 900; }
    for (let v = 0; v < 2; v++) {
        const vr = { mask: new Uint8Array(n).fill(1), det: new Float32Array(2 * n), proj: new Float32Array(2 * n), err: new Float32Array(n), mean: 0, max: 0, count: n };
        for (let i = 0; i < n; i++) {
            const X = [r.xyz[3 * i], r.xyz[3 * i + 1], r.xyz[3 * i + 2]];
            const [u, w] = projectPoint(X, { K, dist: intr[v].dist, R: extr[v].R, t: extr[v].tvec });
            vr.det[2 * i] = u + errs[i]; vr.det[2 * i + 1] = w;  // detection offset by the wanted error
            vr.proj[2 * i] = u; vr.proj[2 * i + 1] = w;
            vr.err[i] = errs[i];
        }
        r.views.push(vr);
    }
    return r;
}
const reproj = { frames: [rec(0, [1, 2, 3], [0.5, 0.5, 20]), rec(5, [1, 2], [1, 1]), rec(9, [7], [0.2])], summary: {} };

test('prepareSbaInput builds cameras / points / observations with per-point mean errors', () => {
    const inp = prepareSbaInput(reproj, intr, extr);
    assert.equal(inp.cameras.length, 2);
    assert.equal(inp.points.length, 6);
    assert.equal(inp.observations.length, 12);
    assert.deepEqual(inp.point_to_frame, [0, 0, 0, 5, 5, 9]);
    assert.deepEqual(inp.meta.pointIds, [1, 2, 3, 1, 2, 7]);
    approx(inp.meta.pointErr, [0.5, 0.5, 20, 1, 1, 0.2], 1e-6);
    assert.deepEqual(inp.meta.cameraViews, [0, 1]);
    approx(inp.cameras[0].rotation, [1, 0, 0, 0]);
    assert.equal(sbaReferenceIndex(inp, 1), 1);
});

test('prepareSbaInput honours excluded frames and the point cap', () => {
    const a = prepareSbaInput(reproj, intr, extr, { excludedFrames: new Set([0]) });
    assert.equal(a.points.length, 3);
    const b = prepareSbaInput(reproj, intr, extr, { maxPoints: 4 });
    assert.ok(b.meta.frameStride >= 2);
    assert.ok(b.points.length <= 4);
});

test('filterSbaInput drops observations, then points with < 2 observations, and renumbers', () => {
    const inp = prepareSbaInput(reproj, intr, extr);
    const keep = new Uint8Array(inp.observations.length).fill(1);
    // drop one observation of point 2 -> it has 1 obs left -> point removed entirely
    const idx = inp.observations.findIndex(o => o.point_idx === 2);
    keep[idx] = 0;
    const f = filterSbaInput(inp, keep);
    assert.equal(f.points.length, 5);
    assert.equal(f.observations.length, 10);
    assert.deepEqual(f.meta.pointMap, [0, 1, 3, 4, 5]);
    for (const o of f.observations) assert.ok(o.point_idx >= 0 && o.point_idx < 5);
    assert.deepEqual(f.point_to_frame, [0, 0, 5, 5, 9]);
    // originals untouched
    assert.equal(inp.points.length, 6);
    f.cameras[0].translation[0] = 999;
    assert.equal(inp.cameras[0].translation[0], 0);
});

test('evaluateSbaObservations reproduces the injected errors for an identity "result"', () => {
    const inp = prepareSbaInput(reproj, intr, extr);
    const errs = evaluateSbaObservations({ cameras: inp.cameras, points: inp.points }, inp);
    assert.equal(errs.length, 12);
    const byPoint = new Map();
    inp.observations.forEach((o, i) => byPoint.set(o.point_idx, errs[i]));
    approx(byPoint.get(2), 20, 1e-3);
    approx(byPoint.get(5), 0.2, 1e-3);
});

test('outlierSchedule is geometric from start to end', () => {
    const s = outlierSchedule(16, 2, 4);
    approx(s, [16, 8, 4, 2], 1e-9);
    assert.deepEqual(outlierSchedule(16, 2, 1), [2]);
});

test('applySbaResults maps solver cameras back to view indices and leaves inputs untouched', () => {
    const inp = prepareSbaInput(reproj, intr, extr);
    const result = { cameras: inp.cameras.map((c, i) => ({ ...c, focal: [810 + i, 805], principal: [321, 241], distortion: [-0.1, 0, 0, 0, 0], rotation: matrixToQuaternion(rodriguesToMatrix([0, 0.2 * i, 0])), translation: [-50 * i, 1, 2] })), points: inp.points };
    const out = applySbaResults(result, inp, intr, extr);
    assert.equal(out.intrinsics[1].fx, 811);
    assert.equal(out.intrinsics[1].k1, -0.1);
    approx(out.extrinsics[1].rvec, [0, 0.2, 0], 1e-9);
    assert.deepEqual(out.extrinsics[1].tvec, [-50, 1, 2]);
    assert.ok(out.intrinsics[0].refinedBySba && out.extrinsics[0].refinedBySba);
    assert.equal(intr[1].K[0][0], 800);
    assert.deepEqual(extr[1].tvec, [-100, 0, 0]);
});

test('pairErrorBounds: worst-pair p15 / p75 of per-point pair-mean errors', () => {
    // 20 points seen by both cameras with errors 1..20 in both -> pair means 1..20; p15 -> 3, p75 -> 15 (floor index)
    const n = 20, ids = Array.from({ length: n }, (_, i) => i), errs = ids.map(i => i + 1);
    const r = rec(0, ids, errs);
    const b = pairErrorBounds({ frames: [r] }, 2, { minPoints: 5 });
    assert.equal(b.pairs, 1);
    approx(b.minError, errs[Math.floor(n * 0.15)], 1e-6);
    approx(b.maxError, errs[Math.floor(n * 0.75)], 1e-6);
    // too few points -> no pair counted
    assert.equal(pairErrorBounds({ frames: [rec(0, [1, 2], [1, 1])] }, 2).pairs, 0);
});

test('filterSbaInput renumbers meta.pointIds / pointErr with the kept points', () => {
    const inp = prepareSbaInput(reproj, intr, extr);
    const keep = new Uint8Array(inp.observations.length).fill(1);
    // drop both observations of point 0 (frame 0, id 1) -> point removed, ids shift
    inp.observations.forEach((o, i) => { if (o.point_idx === 0) keep[i] = 0; });
    const f = filterSbaInput(inp, keep);
    assert.deepEqual(Array.from(f.meta.pointIds), [2, 3, 1, 2, 7]);
    approx(f.meta.pointErr, [0.5, 20, 1, 1, 0.2], 1e-6);
    assert.deepEqual(f.meta.pointMap, [1, 2, 3, 4, 5]);
});

run();
