# calibrat3 — notes for Claude / contributors

Browser-based multi-camera ChArUco calibration. **No build step**: vanilla JS ES
modules served as static files, deployed to GitHub Pages from `main`. Port of the
`calibration-studio` vibe (talmolab/vibes) restructured like luc3d.

## Architecture

`index.html` loads `app.js` (`<script type="module">`), a 2-line entry that calls
`initApp()` from `calib/initialization.js`. Modules are grouped by directory:

- `calib/` — pure logic, no DOM. `board`, `geometry`, `detection-store`,
  `covisibility`, `frame-selection` need nothing; `intrinsics`, `extrinsics` take
  the initialized OpenCV module `cv` as first argument; `triangulation` (pure-JS DLT),
  `bundle-adjust` (pure-JS sparse LM) and `sba` (input/output plumbing shared by both
  engines) need nothing. Runs identically in the worker and in Node tests.
- `ui/` — DOM side. `app-state.js` holds THE `state` object + controller singletons;
  `events.js` is a tiny bus; one `stage-*.js` per pipeline stage.
- `loading/` — video decode (`video.js`), workers (`detect-worker.js`,
  `calib-worker.js`) and their main-thread clients (`detect-pool.js`, `calib-client.js`),
  `folder-loader.js` (session folder layouts), `opencv-ready.js`.
- `import-export/` — `toml.js` (sleap-anipose format), `sba-json.js`, `session-save.js`.

See `MODULES.md` for every module's purpose/exports/dependents.

### Threading model — the whole point of the rewrite

The old vibe fell over at ~1000 frames because it seeked (decode-from-keyframe),
rendered, detected on the main thread and appended DOM per frame. Here:

1. **Batch detection** (`ui/stage-detect.js` → `OnDemandVideoDecoder.iterateFrames`)
   walks the wanted frames in ONE pass per view, GOP by GOP, with a single
   `VideoDecoder` that is never reconfigured. Only wanted `VideoFrame`s are kept;
   every other output is closed immediately. Feeding pauses while >`maxPending`
   wanted frames await the consumer, so memory is bounded. `VideoFrame`s are
   TRANSFERRED to `detect-worker.js` (OpenCV.js in the worker; dictionary/board/
   detectors cached per board config) and closed there. Per-view in-flight cap is
   2. Thumbnails (160 px JPEG Blobs, view 0) are produced by the worker from the
   frame it already has — never re-decoded. The pool uses most cores
   (`min(12, hardwareConcurrency - 2)` workers). "Fast marker search" (opt-in)
   finds markers on a half-resolution image and refines corners at full
   resolution: ~2x faster on frames with a board, but small/far boards lose
   corners, so it is off by default.
1b. **Display decode is streaming** (`_decodeForDisplay`). The decoder stays OPEN
   between seeks: stepping/playback feeds only the next chunk(s) and waits for the
   target frame to be emitted (outputs come in presentation order); everything the
   decoder emits from the target on is kept, up to `lookahead + reorder depth`, so
   the next steps are cache hits. Only a backward/far seek restarts at the
   preceding keyframe. The bytes of the current GOP are read once per view
   (`readSampleRange` GOP cache) — `File.slice()` round-trips cost tens of ms each
   with 18 views. The output delay of B-frame decoders is learned per decoder
   (`_reorderFeed` grows on a timeout); while `decodeQueueSize > 0` we just wait.
   `ui/video-panel.js` budgets ImageBitmaps (~640 MB total): with many/large views
   the display cache holds reduced-resolution bitmaps (`bitmapScale`, drawn scaled
   onto the native-size canvas — overlays stay native) so >= 12 frames per view fit.
   Measured on the 18 x 1680x1200 session: 1.0 decode per displayed frame per view,
   0 keyframe restarts while stepping (it was ~10 decodes and a GOP restart every
   frame before).
2. **Calibration** (`calib-worker.js`, classic workers that `importScripts`
   opencv.js and `import()` the ESM calib modules + the sba wrapper; a small pool
   via `loading/calib-client.js` so per-camera intrinsics run in parallel) runs
   `calibrateCameraExtended`, per-frame solvePnP, relative poses, WASM
   triangulation and bundle adjustment. Progress messages are throttled to ~25 Hz.
   `calibrateCamera`'s LM solve is cubic in the number of frames (a dense
   (9+6n)-sized system per iteration), which is why frames are subsampled for the
   fit (default 50) and every valid frame is only *evaluated* afterwards.
3. **The main thread never loads OpenCV.** Overlays reproject with pure-JS
   `calib/geometry.js` (`projectPoints` from stored rvec/tvec).
4. **Nothing per-frame in the DOM.** Frame strip (canvas), virtualized table
   (`ui/virtual-table.js`), swarm plots with one dot per frame per camera and a
   grid-bucketed hover index, galleries capped at 40 cards with lazy thumbnails.
   `log-panel.js` is a ring buffer flushed once per animation frame; `debug`-level
   lines render only with the verbose toggle.

### Index spaces

Everything is keyed by **video frame**. Per-frame results are typed arrays paired
with a sorted `frames: Int32Array` (binary search to look up). Exclusions are
`Set<videoFrame>` (`state.exclusions.intrinsics` / `.extrinsics`). There is no
"calibration index".

### Data shapes (see `ui/app-state.js`)

- `state.detections`: `DetectionStore` — `get(frame, viewIdx) -> {ids:Int32Array, corners:Float32Array(2n), numMarkers, ms}`;
  `commonIds()` is a true id intersection (the vibe used min-count).
- `state.intrinsics[v]`: `{K, dist, fx.., rmsError, framesUsed, selectedFrames, coverage, perFrame:{frames, errors, rvecs, tvecs, used, counts}}`.
- `state.extrinsics[v]`: `{R, rvec, tvec, chain, pairStd}` or `{error}`; reference = identity.
- `state.reproj`: `{frames:[{frame, n, ids, xyz, views:[{mask, det, proj, err, mean, max, count}|null], meanErr, maxErr}], summary}`;
  `state.reprojByFrame` is its Map index.

### Bundle adjustment (`ui/stage-extrinsics.js` runSba, `calib/bundle-adjust.js`)

Two engines share `calib/sba.js` plumbing. The default is the **JS sparse LM**
(`calib/bundle-adjust.js`): aniposelib's camera model — ONE focal length + k1 per camera,
principal point pinned at the image centre, plus a soft "the corners of a frame form the
rigid board" term (weight 2 / square length px per mm, per-frame board poses as unknowns)
— with Schur elimination of points then boards, analytic Jacobians, IRLS robust losses
(default none, like anipose) and the reference camera fixed. Before the first round
`runSba` builds the anipose-style start (`f = mean(fx, fy)`, `cx, cy` = image centre) and
re-triangulates; the intrinsics model select offers `f-c-k1`, `f-k1-k2`, `fxfy-c-k1-k2`
too. The sba-solver-wasm engine ("all 9 parameters") is kept for comparison only: it cannot
fix a subset of intrinsics, so k2/k3 drift to large cancelling values on boards that never
reach the image corners. Metric scale is re-anchored to the board's corner spacing after
every solve (reprojection alone cannot observe it). Progress is posted per iteration.

Outlier rejection is done here, per POINT, anipose-style, not inside the solver: rounds
with a geometric threshold schedule; each round fits only points whose mean reprojection
error is below the threshold, applies the refined cameras, re-triangulates ALL points in
the worker and recomputes errors (so the report is on all observations, never just the
kept subset). Policies (`Rejection` select): **aggressive** reproduces aniposelib's
`bundle_adjust_iter` clamp — 6 rounds, thresholds 15 → 1 px, each clamped to [max over
camera pairs of the 15th percentile, max over pairs of the 75th percentile] of per-point
pair-mean errors (`pairErrorBounds`); **conservative** never goes below the global 80th
percentile. Model selection: if the free-intrinsics fit does not improve the re-triangulated
median, it retries with intrinsics fixed and never returns a worse result than the initial
calibration. `state.sbaResult.rounds` records each round; the UI keeps the initial
reprojection plots and adds a "Refined cross-view reprojection" section (strip, swarm,
error histogram initial vs refined, per-camera table, Best/Worst galleries).

### Cross-view triangulation is pure JS (`calib/triangulation.js` triangulateDLT)

The WASM `triangulate_points` was measured to be inaccurate — ≈3 mm / 1.5 px median error
on exact synthetic observations (`tests/test-triangulation.mjs` guards the replacement).
Every metric, SBA start point and rejection decision used to go through it, which put a
~4 px floor under everything and hid the real calibration quality. The replacement
undistorts to normalized coordinates and takes the null vector of the stacked DLT rows
(same as aniposelib). Observations that reproject > 1000 px are failed triangulations and
are dropped from the summary (`summary.dropped`).

### Benchmark against aniposelib (cal_test2, 8 cameras, 1280x1024, 2701 frames)

Scored on identical detections with independent code (aniposelib / numpy — never trust
the app's own numbers alone). aniposelib 0.8.0 on all frames: 0.31 px median on its
detections, 0.60 px on ours. calibrat3 before today's fixes: 3.8 / 3.9 px. calibrat3 now
(600 sampled frames, defaults): **0.34 px median / 4.6 p95 on our detections** (per camera
0.17–0.60, back 0.60 vs anipose's 0.83) and the camera-pair distances agree with anipose's
to 0.4 mm median / 1.5 mm max; board corner spacing 24.04 mm (true 24.00). Wall clock in
headless Chromium: detection 72 s, intrinsics 57 s, extrinsics 4 s, SBA 58 s vs aniposelib
2086 s detection + 408 s calibration. Each fix mattered: JS triangulation alone took the
initial cross-view median from 5.27 to 1.57 px; the f + k1 solver with the board term and
the single-focal start took SBA from 4.07 to 0.34 px.

### Intrinsic model: fewer distortion terms generalize better across cameras

`Distortion model` in stage 3 maps to calibrateCamera flags (`ui/stage-intrinsics.js`
`distortionFlags`): `k1` (FIX_K2|FIX_K3|ZERO_TANGENT, default, what anipose fits),
`k1k2`, `k1k2k3`, `full`. Measured on the 18-camera session (same detections, initial
extrinsics only): full 5-param model -> cross-view median 12.74 px, k1+k2 -> 12.13,
**k1 only -> 10.27** (the anipose reference: 10.80). Per-camera RMS goes the other way
(0.33 -> 1.41 px): the richer models fit per-camera systematic effects (motion / rolling
shutter / board flatness) that do not transfer across views. On the 4-camera sample the
k1 model also helps (initial 5.8 -> 5.2, after SBA 3.6 -> 2.4 px). The synthetic stress
test selects `full` because its ground truth has k2 != 0.

### What "good" looks like on real data

On the 18-camera / 1800-frame HEVC session (`/root/vast/eric/calibration_test`, transcoded
to H.264 for headless tests) the anipose `calibration.toml` shipped with it scores a
**10.8 px median** cross-view reprojection error on our detections. Things established
experimentally there (see `tests/e2e/real-session.mjs` and the scratch probes in git
history of this file): integer frame shifts of any camera only make it worse (cameras
are frame-synchronized); the board never holds still (median 56 px/frame, slowest
quartile 40 px/frame) so a motion filter cannot help on this recording; SBA with free
3D points lowers its own cost without lowering the DLT-triangulated error, and freeing
all 9 intrinsic parameters makes it worse — hence model selection in `runSba`. Judge
changes by "median over all observations vs the reference on the same detections", not
by absolute pixel numbers; the per-frame error swings 4–47 px on this data.

Current result on that session (600 sampled frames, defaults: k1-only intrinsics, 2 SBA
rounds, model selection): initial extrinsics 10.27 px median, after SBA **7.27 px median /
22.3 px p95** vs the anipose reference's 10.80 / 48.9 on the same detections; camera-pair
distances within 6 mm (median) of anipose's. Wall clock in headless Chromium (CPU only,
12 detect workers): detection 600x18 in 200 s, intrinsics 123 s, extrinsics 3 s, SBA 184 s.

### Board convention

`calib/board.js` is the single source of truth: corner id → `[(col+1)·s, (row+1)·s, 0]`
with `col = id % (boardX-1)` (matches OpenCV `CharucoBoard::getChessboardCorners`).
The vibe's export used `col·s` — inconsistent; fixed here.

## Dependencies (all vendored under `lib/`, each with `PROVENANCE.txt`)

- **OpenCV.js 4.13.0** (`lib/opencv/opencv.js`, ~11 MB, single file with embedded
  WASM). The vibe loaded `docs.opencv.org/4.x/opencv.js` which is a redirect to the
  latest 4.x — unpinned. We need the 4.7+ object API (`aruco_ArucoDetector`,
  `aruco_CharucoDetector`, `aruco_CharucoBoard`, `aruco_DetectorParameters`,
  `aruco_RefineParameters`, `aruco_CharucoParameters`). Loaded only in workers via
  `importScripts`. The UMD returns a Module or a Promise depending on the build —
  both workers handle both (see also `loading/opencv-ready.js`).
- **@talmolab/sba-solver-wasm 0.2.0** (`lib/sba-solver-wasm/`). ESM; `wrapper.js`
  resolves the glue via `import.meta.url`, so keep the four runtime files together.
  Camera rotation is a quaternion `[w,x,y,z]` world→camera. All data crosses into
  WASM as JSON strings, so cap point counts (`Max points` in the SBA panel). Now only
  the optional "all 9 intrinsics" SBA engine: its `triangulate_points` is inaccurate
  (≈3 mm / 1.5 px error on exact synthetic observations — `tests/test-triangulation.mjs`
  guards the JS replacement) and its intrinsics cannot be partially fixed.
- **mp4box 0.5.2** (`lib/mp4box/mp4box.all.min.js`), classic script → `MP4Box`, `DataStream`.
  Samples arrive in decode order; `video.js` builds presentation order by sorting
  on `cts` and decodes whole GOPs when B-frames are present.

## Local development

```bash
python3 server.py 8080          # static + HTTP Range (python -m http.server also works)
node tests/run-mjs-tests.mjs    # unit tests (pure modules; Node ≥ 18)
# browser: http://localhost:8080/tests/test-runner.html  (same test files, tests/harness.mjs reports to the page)
# e2e (Playwright, headless Chromium): tests/e2e/README.md
node tests/e2e/smoke-pipeline.mjs
SESSION=/tmp/synthetic_session node tests/e2e/stress-synthetic.mjs   # after scripts/make_synthetic_session.py
```

`package.json` (`"type": "module"`) exists only so Node runs the `.js` ESM sources.
Test files must stay environment-agnostic (no `node:` imports outside
`tests/harness.mjs`'s `isNode` branches) so the browser runner can load them.

Reference numbers (headless Chromium, no GPU, shared CPU; `tests/e2e/stress-synthetic.mjs`
on a 4-camera x 1200-frame synthetic session with ground truth): batch detection of
every frame 149 s = 32 detections/s (~105 ms per 1280x1024 frame in a worker, 4 workers),
main-thread rAF heartbeat never gapping > 185 ms, 1230 decoded frames per 1200 wanted
(2.5 % overhead), 1200 thumbnails; intrinsics for 4 cameras in 18.6 s (50 coverage-selected
frames each, cubic cost in frames -> keep the cap modest) with fx within 0.4 %, cx within
7 px, k1 within 0.003 of ground truth; extrinsics + cross-view reprojection of 84k points in
2.4 s with camera centres within 1-5 mm and rotations < 0.4 deg; SBA over 42k points /
157k observations 115 s (roughly linear in points -> default cap 20k). DOM after the run:
19 table rows, 80 gallery cards, 29 log entries, 57 MB JS heap. Sample session (4 x 21
frames): detect 2 s, intrinsics 3 s, whole pipeline ~16 s. Original calibration-studio on
the sample: initial cross-view median 10.5 px -> 6.5 px after SBA; calibrat3: 5.8 -> 3.7 px
with intrinsics/translations matching to ~1 mm.

## Deploy

`.github/workflows/pages.yml` deploys `main` to the `gh-pages` branch
(JamesIves action, `folder: .`, `clean-exclude: pr/`); `pr-preview.yml` deploys each
PR under `pr/<n>/` and posts a sticky comment. Repo settings required: Pages source =
`gh-pages` / root; Actions workflow permissions = read and write. `.nojekyll` is present.

## Gotchas

- **Never `await cv`.** OpenCV.js's Emscripten build sets `cv.then(cb)` but that `then`
  returns the module itself (a thenable), so `await cv` / `resolve(cv)` recurse forever
  with no error — the workers silently never become ready. Use the `whenOpenCVReady`
  pattern (wrap the module in a plain object) as in both workers / `loading/opencv-ready.js`.
- `pool.detect()` transfers the image: never pass a cached `ImageBitmap` from the
  decoder LRU — `createImageBitmap(bitmap)` a copy first (see `detectCurrentFrame`).
- Interactive seeks during a batch run share the decoder queue per view; the GOP
  iterator holds the queue while a GOP is in flight, so a seek waits at most one GOP.
- `calibrateCameraExtended` cost is superlinear in frames; `Max frames / camera`
  (default 80) picks frames greedily for grid coverage (`calib/frame-selection.js`).
  All valid frames are still evaluated afterwards so exclusion works on the full set.
- After SBA changes intrinsics, the per-frame *intrinsic* errors shown are still the
  pre-SBA solvePnP evaluation (only the cross-view reprojection is recomputed).
- Saved sessions don't include thumbnails; galleries then show frame numbers only.
