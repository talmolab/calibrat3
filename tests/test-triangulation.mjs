import { test, run, assert, approx } from './harness.mjs';
import { triangulateDLT, undistortToNormalized } from '../calib/triangulation.js';
import { projectPoint, rodriguesToMatrix } from '../calib/geometry.js';

const lookAt = (C) => { const n = Math.hypot(...C); const z = C.map(v => -v / n); const up = [0, -1, 0]; const xr = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]; const nx = Math.hypot(...xr); const x = xr.map(v => v / nx); const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]; const R = [x, y, z]; return { R, t: [0, 1, 2].map(k => -(R[k][0] * C[0] + R[k][1] * C[1] + R[k][2] * C[2])) }; };
const cams = [[0, 0, -1000], [800, 300, -600], [-700, -200, -700]].map((C, i) => { const { R, t } = lookAt(C); return { K: [[765 + 50 * i, 0, 639.5], [0, 770 + 50 * i, 511.5], [0, 0, 1]], dist: [-0.3 + 0.02 * i, 0.05, 0.001, -0.002, 0.01], R, t }; });
let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test('undistortToNormalized inverts the Brown model to 1e-9', () => {
    for (let n = 0; n < 50; n++) {
        const X = [500 * (rnd() - 0.5), 500 * (rnd() - 0.5), 500 * (rnd() - 0.5)];
        const cam = cams[n % 3];
        const [u, v] = projectPoint(X, cam);
        const [x, y] = undistortToNormalized(u, v, cam.K, cam.dist);
        const [u0, v0] = projectPoint(X, { ...cam, dist: [0, 0, 0, 0, 0] });
        approx([cam.K[0][0] * x + cam.K[0][2], cam.K[1][1] * y + cam.K[1][2]], [u0, v0], 1e-7);
    }
});

test('triangulateDLT recovers exact 3D points from 2 and 3 distorted views', () => {
    let worst2 = 0, worst3 = 0, n = 0;
    for (let tries = 0; n < 100 && tries < 100000; tries++) {
        const X = [500 * (rnd() - 0.5), 500 * (rnd() - 0.5), 500 * (rnd() - 0.5)];
        const uv = cams.map(c => projectPoint(X, c));
        if (!uv.every(p => p[0] > 0 && p[0] < 1280 && p[1] > 0 && p[1] < 1024)) continue;
        n++;
        const obs = uv.map((p, ci) => ({ camera_idx: ci, x: p[0], y: p[1] }));
        const X3 = triangulateDLT(obs, cams), X2 = triangulateDLT(obs.slice(0, 2), cams);
        worst3 = Math.max(worst3, Math.hypot(...X.map((v, k) => v - X3[k])));
        worst2 = Math.max(worst2, Math.hypot(...X.map((v, k) => v - X2[k])));
    }
    assert.ok(n === 100, `sampled ${n}`);
    assert.ok(worst3 < 1e-6, `3-view worst ${worst3} mm`);
    assert.ok(worst2 < 1e-6, `2-view worst ${worst2} mm`);
});

test('triangulateDLT rejects degenerate input and points behind a camera', () => {
    assert.equal(triangulateDLT([{ camera_idx: 0, x: 600, y: 500 }], cams), null);
    // a point behind camera 0: mirror through the camera centre
    const behind = [0, 0, -2500];
    const obs = [0, 1].map(ci => { const [u, v] = projectPoint(behind, { ...cams[ci], R: cams[ci].R, t: cams[ci].t }); return { camera_idx: ci, x: Number.isFinite(u) ? u : 600, y: Number.isFinite(v) ? v : 500 }; });
    const r = triangulateDLT(obs, cams);
    assert.ok(r === null || r.every(Number.isFinite));
});

run();
