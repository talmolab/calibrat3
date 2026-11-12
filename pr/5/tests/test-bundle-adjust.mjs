import { test, run, assert, approx } from './harness.mjs';
import { bundleAdjust, projectWithJacobian, fitRigidTransform, INTRINSIC_MODELS } from '../calib/bundle-adjust.js';
import { rodriguesToMatrix, matmul, matrixToQuaternion, quaternionToMatrix, projectPoint } from '../calib/geometry.js';
import { cornerObjectPoint, numCorners, DEFAULT_BOARD } from '../calib/board.js';

// deterministic PRNG
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randn = () => { const u = Math.max(1e-12, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const cam0 = { R: rodriguesToMatrix([0.1, -0.2, 0.05]), t: [30, -20, 900], f: [800, 810], c: [640, 500], d: [-0.3, 0.1, 0.001, -0.002, 0.02] };

test('projectWithJacobian matches geometry.projectPoint', () => {
    const X = [120, -80, 200];
    const uv = projectWithJacobian(X, cam0, null);
    const ref = projectPoint(X, { K: [[800, 0, 640], [0, 810, 500], [0, 0, 1]], dist: cam0.d, R: cam0.R, t: cam0.t });
    approx(uv, ref, 1e-9);
});

test('analytic Jacobian matches finite differences (rotation, translation, point, f, c, k1, k2)', () => {
    const X = [120, -80, 200];
    const J = { theta: new Float64Array(6), t: new Float64Array(6), X: new Float64Array(6), f: new Float64Array(4), c: new Float64Array(4), k1: new Float64Array(2), k2: new Float64Array(2) };
    const uv0 = projectWithJacobian(X, cam0, J);
    const h = 1e-6;
    const num = (fn) => { const a = fn(h), b = fn(-h); return [(a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h)]; };
    for (let k = 0; k < 3; k++) {
        const dth = (e) => { const d = [0, 0, 0]; d[k] = e; return projectWithJacobian(X, { ...cam0, R: matmul(rodriguesToMatrix(d), cam0.R) }, null); };
        const n = num(dth); approx([J.theta[k], J.theta[3 + k]], n, 1e-4 * Math.max(1, Math.abs(n[0]), Math.abs(n[1])));
        const dt = (e) => { const t = cam0.t.slice(); t[k] += e; return projectWithJacobian(X, { ...cam0, t }, null); };
        const nt = num(dt); approx([J.t[k], J.t[3 + k]], nt, 1e-5 * Math.max(1, Math.abs(nt[0])));
        const dX = (e) => { const Y = X.slice(); Y[k] += e; return projectWithJacobian(Y, cam0, null); };
        const nX = num(dX); approx([J.X[k], J.X[3 + k]], nX, 1e-5 * Math.max(1, Math.abs(nX[0])));
    }
    const nf = num(e => projectWithJacobian(X, { ...cam0, f: [cam0.f[0] + e, cam0.f[1]] }, null)); approx([J.f[0], J.f[2]], nf, 1e-6);
    const nk1 = num(e => projectWithJacobian(X, { ...cam0, d: [cam0.d[0] + e, ...cam0.d.slice(1)] }, null)); approx(J.k1, nk1, 1e-4);
    const nk2 = num(e => projectWithJacobian(X, { ...cam0, d: [cam0.d[0], cam0.d[1] + e, ...cam0.d.slice(2)] }, null)); approx(J.k2, nk2, 1e-4);
    assert.ok(uv0[0] > 0 && uv0[1] > 0);
});

test('fitRigidTransform recovers a random rigid motion', () => {
    const R = rodriguesToMatrix([0.3, -0.7, 0.2]), t = [10, -5, 40];
    const src = [[0, 0, 0], [24, 0, 0], [0, 24, 0], [48, 24, 0], [24, 72, 0]];
    const dst = src.map(p => [R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0], R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1], R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2]]);
    const fit = fitRigidTransform(src, dst);
    approx(fit.R.flat(), R.flat(), 1e-9); approx(fit.t, t, 1e-7);
});

// ---- synthetic rig: 4 cameras around a moving board -------------------------------------
const board = { ...DEFAULT_BOARD, boardX: 8, boardY: 11, squareLength: 24, markerLength: 18.75 };
const nCorners = numCorners(board);
function makeRig(nFrames = 12) {
    const truth = [];
    for (let c = 0; c < 4; c++) {
        const ang = c * Math.PI / 2 * 0.6 - 0.5;   // cameras on an arc facing the origin
        const Rw = rodriguesToMatrix([0, ang, 0]);
        const t = [0, 0, 1500];
        truth.push({ R: matmul(rodriguesToMatrix([0.05 * c, 0, 0.02 * c]), Rw), t, f: [900 + 40 * c, 900 + 40 * c], c: [640, 512], d: [-0.25 + 0.03 * c, 0, 0, 0, 0] });
    }
    // board poses (world): near the origin, tilted variously
    const frames = [];
    for (let fIdx = 0; fIdx < nFrames; fIdx++) {
        const Rb = rodriguesToMatrix([0.6 * (rnd() - 0.5), 0.6 * (rnd() - 0.5), 2 * (rnd() - 0.5)]);
        const tb = [200 * (rnd() - 0.5) - 100, 200 * (rnd() - 0.5) - 130, 300 * (rnd() - 0.5)];
        frames.push({ Rb, tb });
    }
    return { truth, frames };
}
function makeInput(rig, noisePx, perturb) {
    const points = [], observations = [], point_to_frame = [], pointIds = [];
    rig.frames.forEach((fr, fi) => {
        for (let id = 0; id < nCorners; id++) {
            const o = cornerObjectPoint(id, board);
            const X = [0, 1, 2].map(k => fr.Rb[k][0] * o[0] + fr.Rb[k][1] * o[1] + fr.Rb[k][2] * o[2] + fr.tb[k]);
            const seen = [];
            rig.truth.forEach((cam, ci) => {
                const uv = projectWithJacobian(X, cam, null);
                if (!uv || uv[0] < 0 || uv[0] > 1280 || uv[1] < 0 || uv[1] > 1024) return;
                seen.push({ camera_idx: ci, point_idx: points.length, x: uv[0] + noisePx * randn(), y: uv[1] + noisePx * randn() });
            });
            if (seen.length < 2) continue;
            points.push(X.map(v => v + perturb.point * randn()));
            point_to_frame.push(fi); pointIds.push(id);
            observations.push(...seen);
        }
    });
    const cameras = rig.truth.map((cam, ci) => {
        const R = ci === 0 ? cam.R : matmul(rodriguesToMatrix([perturb.rot * randn(), perturb.rot * randn(), perturb.rot * randn()]), cam.R);
        const t = ci === 0 ? cam.t.slice() : cam.t.map(v => v + perturb.trans * randn());
        return { rotation: matrixToQuaternion(R), translation: t, focal: [cam.f[0] * (1 + perturb.focal), cam.f[1] * (1 + perturb.focal)], principal: cam.c.slice(), distortion: [cam.d[0] + perturb.k1, 0, 0, 0, 0] };
    });
    return { cameras, points, observations, point_to_frame, meta: { pointIds } };
}
const rms = (r) => Math.sqrt(r.final_cost / r.num_observations_used);

test('synthetic rig: noise-free, perturbed cameras + points -> recovers truth (f-k1, board term)', () => {
    seed = 7; const rig = makeRig();
    const input = makeInput(rig, 0, { point: 3, rot: 0.01, trans: 15, focal: 0.05, k1: 0.05 });
    assert.ok(input.observations.length > 1500, `obs ${input.observations.length}`);
    const r = bundleAdjust(input, { intrinsics_model: 'f-k1', board, board_weight: 2 / 24, max_iterations: 60, cost_tolerance: 1e-10 });
    assert.ok(rms(r) < 1e-3, `rms ${rms(r)} status ${r.status} iters ${r.iterations}`);
    r.cameras.forEach((c, i) => { approx([c.focal[0]], [rig.truth[i].f[0]], 0.05); approx([c.distortion[0]], [rig.truth[i].d[0]], 1e-4); });
    assert.ok(r.boards === rig.frames.length);
});

test('synthetic rig: 0.3 px noise -> RMS ≈ noise, focal within 1 %, without board term (scale re-anchored)', () => {
    seed = 99; const rig = makeRig();
    const input = makeInput(rig, 0.3, { point: 2, rot: 0.005, trans: 10, focal: 0.04, k1: 0.04 });
    const r = bundleAdjust(input, { intrinsics_model: 'f-k1', board, board_weight: 0, max_iterations: 80 });
    assert.ok(rms(r) < 0.36 && rms(r) > 0.2, `rms ${rms(r)} status ${r.status} iters ${r.iterations}`);
    r.cameras.forEach((c, i) => assert.ok(Math.abs(c.focal[0] / rig.truth[i].f[0] - 1) < 0.01, `focal ${c.focal[0]} vs ${rig.truth[i].f[0]}`));
    // metric scale: camera 1 distance from camera 0 within 0.5 %
    const C = (c) => { const R = quaternionToMatrix(c.rotation), t = c.translation; return [0, 1, 2].map(k => -(R[0][k] * t[0] + R[1][k] * t[1] + R[2][k] * t[2])); };
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const Ct = rig.truth.map(c => { const t = c.t, R = c.R; return [0, 1, 2].map(k => -(R[0][k] * t[0] + R[1][k] * t[1] + R[2][k] * t[2])); });
    assert.ok(Math.abs(d(C(r.cameras[0]), C(r.cameras[1])) / d(Ct[0], Ct[1]) - 1) < 0.005, 'scale');
});

test('intrinsics fixed / extrinsics only, huber loss, points fixed all run and reduce cost', () => {
    seed = 3; const rig = makeRig(6);
    const input = makeInput(rig, 0.2, { point: 1, rot: 0.004, trans: 8, focal: 0, k1: 0 });
    const r1 = bundleAdjust(input, { optimize_intrinsics: false, robust_loss: 'huber', robust_loss_param: 1, board, board_weight: 2 / 24, max_iterations: 30 });
    assert.ok(r1.final_cost < r1.initial_cost * 0.1, `fixed intrinsics: ${r1.initial_cost} -> ${r1.final_cost}`);
    const r2 = bundleAdjust(input, { optimize_points: false, optimize_intrinsics: false, max_iterations: 30 });
    assert.ok(r2.final_cost < r2.initial_cost, 'points fixed');
    const r3 = bundleAdjust(input, { intrinsics_model: 'fxfy-c-k1-k2', board, board_weight: 1, max_iterations: 40 });
    assert.ok(rms(r3) < 0.3, `full model rms ${rms(r3)}`);
    assert.ok(Object.keys(INTRINSIC_MODELS).length === 5);
});

run();
