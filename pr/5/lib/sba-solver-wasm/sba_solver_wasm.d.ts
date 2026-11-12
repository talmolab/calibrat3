/* tslint:disable */
/* eslint-disable */

export class WasmBundleAdjuster {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get current configuration as JSON.
   */
  get_config(): string;
  /**
   * Get the number of 3D points.
   */
  num_points(): number;
  /**
   * Set solver configuration from JSON string.
   */
  set_config(config_json: string): void;
  /**
   * Set 3D points from JSON string.
   */
  set_points(points_json: string): void;
  /**
   * Get the number of cameras.
   */
  num_cameras(): number;
  /**
   * Set cameras from JSON string.
   */
  set_cameras(cameras_json: string): void;
  /**
   * Get the number of observations.
   */
  num_observations(): number;
  /**
   * Set observations from JSON string.
   */
  set_observations(observations_json: string): void;
  /**
   * Set point-to-frame mapping from JSON string.
   * This is an array where point_to_frame[i] is the frame index for point i.
   * Required for frame filtering (ignore_frames config option).
   */
  set_point_to_frame(point_to_frame_json: string): void;
  /**
   * Create a new bundle adjuster instance.
   */
  constructor();
  /**
   * Run bundle adjustment optimization.
   * Returns a JSON string with the optimization result.
   */
  optimize(): string;
}

/**
 * Compute reprojection errors for all observations.
 *
 * Input JSON format:
 * - cameras: Array of CameraParams
 * - points: Array of [x, y, z] 3D points
 * - observations: Array of {camera_idx, point_idx, x, y}
 *
 * Returns JSON with ReprojectionErrorResult
 */
export function compute_reprojection_errors(cameras_json: string, points_json: string, observations_json: string): string;

/**
 * Initialize panic hook for better error messages in browser console.
 */
export function init(): void;

/**
 * Project 3D points through a camera to 2D pixel coordinates.
 *
 * Input JSON format:
 * - points: Array of [x, y, z] 3D points
 * - camera: Single CameraParams object
 *
 * Returns JSON array of [u, v] pixel coordinates (NaN for points behind camera)
 */
export function project_points(points_json: string, camera_json: string): string;

/**
 * Triangulate a single 3D point from multiple 2D observations.
 *
 * Input JSON format:
 * - observations: Array of {camera_idx, x, y}
 * - cameras: Array of CameraParams
 *
 * Returns JSON with {point: [x, y, z], reprojection_error, num_observations}
 */
export function triangulate_point(observations_json: string, cameras_json: string): string;

/**
 * Batch triangulate multiple 3D points from their 2D observations.
 *
 * Input JSON format:
 * - point_observations: Array of arrays of {camera_idx, x, y} (one array per point)
 * - cameras: Array of CameraParams
 *
 * Returns JSON with BatchTriangulationResult
 */
export function triangulate_points(point_observations_json: string, cameras_json: string): string;

/**
 * Undistort 2D points (remove lens distortion) using iterative refinement.
 *
 * This converts distorted pixel coordinates to undistorted normalized coordinates,
 * then back to undistorted pixel coordinates.
 *
 * Input JSON format:
 * - points: Array of [u, v] distorted pixel coordinates
 * - camera: Single CameraParams object
 *
 * Returns JSON array of [u, v] undistorted pixel coordinates
 */
export function undistort_points(points_json: string, camera_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmbundleadjuster_free: (a: number, b: number) => void;
  readonly compute_reprojection_errors: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly project_points: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly triangulate_point: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly triangulate_points: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly undistort_points: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly wasmbundleadjuster_get_config: (a: number) => [number, number, number, number];
  readonly wasmbundleadjuster_new: () => number;
  readonly wasmbundleadjuster_num_cameras: (a: number) => number;
  readonly wasmbundleadjuster_num_observations: (a: number) => number;
  readonly wasmbundleadjuster_num_points: (a: number) => number;
  readonly wasmbundleadjuster_optimize: (a: number) => [number, number, number, number];
  readonly wasmbundleadjuster_set_cameras: (a: number, b: number, c: number) => [number, number];
  readonly wasmbundleadjuster_set_config: (a: number, b: number, c: number) => [number, number];
  readonly wasmbundleadjuster_set_observations: (a: number, b: number, c: number) => [number, number];
  readonly wasmbundleadjuster_set_point_to_frame: (a: number, b: number, c: number) => [number, number];
  readonly wasmbundleadjuster_set_points: (a: number, b: number, c: number) => [number, number];
  readonly init: () => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
