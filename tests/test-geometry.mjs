import { test, run, assert, approx } from './harness.mjs';
import {
    rodriguesToMatrix, matrixToRodrigues, matrixToQuaternion, quaternionToMatrix, quaternionToRodrigues, rodriguesToQuaternion,
    transpose, matmul, relativePose, composePoses, invertPose, robustAveragePoses, averageQuaternions, quaternionAngle,
    projectPoint, projectPoints, rmsPointError, cameraCenter, toWasmCamera, median, percentile,
} from '../calib/geometry.js';

const R_of = (axis, deg) => rodriguesToMatrix(axis.map(a => a * deg * Math.PI / 180));

test('rodrigues round trip', () => {
    for (const r of [[0, 0, 0], [0.3, -0.2, 0.9], [Math.PI * 0.99, 0, 0], [1e-7, 0, 0]]) {
        const R = rodriguesToMatrix(r);
        const back = matrixToRodrigues(R);
        approx(back, r, 1e-7, `rvec ${r}`);
        // orthonormal
        const I = matmul(R, transpose(R));
        approx(I.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
    }
});

test('rotation about z by 90° maps x to y', () => {
    const R = R_of([0, 0, 1], 90);
    approx([R[0][0] * 1 + R[0][1] * 0, R[1][0] * 1 + R[1][1] * 0, 0], [0, 1, 0], 1e-12);
});

test('quaternion conversions agree with rodrigues', () => {
    const r = [0.4, 0.1, -0.7];
    const R = rodriguesToMatrix(r);
    const q = matrixToQuaternion(R);
    approx(quaternionToMatrix(q).flat(), R.flat(), 1e-12);
    approx(quaternionToRodrigues(q), r, 1e-9);
    approx(rodriguesToQuaternion(r), q, 1e-9);
    assert.ok(q[0] >= 0);
    // trace <= 0 branch
    const R180 = R_of([1, 0, 0], 180);
    approx(quaternionToMatrix(matrixToQuaternion(R180)).flat(), R180.flat(), 1e-12);
});

test('relative pose composes back to the child pose', () => {
    const RA = R_of([0, 1, 0], 20), tA = [10, 0, 500];
    const RB = R_of([1, 0, 1], 35), tB = [-200, 40, 620];
    const { R, t } = relativePose(RA, tA, RB, tB);
    const c = composePoses(RA, tA, R, t);
    approx(c.R.flat(), RB.flat(), 1e-12);
    approx(c.t, tB, 1e-9);
});

test('invertPose', () => {
    const R = R_of([0.2, 1, 0], 50), t = [1, 2, 3];
    const inv = invertPose(R, t);
    const c = composePoses(R, t, inv.R, inv.t);
    approx(c.R.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
    approx(c.t, [0, 0, 0], 1e-12);
    approx(cameraCenter(R, t), inv.t, 1e-12);
});

test('averageQuaternions handles sign flips and is exact for identical inputs', () => {
    const q = matrixToQuaternion(R_of([0, 0, 1], 40));
    const avg = averageQuaternions([q, q.map(v => -v), q]);
    approx(quaternionAngle(avg, q), 0, 1e-12);
});

test('robustAveragePoses rejects an outlier', () => {
    const base = { R: R_of([0, 0, 1], 30), t: [100, 0, 0] };
    const poses = [];
    for (let i = 0; i < 12; i++) {
        const jitter = (i % 3 - 1) * 0.001;
        poses.push({ R: R_of([0, 0, 1], 30 + jitter), t: [100 + jitter * 10, jitter, 0] });
    }
    poses.push({ R: R_of([0, 0, 1], 75), t: [400, 300, 0] });   // outlier
    const avg = robustAveragePoses(poses);
    assert.equal(avg.inliers.length, 12);
    approx(avg.t, base.t, 0.02);
    approx(quaternionAngle(matrixToQuaternion(avg.R), matrixToQuaternion(base.R)), 0, 1e-4);
    assert.ok(avg.tStd < 0.1);
});

test('projectPoint matches the pinhole model with zero distortion', () => {
    const cam = { K: [[800, 0, 320], [0, 800, 240], [0, 0, 1]], dist: [0, 0, 0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 1000] };
    approx(projectPoint([0, 0, 0], cam), [320, 240], 1e-12);
    approx(projectPoint([100, -50, 0], cam), [320 + 80, 240 - 40], 1e-12);
    assert.ok(Number.isNaN(projectPoint([0, 0, -2000], cam)[0]));
});

test('projectPoint radial distortion pushes points outward for k1 > 0', () => {
    const cam = { K: [[800, 0, 320], [0, 800, 240], [0, 0, 1]], dist: [0.1, 0, 0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 1000] };
    const p = projectPoint([100, 0, 0], cam);
    assert.ok(p[0] > 400);
    const pts = projectPoints(Float64Array.from([100, 0, 0, 0, 0, 0]), cam);
    approx(Array.from(pts), [p[0], p[1], 320, 240], 1e-4);
    approx(rmsPointError(pts, Float32Array.from([p[0], p[1], 320, 240])), 0, 1e-3);
});

test('toWasmCamera layout', () => {
    const intr = { K: [[800, 0, 320], [0, 810, 240], [0, 0, 1]], dist: [1, 2, 3, 4, 5] };
    const extr = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], tvec: [1, 2, 3] };
    const c = toWasmCamera(intr, extr);
    approx(c.rotation, [1, 0, 0, 0]);
    assert.deepEqual(c.focal, [800, 810]);
    assert.deepEqual(c.principal, [320, 240]);
    assert.deepEqual(c.distortion, [1, 2, 3, 4, 5]);
    assert.deepEqual(c.translation, [1, 2, 3]);
});

test('median / percentile', () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
});

run();
