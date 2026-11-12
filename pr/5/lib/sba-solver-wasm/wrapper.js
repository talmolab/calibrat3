/**
 * Bundle Adjustment Wrapper for @talmolab/sba-solver-wasm
 *
 * Provides a clean API for running sparse bundle adjustment using the WASM module.
 *
 * @module @talmolab/sba-solver-wasm/wrapper
 *
 * @example
 * import { initSBA, runBundleAdjustment } from '@talmolab/sba-solver-wasm/wrapper';
 *
 * // Initialize WASM (auto-initializes on first call if not done explicitly)
 * await initSBA();
 *
 * // Run optimization
 * const result = await runBundleAdjustment({
 *     cameras: [...],
 *     points: [...],
 *     observations: [...],
 * }, {
 *     max_iterations: 100,
 *     robust_loss: 'huber',
 * });
 */

// WASM module path - relative to this wrapper
const WASM_MODULE_URL = new URL('./sba_solver_wasm.js', import.meta.url).href;

let wasmModule = null;
let initialized = false;

/**
 * Initialize the WASM module.
 * Called automatically on first use, but can be called explicitly for preloading.
 *
 * @param {string} [moduleUrl] - Optional URL to load module from (for CDN usage)
 * @returns {Promise<void>}
 */
export async function initSBA(moduleUrl = WASM_MODULE_URL) {
    if (initialized) return;

    wasmModule = await import(moduleUrl);
    await wasmModule.default();
    initialized = true;
}

/**
 * Check if the WASM module is initialized.
 * @returns {boolean}
 */
export function isInitialized() {
    return initialized;
}

/**
 * Get the raw WASM module for advanced usage.
 * @returns {Object|null} The WASM module or null if not initialized
 */
export function getWasmModule() {
    return wasmModule;
}

/**
 * Default configuration for bundle adjustment.
 */
const DEFAULT_CONFIG = {
    // Solver settings
    max_iterations: 100,
    cost_tolerance: 1e-6,
    parameter_tolerance: 1e-8,
    gradient_tolerance: 1e-10,

    // Robust loss function
    robust_loss: 'huber',      // 'none', 'huber', or 'cauchy'
    robust_loss_param: 1.0,    // Scale parameter for robust loss

    // What to optimize
    optimize_extrinsics: true,
    optimize_points: true,
    optimize_intrinsics: false,

    // Outlier handling
    outlier_threshold: 0,      // 0 = disabled, otherwise filter observations with error > threshold

    // Gauge fixing
    reference_camera: 0,       // Camera index to hold fixed (gauge reference)

    // Frame filtering
    ignore_frames: [],         // Array of frame indices to exclude from optimization
};

/**
 * @typedef {Object} CameraParams
 * @property {[number, number, number, number]} rotation - Quaternion [w, x, y, z] (world-to-camera)
 * @property {[number, number, number]} translation - Translation [x, y, z] (world-to-camera)
 * @property {[number, number]} focal - Focal lengths [fx, fy] in pixels
 * @property {[number, number]} principal - Principal point [cx, cy] in pixels
 * @property {[number, number, number, number, number]} distortion - [k1, k2, p1, p2, k3]
 */

/**
 * @typedef {Object} Observation
 * @property {number} camera_idx - Camera index
 * @property {number} point_idx - Point index
 * @property {number} x - Observed x coordinate in pixels
 * @property {number} y - Observed y coordinate in pixels
 */

/**
 * @typedef {Object} BundleAdjustmentData
 * @property {CameraParams[]} cameras - Camera parameters
 * @property {[number, number, number][]} points - 3D points
 * @property {Observation[]} observations - 2D observations
 * @property {number[]} [point_to_frame] - Optional mapping from point index to frame index
 */

/**
 * @typedef {Object} SolverConfig
 * @property {number} [max_iterations=100] - Maximum solver iterations
 * @property {number} [cost_tolerance=1e-6] - Cost change tolerance for convergence
 * @property {number} [parameter_tolerance=1e-8] - Parameter change tolerance
 * @property {number} [gradient_tolerance=1e-10] - Gradient tolerance
 * @property {string} [robust_loss='huber'] - 'none', 'huber', or 'cauchy'
 * @property {number} [robust_loss_param=1.0] - Scale parameter for robust loss
 * @property {boolean} [optimize_extrinsics=true] - Optimize camera poses
 * @property {boolean} [optimize_points=true] - Optimize 3D points
 * @property {boolean} [optimize_intrinsics=false] - Optimize camera intrinsics
 * @property {number} [outlier_threshold=0] - Outlier rejection threshold (0 = disabled)
 * @property {number} [reference_camera=0] - Camera index to fix as gauge reference
 * @property {number[]} [ignore_frames=[]] - Frame indices to exclude
 */

/**
 * @typedef {Object} BundleAdjustmentResult
 * @property {CameraParams[]} cameras - Optimized camera parameters
 * @property {[number, number, number][]} points - Optimized 3D points
 * @property {number} initial_cost - Initial sum of squared reprojection errors
 * @property {number} final_cost - Final cost after optimization
 * @property {number} iterations - Number of iterations performed
 * @property {boolean} converged - Whether the solver converged
 * @property {string} status - Convergence status message
 * @property {number[]} cost_history - Cost at each iteration (for plotting convergence)
 * @property {number} num_observations_used - Number of observations used (after filtering)
 * @property {number} num_observations_filtered - Number of outliers filtered
 * @property {number} num_observations_filtered_by_frame - Number filtered by frame
 */

/**
 * Run sparse bundle adjustment on calibration data.
 *
 * @param {BundleAdjustmentData} data - Input data (cameras, points, observations)
 * @param {SolverConfig} [config] - Configuration options (merged with defaults)
 * @returns {Promise<BundleAdjustmentResult>} Optimization result
 * @throws {Error} If input data is invalid
 */
export async function runBundleAdjustment(data, config = {}) {
    // Ensure WASM is initialized
    await initSBA();

    // Validate required data
    if (!data.cameras || !Array.isArray(data.cameras)) {
        throw new Error('data.cameras is required and must be an array');
    }
    if (!data.points || !Array.isArray(data.points)) {
        throw new Error('data.points is required and must be an array');
    }
    if (!data.observations || !Array.isArray(data.observations)) {
        throw new Error('data.observations is required and must be an array');
    }

    // Create bundle adjuster instance
    const ba = new wasmModule.WasmBundleAdjuster();

    // Set input data
    ba.set_cameras(JSON.stringify(data.cameras));
    ba.set_points(JSON.stringify(data.points));
    ba.set_observations(JSON.stringify(data.observations));

    // Set optional point-to-frame mapping (needed for frame filtering)
    if (data.point_to_frame && Array.isArray(data.point_to_frame)) {
        ba.set_point_to_frame(JSON.stringify(data.point_to_frame));
    }

    // Merge config with defaults
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    ba.set_config(JSON.stringify(fullConfig));

    // Run optimization
    const resultJson = ba.optimize();

    return JSON.parse(resultJson);
}

/**
 * Project a 3D point to 2D using camera parameters.
 *
 * @param {[number, number, number]} point3d - 3D point in world coordinates
 * @param {CameraParams} camera - Camera parameters
 * @returns {[number, number]} Projected 2D point in pixels, or [NaN, NaN] if behind camera
 */
export function projectPoint(point3d, camera) {
    // Transform point from world to camera coordinates
    const [w, x, y, z] = camera.rotation;
    const p = point3d;

    // Quaternion rotation: p' = q * p * q^-1
    const rotated = quaternionRotate([w, x, y, z], p);

    // Add translation
    const camPoint = [
        rotated[0] + camera.translation[0],
        rotated[1] + camera.translation[1],
        rotated[2] + camera.translation[2]
    ];

    // Check for points behind camera
    if (camPoint[2] <= 0) {
        return [NaN, NaN];
    }

    // Normalize
    const xn = camPoint[0] / camPoint[2];
    const yn = camPoint[1] / camPoint[2];

    // Apply distortion
    const [k1, k2, p1, p2, k3] = camera.distortion;
    const r2 = xn * xn + yn * yn;
    const r4 = r2 * r2;
    const r6 = r4 * r2;

    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const xd = xn * radial + 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
    const yd = yn * radial + 2 * p2 * xn * yn + p1 * (r2 + 2 * yn * yn);

    // Project to pixels
    const [fx, fy] = camera.focal;
    const [cx, cy] = camera.principal;

    return [fx * xd + cx, fy * yd + cy];
}

/**
 * Compute reprojection error for a single observation.
 *
 * @param {[number, number, number]} point3d - 3D point in world coordinates
 * @param {CameraParams} camera - Camera parameters
 * @param {[number, number]} observed - Observed 2D point in pixels
 * @returns {number} Euclidean reprojection error in pixels (Infinity if point is behind camera)
 */
export function computeReprojectionError(point3d, camera, observed) {
    const projected = projectPoint(point3d, camera);
    if (isNaN(projected[0]) || isNaN(projected[1])) {
        return Infinity;
    }
    return Math.sqrt(
        Math.pow(projected[0] - observed[0], 2) +
        Math.pow(projected[1] - observed[1], 2)
    );
}

/**
 * Compute statistics for an array of error values.
 *
 * @param {number[]} errors - Array of error values
 * @returns {Object|null} Statistics or null if empty
 * @property {number} min - Minimum error
 * @property {number} max - Maximum error
 * @property {number} mean - Mean error
 * @property {number} median - Median error
 * @property {number} rms - Root mean square error
 * @property {number} p90 - 90th percentile
 * @property {number} p95 - 95th percentile
 * @property {number} p99 - 99th percentile
 * @property {number} count - Number of values
 */
export function computeErrorStats(errors) {
    if (!errors || !errors.length) return null;

    const sorted = [...errors].filter(e => isFinite(e)).sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return null;

    const sum = sorted.reduce((a, b) => a + b, 0);
    const sumSq = sorted.reduce((a, b) => a + b * b, 0);

    return {
        min: sorted[0],
        max: sorted[n - 1],
        mean: sum / n,
        median: n % 2 === 0 ? (sorted[n/2 - 1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)],
        rms: Math.sqrt(sumSq / n),
        p90: sorted[Math.floor(n * 0.9)] || sorted[n - 1],
        p95: sorted[Math.floor(n * 0.95)] || sorted[n - 1],
        p99: sorted[Math.floor(n * 0.99)] || sorted[n - 1],
        count: n
    };
}

/**
 * Convert a 3x3 rotation matrix to quaternion [w, x, y, z].
 *
 * @param {number[][]} R - 3x3 rotation matrix (row-major)
 * @returns {[number, number, number, number]} Quaternion [w, x, y, z]
 */
export function rotationMatrixToQuaternion(R) {
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

    // Normalize
    const norm = Math.sqrt(w*w + x*x + y*y + z*z);
    return [w/norm, x/norm, y/norm, z/norm];
}

/**
 * Convert a quaternion [w, x, y, z] to a 3x3 rotation matrix.
 *
 * @param {[number, number, number, number]} q - Quaternion [w, x, y, z]
 * @returns {number[][]} 3x3 rotation matrix (row-major)
 */
export function quaternionToRotationMatrix(q) {
    const [w, x, y, z] = q;

    // Normalize quaternion
    const n = Math.sqrt(w*w + x*x + y*y + z*z);
    const qw = w/n, qx = x/n, qy = y/n, qz = z/n;

    return [
        [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw), 2*(qx*qz + qy*qw)],
        [2*(qx*qy + qz*qw), 1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)],
        [2*(qx*qz - qy*qw), 2*(qy*qz + qx*qw), 1 - 2*(qx*qx + qy*qy)]
    ];
}

// ============================================================================
// Triangulation API
// ============================================================================

/**
 * @typedef {Object} TriangulationObservation
 * @property {number} camera_idx - Camera index
 * @property {number} x - Observed x coordinate in pixels
 * @property {number} y - Observed y coordinate in pixels
 */

/**
 * @typedef {Object} TriangulationResult
 * @property {[number, number, number]} point - Triangulated 3D point
 * @property {number} reprojection_error - RMS reprojection error in pixels
 * @property {number} num_observations - Number of observations used
 */

/**
 * Triangulate a single 3D point from multiple 2D observations using DLT.
 *
 * @param {TriangulationObservation[]} observations - 2D observations (at least 2 required)
 * @param {CameraParams[]} cameras - Camera parameters
 * @returns {Promise<TriangulationResult>} Triangulation result
 */
export async function triangulatePoint(observations, cameras) {
    await initSBA();
    const resultJson = wasmModule.triangulate_point(
        JSON.stringify(observations),
        JSON.stringify(cameras)
    );
    return JSON.parse(resultJson);
}

/**
 * @typedef {Object} BatchTriangulationResult
 * @property {[number, number, number][]} points - Triangulated 3D points
 * @property {number[]} reprojection_errors - RMS error per point
 * @property {number} num_triangulated - Number of successfully triangulated points
 * @property {number[]} failed_indices - Indices of points that failed
 */

/**
 * Batch triangulate multiple 3D points from their 2D observations.
 *
 * @param {TriangulationObservation[][]} pointObservations - Array of observation arrays (one per point)
 * @param {CameraParams[]} cameras - Camera parameters
 * @returns {Promise<BatchTriangulationResult>} Batch triangulation result
 */
export async function triangulatePoints(pointObservations, cameras) {
    await initSBA();
    const resultJson = wasmModule.triangulate_points(
        JSON.stringify(pointObservations),
        JSON.stringify(cameras)
    );
    return JSON.parse(resultJson);
}

// ============================================================================
// Reprojection Error API
// ============================================================================

/**
 * @typedef {Object} ReprojectionErrorResult
 * @property {number[]} errors - Error per observation in pixels
 * @property {number} mean_error - Mean reprojection error
 * @property {number} rms_error - RMS reprojection error
 * @property {number} max_error - Maximum reprojection error
 * @property {[number, number][]} projected_points - Projected 2D points
 */

/**
 * Compute reprojection errors for all observations.
 *
 * @param {CameraParams[]} cameras - Camera parameters
 * @param {[number, number, number][]} points - 3D points
 * @param {Observation[]} observations - 2D observations
 * @returns {Promise<ReprojectionErrorResult>} Reprojection error statistics
 */
export async function computeReprojectionErrors(cameras, points, observations) {
    await initSBA();
    const resultJson = wasmModule.compute_reprojection_errors(
        JSON.stringify(cameras),
        JSON.stringify(points),
        JSON.stringify(observations)
    );
    return JSON.parse(resultJson);
}

/**
 * Project 3D points through a camera to 2D pixel coordinates.
 *
 * @param {[number, number, number][]} points - 3D points in world coordinates
 * @param {CameraParams} camera - Camera parameters
 * @returns {Promise<[number, number][]>} Projected 2D points (NaN for points behind camera)
 */
export async function projectPoints(points, camera) {
    await initSBA();
    const resultJson = wasmModule.project_points(
        JSON.stringify(points),
        JSON.stringify(camera)
    );
    return JSON.parse(resultJson);
}

// ============================================================================
// Point Undistortion API
// ============================================================================

/**
 * Undistort 2D points (remove lens distortion).
 *
 * Uses iterative refinement to invert the distortion model.
 *
 * @param {[number, number][]} points - Distorted pixel coordinates
 * @param {CameraParams} camera - Camera parameters with distortion coefficients
 * @returns {Promise<[number, number][]>} Undistorted pixel coordinates
 */
export async function undistortPoints(points, camera) {
    await initSBA();
    const resultJson = wasmModule.undistort_points(
        JSON.stringify(points),
        JSON.stringify(camera)
    );
    return JSON.parse(resultJson);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Rotate a vector by a quaternion.
 * @private
 */
function quaternionRotate(q, v) {
    const [w, x, y, z] = q;
    const [vx, vy, vz] = v;

    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);

    // v' = v + w * t + cross(q.xyz, t)
    return [
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx)
    ];
}
