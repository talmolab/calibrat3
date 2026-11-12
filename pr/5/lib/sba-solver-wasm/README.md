# sba-solver-wasm

WebAssembly module for sparse bundle adjustment, enabling browser-based multicamera calibration refinement.

## Installation

### npm

```bash
npm install @talmolab/sba-solver-wasm
```

### CDN

Load directly from jsDelivr (no build step required):

```html
<script type="module">
import init, { WasmBundleAdjuster } from
  'https://cdn.jsdelivr.net/npm/@talmolab/sba-solver-wasm@latest/sba_solver_wasm.js';

await init();
const ba = new WasmBundleAdjuster();
// ...
</script>
```

The WASM binary is automatically loaded from the same CDN path.

### Build from source

```bash
# Prerequisites: Rust nightly, wasm-pack
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# Build
npm run build

# Test
npm install
npm test
```

## Quick Start

### Recommended: Use the Wrapper

For the cleanest API, use the wrapper module:

```javascript
import { initSBA, runBundleAdjustment } from '@talmolab/sba-solver-wasm/wrapper';

await initSBA();

const result = await runBundleAdjustment({
    cameras: [...],
    points: [...],
    observations: [...]
}, {
    max_iterations: 100,
    robust_loss: 'huber',
    robust_loss_param: 1.0,
    optimize_extrinsics: true,
    optimize_points: true
});

console.log(`Cost: ${result.initial_cost} -> ${result.final_cost}`);
```

### Raw WASM API

```javascript
import init, { WasmBundleAdjuster } from '@talmolab/sba-solver-wasm';

await init();
const ba = new WasmBundleAdjuster();

ba.set_cameras(JSON.stringify(cameras));
ba.set_points(JSON.stringify(points));
ba.set_observations(JSON.stringify(observations));
ba.set_config(JSON.stringify({ max_iterations: 100 }));

const result = JSON.parse(ba.optimize());
```

## Features

- **Sparse Bundle Adjustment** - Levenberg-Marquardt optimization for camera calibration
- **Radial-Tangential Distortion** - Full Brown-Conrady model (k1, k2, k3, p1, p2)
- **SE3 Poses** - Proper manifold optimization for camera rotations
- **Robust Loss Functions** - Huber and Cauchy loss for outlier rejection
- **Triangulation** - DLT algorithm for 3D point reconstruction from 2D observations
- **Batch Operations** - Efficient batch reprojection and projection
- **Point Undistortion** - Iterative distortion removal
- **Pure WebAssembly** - No server required (~720KB)

## API Reference

### Camera Parameters

```typescript
interface CameraParams {
  rotation: [number, number, number, number];  // Quaternion [w, x, y, z]
  translation: [number, number, number];       // [x, y, z]
  focal: [number, number];                     // [fx, fy] in pixels
  principal: [number, number];                 // [cx, cy] in pixels
  distortion: [number, number, number, number, number];  // [k1, k2, p1, p2, k3]
}
```

### Observations

```typescript
interface Observation {
  camera_idx: number;  // Index into cameras array
  point_idx: number;   // Index into points array
  x: number;           // Observed x in pixels
  y: number;           // Observed y in pixels
}
```

### Solver Configuration

```typescript
interface SolverConfig {
  max_iterations?: number;        // Default: 100
  cost_tolerance?: number;        // Default: 1e-6
  parameter_tolerance?: number;   // Default: 1e-8
  gradient_tolerance?: number;    // Default: 1e-10
  robust_loss?: string;           // "none", "huber", or "cauchy"
  robust_loss_param?: number;     // Loss function parameter
  optimize_extrinsics?: boolean;  // Default: true
  optimize_points?: boolean;      // Default: true
  optimize_intrinsics?: boolean;  // Default: false
  outlier_threshold?: number;     // Reject observations with error > threshold (0 = disabled)
  reference_camera?: number;      // Camera index to fix as gauge reference (default: 0)
  ignore_frames?: number[];       // Frame indices to exclude from optimization
}
```

### Result

```typescript
interface BundleAdjustmentResult {
  cameras: CameraParams[];
  points: [number, number, number][];
  initial_cost: number;
  final_cost: number;
  iterations: number;
  converged: boolean;
  status: string;
  cost_history: number[];              // Cost at each iteration
  num_observations_used: number;
  num_observations_filtered: number;
  num_observations_filtered_by_frame: number;
}
```

## Wrapper API Functions

The wrapper module (`@talmolab/sba-solver-wasm/wrapper`) provides these convenience functions:

### Bundle Adjustment

```javascript
import { initSBA, runBundleAdjustment } from '@talmolab/sba-solver-wasm/wrapper';

// Initialize (auto-called if needed)
await initSBA();

// Run optimization
const result = await runBundleAdjustment(data, config);
```

### Triangulation

```javascript
import { triangulatePoint, triangulatePoints } from '@talmolab/sba-solver-wasm/wrapper';

// Single point
const result = await triangulatePoint([
    { camera_idx: 0, x: 320, y: 240 },
    { camera_idx: 1, x: 340, y: 245 }
], cameras);
console.log(result.point);  // [x, y, z]

// Batch triangulation
const batch = await triangulatePoints(pointObservations, cameras);
console.log(batch.points);  // [[x,y,z], [x,y,z], ...]
```

### Reprojection Errors

```javascript
import { computeReprojectionErrors, projectPoints } from '@talmolab/sba-solver-wasm/wrapper';

// Compute errors for all observations
const errors = await computeReprojectionErrors(cameras, points, observations);
console.log(`RMS Error: ${errors.rms_error} px`);

// Project points through a camera
const projected = await projectPoints(points3d, camera);
```

### Point Undistortion

```javascript
import { undistortPoints } from '@talmolab/sba-solver-wasm/wrapper';

// Remove lens distortion from 2D points
const undistorted = await undistortPoints([[320, 240], [400, 300]], camera);
```

### Utility Functions

```javascript
import {
    projectPoint,
    computeReprojectionError,
    computeErrorStats,
    rotationMatrixToQuaternion,
    quaternionToRotationMatrix
} from '@talmolab/sba-solver-wasm/wrapper';

// Project a single point (JS implementation, no WASM call)
const [u, v] = projectPoint([0, 0, 5], camera);

// Compute single reprojection error
const error = computeReprojectionError([0, 0, 5], camera, [320, 240]);

// Statistics for an array of errors
const stats = computeErrorStats(errors);
console.log(`Mean: ${stats.mean}, P95: ${stats.p95}`);

// Quaternion conversions
const quat = rotationMatrixToQuaternion(R);  // R is 3x3 array
const R = quaternionToRotationMatrix(quat);  // quat is [w, x, y, z]
```

## Cost History Visualization

The solver returns `cost_history` containing the cost at each iteration, useful for visualizing convergence:

```javascript
const result = await runBundleAdjustment(data, config);

// Plot with Chart.js
new Chart(ctx, {
    type: 'line',
    data: {
        labels: result.cost_history.map((_, i) => i),
        datasets: [{
            label: 'Cost',
            data: result.cost_history,
            borderColor: 'blue'
        }]
    },
    options: {
        scales: {
            y: { type: 'logarithmic' }
        }
    }
});
```

## Quaternion Convention

This library uses **[w, x, y, z]** quaternion ordering (scalar-first), which is common in robotics and matches libraries like Eigen and nalgebra.

To convert from a 3x3 rotation matrix, use the wrapper utility:

```javascript
import { rotationMatrixToQuaternion } from '@talmolab/sba-solver-wasm/wrapper';

const R = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
];
const [w, x, y, z] = rotationMatrixToQuaternion(R);
```

## Complete Example: Multi-Camera Calibration

```javascript
import { initSBA, runBundleAdjustment, triangulatePoints } from '@talmolab/sba-solver-wasm/wrapper';

await initSBA();

// 1. Prepare camera parameters (from intrinsic calibration)
const cameras = viewNames.map(name => ({
    rotation: rotationMatrixToQuaternion(extrinsics[name].R),
    translation: extrinsics[name].tvec,
    focal: [intrinsics[name].fx, intrinsics[name].fy],
    principal: [intrinsics[name].cx, intrinsics[name].cy],
    distortion: [
        intrinsics[name].k1,
        intrinsics[name].k2,
        intrinsics[name].p1,
        intrinsics[name].p2,
        intrinsics[name].k3
    ]
}));

// 2. Triangulate 3D points from 2D detections
const pointObservations = buildObservationsPerPoint(detections);
const triangulated = await triangulatePoints(pointObservations, cameras);
const points = triangulated.points;

// 3. Build observations array
const observations = [];
for (const detection of detections) {
    for (const [camIdx, points2d] of detection.entries()) {
        for (const [pointIdx, pt] of points2d.entries()) {
            observations.push({
                camera_idx: camIdx,
                point_idx: pointIdx,
                x: pt.x,
                y: pt.y
            });
        }
    }
}

// 4. Run bundle adjustment
const result = await runBundleAdjustment(
    { cameras, points, observations },
    {
        max_iterations: 100,
        robust_loss: 'huber',
        robust_loss_param: 1.0,
        reference_camera: 0  // Fix first camera as origin
    }
);

console.log(`Converged: ${result.converged}`);
console.log(`Cost: ${result.initial_cost.toFixed(2)} -> ${result.final_cost.toFixed(2)}`);

// 5. Apply refined parameters
result.cameras.forEach((cam, i) => {
    extrinsics[viewNames[i]].R = quaternionToRotationMatrix(cam.rotation);
    extrinsics[viewNames[i]].tvec = cam.translation;
});
```

## Development

```bash
# Run Rust tests
cargo test

# Build WASM (debug)
npm run build:dev

# Build WASM (release)
npm run build

# Run browser tests
npm test

# Run with visible browser
npm run test:headed

# Serve examples locally
npm run serve
# Open http://localhost:8080/examples/
```

## Technical Details

This module uses a fork of [apex-solver](https://github.com/amin-abouee/apex-solver) modified for WASM compatibility. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for architecture details, the apex-solver fork, and development notes.

## License

Apache-2.0
