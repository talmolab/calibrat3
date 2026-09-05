/**
 * calib/geometry.js — rotation / pose utilities in pure JS.
 *
 * Conventions (OpenCV): a camera pose is (R, t) mapping world -> camera,
 * x_cam = R * x_world + t. Rotation matrices are row-major number[3][3].
 * Quaternions are [w, x, y, z]. Rodrigues vectors are [rx, ry, rz].
 *
 * Nothing here needs OpenCV, so the main thread never has to load it for
 * overlays / export, and everything is unit-testable in Node.
 */

export const IDENTITY_R = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function transpose(R) {
    return [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]],
    ];
}

/** Matrix product A * B. */
export function matmul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    return C;
}

export function rotateVector(R, v) {
    return [
        R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
        R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
        R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
    ];
}

export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

/** Rodrigues vector -> rotation matrix. */
export function rodriguesToMatrix(r) {
    const theta = norm3(r);
    if (theta < 1e-12) return IDENTITY_R();
    const [kx, ky, kz] = scale3(r, 1 / theta);
    const c = Math.cos(theta), s = Math.sin(theta), v = 1 - c;
    return [
        [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s],
        [ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s],
        [kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v],
    ];
}

/** Rotation matrix -> Rodrigues vector (via quaternion for numerical stability). */
export function matrixToRodrigues(R) {
    return quaternionToRodrigues(matrixToQuaternion(R));
}

/** Rotation matrix -> quaternion [w, x, y, z] (w >= 0). */
export function matrixToQuaternion(R) {
    const trace = R[0][0] + R[1][1] + R[2][2];
    let w, x, y, z;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        w = 0.25 / s;
        x = (R[2][1] - R[1][2]) * s;
        y = (R[0][2] - R[2][0]) * s;
        z = (R[1][0] - R[0][1]) * s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
        const s = 2.0 * Math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]);
        w = (R[2][1] - R[1][2]) / s;
        x = 0.25 * s;
        y = (R[0][1] + R[1][0]) / s;
        z = (R[0][2] + R[2][0]) / s;
    } else if (R[1][1] > R[2][2]) {
        const s = 2.0 * Math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]);
        w = (R[0][2] - R[2][0]) / s;
        x = (R[0][1] + R[1][0]) / s;
        y = 0.25 * s;
        z = (R[1][2] + R[2][1]) / s;
    } else {
        const s = 2.0 * Math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]);
        w = (R[1][0] - R[0][1]) / s;
        x = (R[0][2] + R[2][0]) / s;
        y = (R[1][2] + R[2][1]) / s;
        z = 0.25 * s;
    }
    const n = Math.hypot(w, x, y, z);
    const q = [w / n, x / n, y / n, z / n];
    return q[0] < 0 ? q.map(v => -v) : q;
}

/** Quaternion [w, x, y, z] -> rotation matrix. */
export function quaternionToMatrix(q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    const w = q[0] / n, x = q[1] / n, y = q[2] / n, z = q[3] / n;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
}

/** Quaternion -> Rodrigues (axis * angle). */
export function quaternionToRodrigues(q) {
    let [w, x, y, z] = q;
    const n = Math.hypot(w, x, y, z);
    w /= n; x /= n; y /= n; z /= n;
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
    const sinHalf = Math.hypot(x, y, z);
    if (sinHalf < 1e-12) return [0, 0, 0];
    const angle = 2 * Math.atan2(sinHalf, w);
    const k = angle / sinHalf;
    return [x * k, y * k, z * k];
}

/** Rodrigues -> quaternion. */
export function rodriguesToQuaternion(r) {
    const theta = norm3(r);
    if (theta < 1e-12) return [1, 0, 0, 0];
    const s = Math.sin(theta / 2) / theta;
    return [Math.cos(theta / 2), r[0] * s, r[1] * s, r[2] * s];
}

/** Angle (radians) between two rotations given as quaternions. */
export function quaternionAngle(qa, qb) {
    const d = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
    return 2 * Math.acos(Math.min(1, d));
}

/** Angle (radians) between two rotation matrices. */
export function rotationAngle(Ra, Rb) {
    return quaternionAngle(matrixToQuaternion(Ra), matrixToQuaternion(Rb));
}

/**
 * Average a set of quaternions (optionally weighted). Uses the sign-aligned
 * mean followed by normalization — accurate for the small spreads seen in
 * relative-pose estimation, and far better than averaging Rodrigues vectors.
 */
export function averageQuaternions(quats, weights = null) {
    if (quats.length === 0) return null;
    const ref = quats[0];
    const acc = [0, 0, 0, 0];
    let wsum = 0;
    for (let i = 0; i < quats.length; i++) {
        let q = quats[i];
        const w = weights ? weights[i] : 1;
        const d = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3];
        if (d < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        for (let k = 0; k < 4; k++) acc[k] += q[k] * w;
        wsum += w;
    }
    const n = Math.hypot(acc[0], acc[1], acc[2], acc[3]);
    if (n < 1e-12 || wsum === 0) return ref.slice();
    const q = acc.map(v => v / n);
    return q[0] < 0 ? q.map(v => -v) : q;
}

/** Pose inverse: (R, t) -> (R^T, -R^T t). */
export function invertPose(R, t) {
    const Rt = transpose(R);
    return { R: Rt, t: scale3(rotateVector(Rt, t), -1) };
}

/** Compose poses: apply (R1,t1) then (R2,t2): x -> R2 (R1 x + t1) + t2. */
export function composePoses(R1, t1, R2, t2) {
    return { R: matmul(R2, R1), t: add3(rotateVector(R2, t1), t2) };
}

/**
 * Relative pose from camera A to camera B given the board pose in each:
 * x_B = R_rel x_A + t_rel, where R_rel = R_B R_A^T, t_rel = t_B - R_rel t_A.
 */
export function relativePose(RA, tA, RB, tB) {
    const R = matmul(RB, transpose(RA));
    const t = sub3(tB, rotateVector(R, tA));
    return { R, t };
}

/**
 * Robust average of a list of poses [{R, t}] with optional per-pose weights.
 * Iteratively rejects poses whose rotation angle or translation distance to
 * the current mean exceeds `k` times the median deviation (k=3 by default).
 * Returns {R, t, rvec, inliers: number[], tStd, rotStdDeg}.
 */
export function robustAveragePoses(poses, opts = {}) {
    const k = opts.k ?? 3;
    const maxIter = opts.maxIter ?? 5;
    const weights = opts.weights ?? null;
    if (poses.length === 0) return null;
    const quats = poses.map(p => matrixToQuaternion(p.R));
    let inliers = poses.map((_, i) => i);
    let q = null, t = null;
    for (let iter = 0; iter < maxIter; iter++) {
        const w = weights ? inliers.map(i => weights[i]) : null;
        q = averageQuaternions(inliers.map(i => quats[i]), w);
        t = [0, 0, 0];
        let wsum = 0;
        for (let j = 0; j < inliers.length; j++) {
            const i = inliers[j];
            const wi = w ? w[j] : 1;
            t = add3(t, scale3(poses[i].t, wi));
            wsum += wi;
        }
        t = scale3(t, 1 / wsum);
        if (inliers.length < 4) break;
        const rotDev = inliers.map(i => quaternionAngle(quats[i], q));
        const tDev = inliers.map(i => norm3(sub3(poses[i].t, t)));
        const rotMed = median(rotDev), tMed = median(tDev);
        const rotThr = Math.max(k * rotMed, 1e-6), tThr = Math.max(k * tMed, 1e-9);
        const next = inliers.filter((_, j) => rotDev[j] <= rotThr && tDev[j] <= tThr);
        if (next.length === inliers.length || next.length < 2) break;
        inliers = next;
    }
    const R = quaternionToMatrix(q);
    let tVar = 0, rotVar = 0;
    for (const i of inliers) {
        tVar += norm3(sub3(poses[i].t, t)) ** 2;
        rotVar += quaternionAngle(quats[i], q) ** 2;
    }
    return {
        R, t, rvec: quaternionToRodrigues(q), inliers,
        tStd: Math.sqrt(tVar / inliers.length),
        rotStdDeg: Math.sqrt(rotVar / inliers.length) * 180 / Math.PI,
    };
}

export function median(arr) {
    if (arr.length === 0) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(arr, p) {
    if (arr.length === 0) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
    return s[idx];
}

/**
 * Project a 3D world point through a pinhole camera with Brown–Conrady
 * distortion [k1, k2, p1, p2, k3]. Same model as OpenCV projectPoints.
 * @param {number[]} X world point [x, y, z]
 * @param {{R:number[][], t:number[], K:number[][], dist:number[]}} cam
 * @returns {[number, number]} pixel coords, or [NaN, NaN] if behind camera
 */
export function projectPoint(X, cam) {
    const p = add3(rotateVector(cam.R, X), cam.t);
    if (p[2] <= 1e-9) return [NaN, NaN];
    const xn = p[0] / p[2], yn = p[1] / p[2];
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = cam.dist || [];
    const r2 = xn * xn + yn * yn, r4 = r2 * r2, r6 = r4 * r2;
    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const xd = xn * radial + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
    const yd = yn * radial + 2 * p2 * xn * yn + p1 * (r2 + 2 * yn * yn);
    const K = cam.K;
    return [K[0][0] * xd + K[0][1] * yd + K[0][2], K[1][1] * yd + K[1][2]];
}

/**
 * Project many points: obj is a flat Float64Array/array [x,y,z,...];
 * returns Float32Array [u,v,...].
 */
export function projectPoints(obj, cam) {
    const n = obj.length / 3;
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const [u, v] = projectPoint([obj[i * 3], obj[i * 3 + 1], obj[i * 3 + 2]], cam);
        out[i * 2] = u; out[i * 2 + 1] = v;
    }
    return out;
}

/** RMS of per-point Euclidean distances between two flat [u,v,...] arrays. */
export function rmsPointError(a, b) {
    const n = Math.min(a.length, b.length) / 2;
    if (n === 0) return NaN;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const dx = a[i * 2] - b[i * 2], dy = a[i * 2 + 1] - b[i * 2 + 1];
        s += dx * dx + dy * dy;
    }
    return Math.sqrt(s / n);
}

/** Build a camera object usable by projectPoint from intrinsics + extrinsics records. */
export function makeCamera(intr, extr) {
    return {
        K: intr.K,
        dist: intr.dist,
        R: extr ? extr.R : IDENTITY_R(),
        t: extr ? extr.tvec : [0, 0, 0],
    };
}

/** Camera in the sba-solver-wasm format. */
export function toWasmCamera(intr, extr) {
    return {
        rotation: matrixToQuaternion(extr.R),
        translation: [extr.tvec[0], extr.tvec[1], extr.tvec[2]],
        focal: [intr.K[0][0], intr.K[1][1]],
        principal: [intr.K[0][2], intr.K[1][2]],
        distortion: [intr.dist[0], intr.dist[1], intr.dist[2], intr.dist[3], intr.dist[4]],
    };
}

/** Camera center in world coords: C = -R^T t. */
export function cameraCenter(R, t) {
    return scale3(rotateVector(transpose(R), t), -1);
}
