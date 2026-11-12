/**
 * calib/bundle-adjust.js — sparse Levenberg–Marquardt bundle adjustment in plain JS.
 *
 * Why a second solver next to sba-solver-wasm: the WASM solver can only free all
 * nine intrinsic parameters at once (fx, fy, cx, cy, k1, k2, k3, p1, p2). On a
 * planar target that never reaches the image corners this is badly conditioned
 * (k2/k3 drift to large cancelling values, focal length and principal point trade
 * off) and the refinement stalls far above what the data supports. aniposelib gets
 * sub-pixel results with a deliberately small camera model: one focal length and
 * k1 per camera, principal point fixed at the image centre, plus a soft "the 3D
 * points of a frame form a rigid board" term that also pins the metric scale.
 * This module reproduces that model (with a few opt-in extensions) and exposes
 * the same input/output shapes as the WASM wrapper so the rest of the pipeline
 * (calib/sba.js, ui/stage-extrinsics.js) does not care which engine ran.
 *
 * Model
 *   camera c:   Xc = R_c X + t_c;  (xn, yn) = (Xc.x, Xc.y) / Xc.z;
 *               Brown radial/tangential distortion; u = fx xd + cx, v = fy yd + cy
 *   point p:    X_p free (or fixed)
 *   board b:    every point of frame b should equal R_b O_id + t_b (O = board
 *               object point of its corner id); residual w * (X_p - R_b O - t_b)
 *
 * Unknowns: camera extrinsics (local rotation increment + translation, reference
 * camera fixed), a configurable subset of intrinsics, points, board poses.
 * Normal equations are reduced with two Schur complements (points, then boards —
 * each point belongs to exactly one board, so both blocks are block-diagonal) and
 * the remaining dense camera system (≤ 10 unknowns per camera) is solved by
 * Cholesky. Robust losses are applied as IRLS weights.
 */

import { rodriguesToMatrix, matmul, matrixToQuaternion, quaternionToMatrix } from './geometry.js';
import { cornerObjectPoint } from './board.js';

/** Intrinsic parameter subsets. `principal` and `focal` here mean *optimised*. */
export const INTRINSIC_MODELS = Object.freeze({
    'fixed':         { focal: 'fixed',    principal: false, k1: false, k2: false },
    'f-k1':          { focal: 'shared',   principal: false, k1: true,  k2: false },   // aniposelib
    'f-c-k1':        { focal: 'shared',   principal: true,  k1: true,  k2: false },
    'f-k1-k2':       { focal: 'shared',   principal: false, k1: true,  k2: true },
    'fxfy-c-k1-k2':  { focal: 'separate', principal: true,  k1: true,  k2: true },
});

export const DEFAULT_BA_CONFIG = Object.freeze({
    max_iterations: 100,
    cost_tolerance: 1e-6,        // relative objective decrease that counts as converged
    parameter_tolerance: 1e-8,   // relative step norm that counts as converged
    robust_loss: 'none',         // none | huber | cauchy  (aniposelib: linear + threshold rounds)
    robust_loss_param: 1.0,
    optimize_extrinsics: true,
    optimize_points: true,
    optimize_intrinsics: true,
    intrinsics_model: 'fxfy-c-k1-k2',   // UI default; 'f-k1' is aniposelib's model
    reference_camera: 0,
    board_weight: 0,             // px per mm for the rigidity term; 0 = off (scale then re-anchored to the board afterwards)
    board: null,                 // board config (calib/board.js) — needed for the rigidity term / re-anchoring
    initial_lambda: 1e-3,
});

// ---------------------------------------------------------------------------
// small dense linear algebra helpers (row-major Float64Array)

function choleskySolve(A, b, n) {
    // A: n*n (symmetric positive definite), b: n. Returns x or null if not PD.
    const L = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
        let s = A[j * n + j];
        for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
        if (!(s > 0)) return null;
        const d = Math.sqrt(s); L[j * n + j] = d;
        for (let i = j + 1; i < n; i++) {
            let t = A[i * n + j];
            for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
            L[i * n + j] = t / d;
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
}

/** Invert a symmetric 3x3 (Float64Array(9)); returns null if singular. */
function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-300)) return null;
    const s = 1 / det;
    return Float64Array.of(A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s);
}

/** Generic n×n inverse via Cholesky (SPD); returns null if not PD. */
function invSPD(A, n) {
    const out = new Float64Array(n * n);
    const e = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        e.fill(0); e[j] = 1;
        const col = choleskySolve(A, e, n);
        if (!col) return null;
        for (let i = 0; i < n; i++) out[i * n + j] = col[i];
    }
    return out;
}

/** Largest eigenvector of a symmetric 4x4 (Jacobi). */
function maxEigenvector4(N) {
    const A = Float64Array.from(N), V = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;
        for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p * 4 + q] * A[p * 4 + q];
        if (off < 1e-24) break;
        for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
            const apq = A[p * 4 + q];
            if (Math.abs(apq) < 1e-300) continue;
            const theta = (A[q * 4 + q] - A[p * 4 + p]) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 4; k++) {
                const akp = A[k * 4 + p], akq = A[k * 4 + q];
                A[k * 4 + p] = c * akp - s * akq; A[k * 4 + q] = s * akp + c * akq;
            }
            for (let k = 0; k < 4; k++) {
                const apk = A[p * 4 + k], aqk = A[q * 4 + k];
                A[p * 4 + k] = c * apk - s * aqk; A[q * 4 + k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 4; k++) {
                const vkp = V[k * 4 + p], vkq = V[k * 4 + q];
                V[k * 4 + p] = c * vkp - s * vkq; V[k * 4 + q] = s * vkp + c * vkq;
            }
        }
    }
    let best = 0;
    for (let i = 1; i < 4; i++) if (A[i * 4 + i] > A[best * 4 + best]) best = i;
    return [V[best], V[4 + best], V[8 + best], V[12 + best]];
}

/**
 * Rigid transform (R, t) with dst ≈ R src + t in the least-squares sense (Horn 1987,
 * quaternion method). src/dst: arrays of [x,y,z]. Needs ≥ 3 non-collinear points.
 */
export function fitRigidTransform(src, dst) {
    const n = src.length;
    const cs = [0, 0, 0], cd = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { cs[k] += src[i][k] / n; cd[k] += dst[i][k] / n; }
    const S = new Float64Array(9);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += (src[i][a] - cs[a]) * (dst[i][b] - cd[b]);
    const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
    const N = Float64Array.of(
        Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
        Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
        Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
        Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz);
    const q = maxEigenvector4(N);
    const R = quaternionToMatrix(q);
    const Rc = [R[0][0] * cs[0] + R[0][1] * cs[1] + R[0][2] * cs[2], R[1][0] * cs[0] + R[1][1] * cs[1] + R[1][2] * cs[2], R[2][0] * cs[0] + R[2][1] * cs[1] + R[2][2] * cs[2]];
    return { R, t: [cd[0] - Rc[0], cd[1] - Rc[1], cd[2] - Rc[2]] };
}

// ---------------------------------------------------------------------------
// projection + analytic Jacobian

/**
 * Project X with camera cam = {R, t, f:[fx,fy], c:[cx,cy], d:[k1,k2,p1,p2,k3]}.
 * If `J` is given, fills J.theta (2x3), J.t (2x3), J.X (2x3), J.f (2x2: d(u,v)/d(fx,fy)),
 * J.c, J.k1 (2), J.k2 (2) — all as flat arrays. Returns [u, v] or null if behind the camera.
 */
export function projectWithJacobian(X, cam, J) {
    const R = cam.R, t = cam.t;
    const v0 = R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2];
    const v1 = R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2];
    const v2 = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2];
    const Z = v2 + t[2];
    if (Z <= 1e-9) return null;
    const xn = (v0 + t[0]) / Z, yn = (v1 + t[1]) / Z;
    const [k1, k2, p1, p2, k3] = cam.d;
    const r2 = xn * xn + yn * yn, r4 = r2 * r2, r6 = r4 * r2;
    const rad = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const xd = xn * rad + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
    const yd = yn * rad + 2 * p2 * xn * yn + p1 * (r2 + 2 * yn * yn);
    const fx = cam.f[0], fy = cam.f[1];
    const u = fx * xd + cam.c[0], vv = fy * yd + cam.c[1];
    if (J) {
        const drad = 2 * k1 + 4 * k2 * r2 + 6 * k3 * r4;
        const dxdx = rad + drad * xn * xn + 2 * p1 * yn + 6 * p2 * xn;
        const dxdy = drad * xn * yn + 2 * p1 * xn + 2 * p2 * yn;
        const dydx = drad * xn * yn + 2 * p2 * yn + 2 * p1 * xn;
        const dydy = rad + drad * yn * yn + 2 * p2 * xn + 6 * p1 * yn;
        // G = d(u,v)/dXc = A * B, B = (1/Z) [[1,0,-xn],[0,1,-yn]]
        const iz = 1 / Z;
        const a00 = fx * dxdx, a01 = fx * dxdy, a10 = fy * dydx, a11 = fy * dydy;
        const G = J.t;   // d/dt = G
        G[0] = a00 * iz; G[1] = a01 * iz; G[2] = -(a00 * xn + a01 * yn) * iz;
        G[3] = a10 * iz; G[4] = a11 * iz; G[5] = -(a10 * xn + a11 * yn) * iz;
        // d/dθ = G * (-[v]x),  -[v]x = [[0, v2, -v1], [-v2, 0, v0], [v1, -v0, 0]]
        const T = J.theta;
        for (let r = 0; r < 2; r++) {
            const g0 = G[3 * r], g1 = G[3 * r + 1], g2 = G[3 * r + 2];
            T[3 * r] = -g1 * v2 + g2 * v1;
            T[3 * r + 1] = g0 * v2 - g2 * v0;
            T[3 * r + 2] = -g0 * v1 + g1 * v0;
        }
        // d/dX = G * R
        const JX = J.X;
        for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) JX[3 * r + c] = G[3 * r] * R[0][c] + G[3 * r + 1] * R[1][c] + G[3 * r + 2] * R[2][c];
        J.f[0] = xd; J.f[1] = 0; J.f[2] = 0; J.f[3] = yd;   // du/dfx, du/dfy, dv/dfx, dv/dfy
        J.c[0] = 1; J.c[1] = 0; J.c[2] = 0; J.c[3] = 1;
        J.k1[0] = fx * xn * r2; J.k1[1] = fy * yn * r2;
        J.k2[0] = fx * xn * r4; J.k2[1] = fy * yn * r4;
    }
    return [u, vv];
}

function robustWeightAndRho(e2, loss, delta) {
    // e2: squared residual norm. Returns [IRLS weight, rho(e)].
    if (loss === 'huber') {
        const e = Math.sqrt(e2);
        if (e <= delta) return [1, e2];
        return [delta / e, delta * (2 * e - delta)];
    }
    if (loss === 'cauchy') {
        const d2 = delta * delta;
        return [1 / (1 + e2 / d2), d2 * Math.log(1 + e2 / d2)];
    }
    return [1, e2];
}

// ---------------------------------------------------------------------------

/**
 * Run bundle adjustment.
 * @param {{cameras:object[], points:number[][], observations:{camera_idx:number,point_idx:number,x:number,y:number}[], point_to_frame?:number[], meta?:{pointIds?:number[]}}} input
 *        cameras in sba-solver-wasm format: {rotation:[w,x,y,z] (world->camera), translation, focal:[fx,fy], principal:[cx,cy], distortion:[k1,k2,p1,p2,k3]}
 * @param {object} config see DEFAULT_BA_CONFIG
 * @param {{onIteration?:(info:object)=>void}} [opts]
 * @returns {object} result in sba-solver-wasm shape (+ objective_*, boards, engine:'js')
 */
export function bundleAdjust(input, config = {}, opts = {}) {
    const cfg = { ...DEFAULT_BA_CONFIG, ...config };
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
    const model = INTRINSIC_MODELS[cfg.optimize_intrinsics ? (cfg.intrinsics_model || 'fxfy-c-k1-k2') : 'fixed'];
    if (!model) throw new Error(`unknown intrinsics model ${cfg.intrinsics_model}`);
    const loss = cfg.robust_loss === 'linear' ? 'none' : (cfg.robust_loss || 'none');
    const delta = Math.max(1e-6, cfg.robust_loss_param || 1);

    // --- cameras -----------------------------------------------------------
    const nC = input.cameras.length;
    const cams = input.cameras.map(c => ({
        R: quaternionToMatrix(c.rotation), t: c.translation.slice(),
        // a shared focal length starts from the mean of fx, fy (a k1-only per-camera fit on a
        // planar board often leaves fx and fy several % apart; aniposelib uses one f)
        f: model.focal === 'shared' ? [(c.focal[0] + c.focal[1]) / 2, (c.focal[0] + c.focal[1]) / 2] : c.focal.slice(),
        c: c.principal.slice(), d: [0, 0, 0, 0, 0].map((_, i) => c.distortion[i] || 0),
    }));
    const refCam = Math.min(Math.max(0, cfg.reference_camera | 0), nC - 1);
    // per-camera parameter layout: [θ(3) t(3)]? [f (1|2)]? [cx cy]? [k1]? [k2]?
    const nIntr = (model.focal === 'shared' ? 1 : model.focal === 'separate' ? 2 : 0) + (model.principal ? 2 : 0) + (model.k1 ? 1 : 0) + (model.k2 ? 1 : 0);
    const camOff = new Int32Array(nC), camExt = new Uint8Array(nC), camN = new Int32Array(nC);
    let M = 0;
    for (let c = 0; c < nC; c++) {
        camExt[c] = (cfg.optimize_extrinsics && c !== refCam) ? 1 : 0;
        camN[c] = 6 * camExt[c] + nIntr;
        camOff[c] = M; M += camN[c];
    }
    // --- points / observations ------------------------------------------------
    const nP = input.points.length;
    const P = new Float64Array(3 * nP);
    for (let p = 0; p < nP; p++) { P[3 * p] = input.points[p][0]; P[3 * p + 1] = input.points[p][1]; P[3 * p + 2] = input.points[p][2]; }
    const obs = input.observations;
    const nO = obs.length;
    const obsCam = new Int32Array(nO), obsPt = new Int32Array(nO), obsUV = new Float64Array(2 * nO);
    for (let i = 0; i < nO; i++) { obsCam[i] = obs[i].camera_idx; obsPt[i] = obs[i].point_idx; obsUV[2 * i] = obs[i].x; obsUV[2 * i + 1] = obs[i].y; }
    // observations grouped by point
    const ptObsStart = new Int32Array(nP + 1);
    for (let i = 0; i < nO; i++) ptObsStart[obsPt[i] + 1]++;
    for (let p = 0; p < nP; p++) ptObsStart[p + 1] += ptObsStart[p];
    const ptObs = new Int32Array(nO); { const fill = ptObsStart.slice(0, nP); for (let i = 0; i < nO; i++) ptObs[fill[obsPt[i]]++] = i; }
    const optPts = !!cfg.optimize_points;

    // --- boards (rigidity term) -----------------------------------------------
    const boardW = cfg.board && cfg.board_weight > 0 ? cfg.board_weight : 0;
    let nB = 0; const ptBoard = new Int32Array(nP).fill(-1); const boards = []; const objP = new Float64Array(3 * nP);
    if (boardW > 0 && input.point_to_frame && input.meta && input.meta.pointIds) {
        const byFrame = new Map();
        for (let p = 0; p < nP; p++) {
            const o = cornerObjectPoint(input.meta.pointIds[p], cfg.board);
            objP[3 * p] = o[0]; objP[3 * p + 1] = o[1]; objP[3 * p + 2] = o[2];
            const f = input.point_to_frame[p]; let arr = byFrame.get(f); if (!arr) { arr = []; byFrame.set(f, arr); } arr.push(p);
        }
        for (const [frame, pts] of byFrame) {
            if (pts.length < 4) continue;
            const fit = fitRigidTransform(pts.map(p => [objP[3 * p], objP[3 * p + 1], objP[3 * p + 2]]), pts.map(p => [P[3 * p], P[3 * p + 1], P[3 * p + 2]]));
            if (!fit.R.every(r => r.every(Number.isFinite))) continue;
            for (const p of pts) ptBoard[p] = boards.length;
            boards.push({ frame, R: fit.R, t: fit.t, pts });
        }
        nB = boards.length;
    }

    // --- objective ---------------------------------------------------------
    const J = { theta: new Float64Array(6), t: new Float64Array(6), X: new Float64Array(6), f: new Float64Array(4), c: new Float64Array(4), k1: new Float64Array(2), k2: new Float64Array(2) };
    function evaluate(camsE, PE, boardsE) {
        // returns { objective (robust reproj + board), sse (plain reprojection SSE), used }
        let obj = 0, sse = 0, used = 0;
        for (let i = 0; i < nO; i++) {
            const p = obsPt[i], X = [PE[3 * p], PE[3 * p + 1], PE[3 * p + 2]];
            const uv = projectWithJacobian(X, camsE[obsCam[i]], null);
            if (!uv) { obj += 1e6; continue; }
            const dx = uv[0] - obsUV[2 * i], dy = uv[1] - obsUV[2 * i + 1], e2 = dx * dx + dy * dy;
            sse += e2; used++;
            obj += robustWeightAndRho(e2, loss, delta)[1];
        }
        if (nB) for (const b of boardsE) for (const p of b.pts) {
            const R = b.R, o0 = objP[3 * p], o1 = objP[3 * p + 1], o2 = objP[3 * p + 2];
            const ex = PE[3 * p] - (R[0][0] * o0 + R[0][1] * o1 + R[0][2] * o2 + b.t[0]);
            const ey = PE[3 * p + 1] - (R[1][0] * o0 + R[1][1] * o1 + R[1][2] * o2 + b.t[1]);
            const ez = PE[3 * p + 2] - (R[2][0] * o0 + R[2][1] * o1 + R[2][2] * o2 + b.t[2]);
            obj += boardW * boardW * (ex * ex + ey * ey + ez * ez);
        }
        return { objective: obj, sse, used };
    }

    // --- per-iteration linearisation storage ------------------------------------
    let CS = 1; for (let c = 0; c < nC; c++) CS = Math.max(CS, camN[c]);   // camera-parameter stride per Jacobian row
    const jc = new Float64Array(nO * 2 * CS);   // per obs: 2 rows x CS camera params (only camN[c] used)
    const jp = new Float64Array(nO * 6);        // per obs: 2 x 3
    const res = new Float64Array(nO * 2);       // weighted residuals
    const wts = new Float64Array(nO);           // IRLS weight (sqrt applied to rows)
    const Hcc = new Float64Array(M * M), gc = new Float64Array(M);
    const Hpp = new Float64Array(9 * nP), gp = new Float64Array(3 * nP);
    const Hbb = new Float64Array(36 * nB), gb = new Float64Array(6 * nB), Hbp = new Float64Array(18 * nP);   // Hbp per point (6x3), only if ptBoard>=0
    const Scb = new Float64Array(M * 6 * nB);   // camera-board coupling after point elimination (M x 6 per board)

    function linearize() {
        Hcc.fill(0); gc.fill(0); Hpp.fill(0); gp.fill(0); Hbb.fill(0); gb.fill(0); Hbp.fill(0);
        for (let i = 0; i < nO; i++) {
            const c = obsCam[i], p = obsPt[i], cam = cams[c];
            const uv = projectWithJacobian([P[3 * p], P[3 * p + 1], P[3 * p + 2]], cam, J);
            wts[i] = 0;
            if (!uv) continue;
            const dx = uv[0] - obsUV[2 * i], dy = uv[1] - obsUV[2 * i + 1];
            const [w] = robustWeightAndRho(dx * dx + dy * dy, loss, delta);
            const sw = Math.sqrt(w); wts[i] = w;
            res[2 * i] = sw * dx; res[2 * i + 1] = sw * dy;
            // camera row block
            const n = camN[c], base = i * 2 * CS;
            for (let r = 0; r < 2; r++) {
                let k = 0; const row = base + r * CS;
                if (camExt[c]) { for (let q = 0; q < 3; q++) jc[row + k++] = sw * J.theta[3 * r + q]; for (let q = 0; q < 3; q++) jc[row + k++] = sw * J.t[3 * r + q]; }
                if (model.focal === 'shared') jc[row + k++] = sw * (r === 0 ? J.f[0] : J.f[3]);
                else if (model.focal === 'separate') { jc[row + k++] = sw * (r === 0 ? J.f[0] : 0); jc[row + k++] = sw * (r === 1 ? J.f[3] : 0); }
                if (model.principal) { jc[row + k++] = sw * (r === 0 ? 1 : 0); jc[row + k++] = sw * (r === 1 ? 1 : 0); }
                if (model.k1) jc[row + k++] = sw * J.k1[r];
                if (model.k2) jc[row + k++] = sw * J.k2[r];
                for (let q = 0; q < 3; q++) jp[6 * i + 3 * r + q] = sw * J.X[3 * r + q];
            }
            // accumulate camera normal block + gradient
            const off = camOff[c];
            for (let r = 0; r < 2; r++) {
                const row = base + r * CS, rr = res[2 * i + r];
                for (let a = 0; a < n; a++) {
                    const ja = jc[row + a]; if (ja === 0) continue;
                    gc[off + a] += ja * rr;
                    const hrow = (off + a) * M + off;
                    for (let b = 0; b < n; b++) Hcc[hrow + b] += ja * jc[row + b];
                }
                // point block
                const r0 = jp[6 * i + 3 * r], r1 = jp[6 * i + 3 * r + 1], r2 = jp[6 * i + 3 * r + 2];
                gp[3 * p] += r0 * rr; gp[3 * p + 1] += r1 * rr; gp[3 * p + 2] += r2 * rr;
                const h = 9 * p;
                Hpp[h] += r0 * r0; Hpp[h + 1] += r0 * r1; Hpp[h + 2] += r0 * r2;
                Hpp[h + 4] += r1 * r1; Hpp[h + 5] += r1 * r2; Hpp[h + 8] += r2 * r2;
            }
        }
        for (let p = 0; p < nP; p++) { const h = 9 * p; Hpp[h + 3] = Hpp[h + 1]; Hpp[h + 6] = Hpp[h + 2]; Hpp[h + 7] = Hpp[h + 5]; }
        // board residuals: r = w (X - R O - t); dr/dX = w I; dr/dθ = w [v]x; dr/dt = -w I  (v = R O)
        for (let bi = 0; bi < nB; bi++) {
            const b = boards[bi], R = b.R;
            for (const p of b.pts) {
                const o0 = objP[3 * p], o1 = objP[3 * p + 1], o2 = objP[3 * p + 2];
                const v0 = R[0][0] * o0 + R[0][1] * o1 + R[0][2] * o2, v1 = R[1][0] * o0 + R[1][1] * o1 + R[1][2] * o2, v2 = R[2][0] * o0 + R[2][1] * o1 + R[2][2] * o2;
                const r = [boardW * (P[3 * p] - v0 - b.t[0]), boardW * (P[3 * p + 1] - v1 - b.t[1]), boardW * (P[3 * p + 2] - v2 - b.t[2])];
                // Jb (3x6): [v]x = [[0,-v2,v1],[v2,0,-v0],[-v1,v0,0]] scaled by w ; -w I
                const Jb = [
                    [0, -boardW * v2, boardW * v1, -boardW, 0, 0],
                    [boardW * v2, 0, -boardW * v0, 0, -boardW, 0],
                    [-boardW * v1, boardW * v0, 0, 0, 0, -boardW]];
                const hb = 36 * bi, gbo = 6 * bi, hp = 9 * p, hbp = 18 * p;
                for (let k = 0; k < 3; k++) {
                    gp[3 * p + k] += boardW * r[k];
                    Hpp[hp + 4 * k] += boardW * boardW;
                    for (let a = 0; a < 6; a++) {
                        gb[gbo + a] += Jb[k][a] * r[k];
                        Hbp[hbp + 3 * a + k] += Jb[k][a] * boardW;   // Jb^T * (w I)
                        for (let c2 = 0; c2 < 6; c2++) Hbb[hb + 6 * a + c2] += Jb[k][a] * Jb[k][c2];
                    }
                }
            }
        }
    }

    // --- one LM step for a given lambda; returns {dc, db, dp} or null ---------------
    const Scc = new Float64Array(M * M), sg = new Float64Array(M);
    const Vp = new Float64Array(9 * nP), gpr = new Float64Array(3 * nP);
    const Wb = new Float64Array(36 * nB), gbr = new Float64Array(6 * nB);
    function solveStep(lambda) {
        Scc.set(Hcc); sg.set(gc); Scb.fill(0);
        for (let a = 0; a < M; a++) Scc[a * M + a] += lambda * Math.max(Hcc[a * M + a], 1e-12) + 1e-12;
        gbr.set(gb); Wb.fill(0);
        // point elimination
        const Hcp = new Float64Array(3 * CS);
        for (let p = 0; p < nP; p++) {
            const h = 9 * p;
            if (!optPts) { Vp.fill(0, h, h + 9); continue; }
            const D = Float64Array.from(Hpp.subarray(h, h + 9));
            for (let k = 0; k < 3; k++) D[4 * k] += lambda * Math.max(D[4 * k], 1e-12) + 1e-12;
            const V = inv3(D); if (!V) return null;
            Vp.set(V, h);
            // gpr = V gp
            const g0 = gp[3 * p], g1 = gp[3 * p + 1], g2 = gp[3 * p + 2];
            const vg = [V[0] * g0 + V[1] * g1 + V[2] * g2, V[3] * g0 + V[4] * g1 + V[5] * g2, V[6] * g0 + V[7] * g1 + V[8] * g2];
            gpr[3 * p] = vg[0]; gpr[3 * p + 1] = vg[1]; gpr[3 * p + 2] = vg[2];
            const bi = ptBoard[p];
            let HbpV = null;
            if (bi >= 0) {
                // Hbp V (6x3), Sbb -= Hbp V Hpb, gb -= Hbp V gp
                HbpV = new Float64Array(18);
                for (let a = 0; a < 6; a++) for (let k = 0; k < 3; k++) HbpV[3 * a + k] = Hbp[18 * p + 3 * a] * V[k] + Hbp[18 * p + 3 * a + 1] * V[3 + k] + Hbp[18 * p + 3 * a + 2] * V[6 + k];
                for (let a = 0; a < 6; a++) {
                    gbr[6 * bi + a] -= Hbp[18 * p + 3 * a] * vg[0] + Hbp[18 * p + 3 * a + 1] * vg[1] + Hbp[18 * p + 3 * a + 2] * vg[2];
                    for (let c2 = 0; c2 < 6; c2++) Wb[36 * bi + 6 * a + c2] -= HbpV[3 * a] * Hbp[18 * p + 3 * c2] + HbpV[3 * a + 1] * Hbp[18 * p + 3 * c2 + 1] + HbpV[3 * a + 2] * Hbp[18 * p + 3 * c2 + 2];
                }
            }
            // camera couplings through this point
            const s = ptObsStart[p], e = ptObsStart[p + 1];
            const blocks = [];   // per obs: {off, n, HcpV (n x 3)}
            for (let oi = s; oi < e; oi++) {
                const i = ptObs[oi]; if (wts[i] === 0) continue;
                const c = obsCam[i], n = camN[c]; if (n === 0) continue;
                const base = i * 2 * CS;
                // Hcp = Jc^T Jp  (n x 3)
                for (let a = 0; a < n; a++) for (let k = 0; k < 3; k++) Hcp[3 * a + k] = jc[base + a] * jp[6 * i + k] + jc[base + CS + a] * jp[6 * i + 3 + k];
                // HcpV = Hcp V
                const HcpV = new Float64Array(3 * n);
                for (let a = 0; a < n; a++) for (let k = 0; k < 3; k++) HcpV[3 * a + k] = Hcp[3 * a] * V[k] + Hcp[3 * a + 1] * V[3 + k] + Hcp[3 * a + 2] * V[6 + k];
                const off = camOff[c];
                for (let a = 0; a < n; a++) sg[off + a] -= HcpV[3 * a] * g0 + HcpV[3 * a + 1] * g1 + HcpV[3 * a + 2] * g2;
                if (bi >= 0) for (let a = 0; a < n; a++) for (let c2 = 0; c2 < 6; c2++) Scb[(bi * M + off + a) * 6 + c2] -= HcpV[3 * a] * Hbp[18 * p + 3 * c2] + HcpV[3 * a + 1] * Hbp[18 * p + 3 * c2 + 1] + HcpV[3 * a + 2] * Hbp[18 * p + 3 * c2 + 2];
                blocks.push({ off, n, HcpV, Hcp: Float64Array.from(Hcp.subarray(0, 3 * n)) });
            }
            for (const A of blocks) for (const B of blocks) {
                for (let a = 0; a < A.n; a++) { const row = (A.off + a) * M + B.off; for (let b = 0; b < B.n; b++) Scc[row + b] -= A.HcpV[3 * a] * B.Hcp[3 * b] + A.HcpV[3 * a + 1] * B.Hcp[3 * b + 1] + A.HcpV[3 * a + 2] * B.Hcp[3 * b + 2]; }
            }
        }
        // board elimination
        for (let bi = 0; bi < nB; bi++) {
            const S = new Float64Array(36);
            for (let k = 0; k < 36; k++) S[k] = Hbb[36 * bi + k] + Wb[36 * bi + k];
            for (let a = 0; a < 6; a++) S[7 * a] += lambda * Math.max(Hbb[36 * bi + 7 * a], 1e-12) + 1e-12;
            const W = invSPD(S, 6); if (!W) return null;
            Wb.set(W, 36 * bi);
            // Scc -= Scb W Sbc ; sg -= Scb W gbr
            const rows = [];
            for (let a = 0; a < M; a++) { let nz = false; for (let k = 0; k < 6; k++) if (Scb[(bi * M + a) * 6 + k] !== 0) { nz = true; break; } if (nz) rows.push(a); }
            const SW = new Float64Array(M * 6);
            for (const a of rows) for (let k = 0; k < 6; k++) { let s = 0; for (let q = 0; q < 6; q++) s += Scb[(bi * M + a) * 6 + q] * W[6 * q + k]; SW[6 * a + k] = s; }
            for (const a of rows) {
                let s = 0; for (let k = 0; k < 6; k++) s += SW[6 * a + k] * gbr[6 * bi + k];
                sg[a] -= s;
                for (const b of rows) { let t = 0; for (let k = 0; k < 6; k++) t += SW[6 * a + k] * Scb[(bi * M + b) * 6 + k]; Scc[a * M + b] -= t; }
            }
        }
        // camera solve
        const neg = new Float64Array(M); for (let a = 0; a < M; a++) neg[a] = -sg[a];
        const dc = M ? choleskySolve(Scc, neg, M) : new Float64Array(0);
        if (M && !dc) return null;
        // boards back-substitution: db = -W (gbr + Sbc dc)
        const db = new Float64Array(6 * nB);
        for (let bi = 0; bi < nB; bi++) {
            const rhs = new Float64Array(6);
            for (let k = 0; k < 6; k++) { let s = gbr[6 * bi + k]; for (let a = 0; a < M; a++) s += Scb[(bi * M + a) * 6 + k] * dc[a]; rhs[k] = s; }
            for (let a = 0; a < 6; a++) { let s = 0; for (let k = 0; k < 6; k++) s += Wb[36 * bi + 6 * a + k] * rhs[k]; db[6 * bi + a] = -s; }
        }
        // points back-substitution: dp = -V (gp + Hpc dc + Hpb db)
        const dp = new Float64Array(3 * nP);
        if (optPts) for (let p = 0; p < nP; p++) {
            const rhs = [gp[3 * p], gp[3 * p + 1], gp[3 * p + 2]];
            const s = ptObsStart[p], e = ptObsStart[p + 1];
            for (let oi = s; oi < e; oi++) {
                const i = ptObs[oi]; if (wts[i] === 0) continue;
                const c = obsCam[i], n = camN[c], off = camOff[c], base = i * 2 * CS;
                for (let a = 0; a < n; a++) { const d = dc[off + a]; if (d === 0) continue; for (let k = 0; k < 3; k++) rhs[k] += (jc[base + a] * jp[6 * i + k] + jc[base + CS + a] * jp[6 * i + 3 + k]) * d; }
            }
            const bi = ptBoard[p];
            if (bi >= 0) for (let k = 0; k < 3; k++) for (let a = 0; a < 6; a++) rhs[k] += Hbp[18 * p + 3 * a + k] * db[6 * bi + a];
            const V = Vp.subarray(9 * p, 9 * p + 9);
            for (let k = 0; k < 3; k++) dp[3 * p + k] = -(V[3 * k] * rhs[0] + V[3 * k + 1] * rhs[1] + V[3 * k + 2] * rhs[2]);
        }
        return { dc, db, dp };
    }

    function applyStep(step) {
        const newCams = cams.map((cam, c) => {
            const n = { R: cam.R, t: cam.t.slice(), f: cam.f.slice(), c: cam.c.slice(), d: cam.d.slice() };
            let k = camOff[c];
            if (camExt[c]) {
                const dth = [step.dc[k], step.dc[k + 1], step.dc[k + 2]];
                n.R = matmul(rodriguesToMatrix(dth), cam.R);
                n.t = [cam.t[0] + step.dc[k + 3], cam.t[1] + step.dc[k + 4], cam.t[2] + step.dc[k + 5]];
                k += 6;
            }
            if (model.focal === 'shared') { n.f[0] += step.dc[k]; n.f[1] += step.dc[k]; k++; }
            else if (model.focal === 'separate') { n.f[0] += step.dc[k]; n.f[1] += step.dc[k + 1]; k += 2; }
            if (model.principal) { n.c[0] += step.dc[k]; n.c[1] += step.dc[k + 1]; k += 2; }
            if (model.k1) n.d[0] += step.dc[k++];
            if (model.k2) n.d[1] += step.dc[k++];
            return n;
        });
        const newP = new Float64Array(P.length);
        for (let i = 0; i < P.length; i++) newP[i] = P[i] + step.dp[i];
        const newBoards = boards.map((b, bi) => {
            const k = 6 * bi;
            return { frame: b.frame, pts: b.pts, R: matmul(rodriguesToMatrix([step.db[k], step.db[k + 1], step.db[k + 2]]), b.R), t: [b.t[0] + step.db[k + 3], b.t[1] + step.db[k + 4], b.t[2] + step.db[k + 5]] };
        });
        return { cams: newCams, P: newP, boards: newBoards };
    }

    // --- main loop --------------------------------------------------------------
    let cur = evaluate(cams, P, boards);
    const initialObjective = cur.objective, initialSse = cur.sse;
    const history = [cur.sse];
    let lambda = cfg.initial_lambda, iterations = 0, status = 'MaxIterationsReached', converged = false;
    const maxIters = Math.max(1, cfg.max_iterations | 0);
    for (let it = 0; it < maxIters; it++) {
        linearize();
        let accepted = false, trial = null, next = null;
        for (let attempt = 0; attempt < 12; attempt++) {
            const step = solveStep(lambda);
            if (step) {
                trial = applyStep(step);
                next = evaluate(trial.cams, trial.P, trial.boards);
                if (next.objective < cur.objective) { accepted = true; break; }
            }
            lambda = Math.min(lambda * 4, 1e12);
            if (lambda >= 1e12) break;
        }
        if (!accepted) { status = it === 0 ? 'Stalled' : 'Converged'; converged = it > 0; break; }
        iterations++;
        // commit
        for (let c = 0; c < nC; c++) cams[c] = trial.cams[c];
        P.set(trial.P);
        for (let bi = 0; bi < nB; bi++) boards[bi] = trial.boards[bi];
        const rel = (cur.objective - next.objective) / Math.max(1e-300, cur.objective);
        cur = next; history.push(cur.sse);
        lambda = Math.max(lambda / 3, 1e-12);
        if (opts.onIteration) opts.onIteration({ iteration: iterations, maxIters, cost: cur.sse, initialCost: initialSse, objective: cur.objective, rms: Math.sqrt(cur.sse / Math.max(1, cur.used)), lambda, ms: now() - t0, status: 'running' });
        if (rel < cfg.cost_tolerance) { status = 'Converged'; converged = true; break; }
    }

    // --- scale re-anchoring -----------------------------------------------------------
    // Reprojection alone cannot observe the metric scale (fixed reference camera leaves one
    // gauge freedom). The board term pins it when active; re-anchor to the board's known
    // corner spacing afterwards in every case (a no-op, s ≈ 1, when the term did its job).
    let scaleApplied = 1;
    if (cfg.board && input.point_to_frame && input.meta && input.meta.pointIds) {
        const byFrame = new Map();
        for (let p = 0; p < nP; p++) { const f = input.point_to_frame[p]; let arr = byFrame.get(f); if (!arr) { arr = []; byFrame.set(f, arr); } arr.push(p); }
        const ratios = [];
        for (const pts of byFrame.values()) {
            if (pts.length < 2) continue;
            for (let a = 0; a + 1 < pts.length; a += 2) {
                const p = pts[a], q = pts[a + 1];
                const o1 = cornerObjectPoint(input.meta.pointIds[p], cfg.board), o2 = cornerObjectPoint(input.meta.pointIds[q], cfg.board);
                const dTrue = Math.hypot(o1[0] - o2[0], o1[1] - o2[1], o1[2] - o2[2]);
                const dEst = Math.hypot(P[3 * p] - P[3 * q], P[3 * p + 1] - P[3 * q + 1], P[3 * p + 2] - P[3 * q + 2]);
                if (dTrue > 0 && dEst > 0) ratios.push(dTrue / dEst);
            }
        }
        if (ratios.length >= 3) {
            ratios.sort((a, b) => a - b);
            const s = ratios[ratios.length >> 1];
            if (Number.isFinite(s) && s > 0 && Math.abs(s - 1) < 0.9) {
                scaleApplied = s;
                for (let c = 0; c < nC; c++) cams[c].t = cams[c].t.map(v => v * s);
                for (let i = 0; i < P.length; i++) P[i] *= s;
            }
        }
    }

    const ms = now() - t0;
    return {
        engine: 'js', intrinsics_model: cfg.optimize_intrinsics ? (cfg.intrinsics_model || 'f-k1') : 'fixed',
        cameras: cams.map(c => ({ rotation: matrixToQuaternion(c.R), translation: c.t.slice(), focal: c.f.slice(), principal: c.c.slice(), distortion: c.d.slice() })),
        points: Array.from({ length: nP }, (_, p) => [P[3 * p], P[3 * p + 1], P[3 * p + 2]]),
        initial_cost: initialSse, final_cost: cur.sse, objective_initial: initialObjective, objective_final: cur.objective,
        iterations, status, converged, cost_history: history, num_observations_used: cur.used, num_observations_filtered: nO - cur.used,
        boards: nB, board_weight: boardW, scale_applied: scaleApplied, camera_params: M, ms,
    };
}
