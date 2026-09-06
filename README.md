# calibrat3

Browser-based multi-camera **ChArUco calibration** GUI. Load synchronized calibration
videos, detect board corners across thousands of frames, estimate intrinsics and
extrinsics, refine with bundle adjustment, and export a
[sleap-anipose](https://github.com/talmolab/sleap-anipose)-compatible `calibration.toml`.

**Live:** https://talmolab.github.io/calibrat3/ (deployed from `main`; PRs get previews at `/pr/<n>/`).

calibrat3 is the standalone successor of the `calibration-studio` vibe
(`talmolab/vibes`), rebuilt with the same architecture as
[luc3d](https://github.com/talmolab/luc3d): no build step, vanilla ES modules, vendored
and pinned dependencies, web workers for anything heavy.

## Features

- **Video loading** via WebCodecs + mp4box.js, frame-accurate, with streaming
  playback (one decode per displayed frame per view, even for 18 cameras with
  200-frame GOPs), from a local folder
  (File System Access API, with an `<input webkitdirectory>` fallback) or the bundled
  sample session. Two folder layouts:
  - flat: `{root}/{view}.mp4`
  - anipose-style: `{root}/{view}/calibration_images/*.mp4` (also `calibration/`)

  A `board.toml` next to the videos fills in the board form.
- **Batch ChArUco detection that scales.** One sequential decode pass per view feeds
  a pool of OpenCV.js web workers (detectors built once per board config). Frames
  are never drawn to the display during the run, back-pressure keeps memory flat,
  and progress is one throttled bar. Thousands of frames are fine; the UI stays live.
- **Detection results without DOM bloat:** a canvas frame strip (one column per
  sampled frame) plus a virtualized, filterable table in a fixed-height scroller.
- **Intrinsics** per camera in a calibration worker with progress, selectable
  distortion model (k1-only by default, as anipose — it gave the best cross-view
  consistency on an 18-camera rig; k1k2 / k1k2k3 / full available), optional
  coverage-based frame subsampling (default 50 frames/camera chosen for image
  coverage), per-frame reprojection errors for *every* valid frame, swarm plot,
  worst-frames gallery with lazy thumbnails captured during detection, and
  frame exclusion keyed by video frame (`X`).
- **Extrinsics** from a covisibility graph → BFS pose chain → per-pair relative
  poses (solvePnP both cameras, robust quaternion averaging with outlier
  rejection) → chained absolute poses. Cross-view triangulation (pure-JS DLT on
  undistorted normalized coordinates, as aniposelib) and reprojection with
  per-frame/per-camera aggregation.
- **Bundle adjustment** with a sparse Levenberg–Marquardt solver written in JS
  (`calib/bundle-adjust.js`: Schur elimination of points and per-frame board poses,
  analytic Jacobians) with a soft board-rigidity term. Default intrinsics model:
  fx, fy + principal point + k1 + k2 per camera (lowest cross-view error on every rig
  tested: 0.10 px on an 8-camera rig, 0.21 px on an 18-camera rig where aniposelib's
  own calibrations score 0.60 and 1.36 px on the same detections); aniposelib's model
  (one focal + k1, principal point at the image centre), f + c + k1, f + k1 + k2 and
  the original `@talmolab/sba-solver-wasm` engine (all 9 intrinsics) are selectable.
  Anipose-style iterative outlier rejection (per-point thresholds decreasing over
  rounds, re-triangulation each round), optional robust loss, choice of what to optimize,
  point cap, live iteration progress, a refined-reprojection section
  with an anipose-style error histogram (initial vs refined), before/after per-camera
  table, Best/Worst frame galleries (best shown first), convergence chart, one-click revert.
- **Export:** `calibration.toml` (sleap-anipose), a full `calibration_data.json`
  (all observations, triangulated points, per-camera errors), `board.toml`, and a
  **session save** (`*.calibrat3.json`) that restores detections and results
  without re-detecting.
- **Diagnostics everywhere:** a ring-buffered log with a verbose toggle, timing
  for every step, reprojection overlays layered on the video (detections,
  intrinsic reprojection, triangulated reprojection), per-frame badges.

## Usage

```bash
python3 server.py            # http://localhost:8080/  (adds HTTP Range support)
# or: python3 -m http.server 8080
```

1. **Load videos** — *Load sample session* (sleap-anipose `minimal_session`, 4 views)
   or *Open session folder…*.
2. **Detect** — check the board, optionally *Detect current frame (D)* to verify,
   set *Target samples* (or *every frame*), *Run batch detection*.
3. **Intrinsics** — *Compute intrinsics*. Inspect the strip / plot / worst frames,
   exclude bad frames (`X`, or ✕ on a card), recompute.
4. **Extrinsics** — choose the reference camera, *Compute extrinsics*, then
   *Refine (bundle adjustment)*. Exclude frames from the cross-view set if needed.
5. **Export** — download `calibration.toml` / JSON, or save the session.

### Keyboard

| Key | Action |
| --- | --- |
| ← / → , ↑ / ↓ | ±1 / ±10 frames |
| Space, Home, End | play/pause, first, last |
| `[` / `]` | previous / next sampled frame |
| `{` / `}` | previous / next worst frame (active stage) |
| `X` | toggle exclusion of the current frame (intrinsics or extrinsics, whichever stage you touched last) |
| `D` | detect the current frame |
| `+` / `-` / `0`, wheel, drag, double-click | zoom / pan views |

## Repository layout

```
index.html, app.js, styles.css     markup, 2-line ESM entry, styles
calib/          pure logic (board, geometry, detection store, covisibility, frame
                selection, intrinsics, extrinsics, triangulation, sba) + initialization
ui/             app state, log panel, stages, video panel, overlays, frame strip,
                virtual table, plots, gallery, per-stage controllers
loading/        video decoder + batch iterator, detect worker + pool, calib worker + client,
                folder loader
import-export/  toml, calibration JSON, session save/load
lib/            vendored deps with PROVENANCE.txt: opencv (4.13.0), sba-solver-wasm (0.2.0), mp4box (0.5.2)
sample_session/ sleap-anipose minimal_session (4 short videos + board.toml)
tests/          Node ESM unit tests (node tests/run-mjs-tests.mjs)
.github/workflows/  Pages deploy from main + PR previews
```

See `MODULES.md` for per-module details and `CLAUDE.md` for architecture notes,
dependency pins and gotchas.

## Tests

```bash
node tests/run-mjs-tests.mjs           # pure-logic unit tests in Node (no browser needed)
# same tests in the browser (also on the deployed site):
#   http://localhost:8080/tests/test-runner.html
#   https://talmolab.github.io/calibrat3/tests/test-runner.html

# real-browser end-to-end tests (headless Chromium via Playwright; see tests/e2e/README.md)
python3 server.py 8080 &
node tests/e2e/smoke-pipeline.mjs                                   # sample session, full pipeline
SESSION=/tmp/synthetic_session node tests/e2e/stress-synthetic.mjs  # 4 cams × 1200 frames vs ground truth
SESSION=/path/to/real/session TARGET=600 node tests/e2e/real-session.mjs  # playback smoothness + pipeline report (+ anipose reference comparison)
```

The stress session is generated by `scripts/make_synthetic_session.py` (numpy,
opencv-contrib-python-headless, imageio-ffmpeg; `uv run --with …` works). It renders
a moving ChArUco board seen by N virtual cameras with known intrinsics/extrinsics
into an anipose-style folder, plus `calibration_gt.toml`.

## Export format

```toml
[cam_0]
name = "back"
size = [1280, 1024]
matrix = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]
distortions = [k1, k2, p1, p2, k3]
rotation = [rx, ry, rz]        # Rodrigues, world (= reference camera) -> camera
translation = [tx, ty, tz]     # board units (mm)
```

## Browser support

Chromium-based browsers (Chrome, Edge) — WebCodecs, OffscreenCanvas in workers, and
the File System Access API. Firefox works for the sample session and the
`webkitdirectory` fallback where WebCodecs is enabled.
