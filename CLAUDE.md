# calibrat3 — notes for Claude / contributors

Browser-based multi-camera ChArUco calibration. **No build step**: vanilla JS ES
modules served as static files, deployed to GitHub Pages from `main`. Port of the
`calibration-studio` vibe (talmolab/vibes) restructured like luc3d.

## Architecture

`index.html` loads `app.js` (`<script type="module">`), a 2-line entry that calls
`initApp()` from `calib/initialization.js`. Modules are grouped by directory:

- `calib/` — pure logic, no DOM. `board`, `geometry`, `detection-store`,
  `covisibility`, `frame-selection` need nothing; `intrinsics`, `extrinsics` take
  the initialized OpenCV module `cv` as first argument; `triangulation`, `sba`
  take the sba-solver-wasm wrapper. Runs identically in the worker and in Node tests.
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
   frame it already has — never re-decoded.
2. **Calibration** (`calib-worker.js`, one classic worker that `importScripts`
   opencv.js and `import()`s the ESM calib modules + the sba wrapper) runs
   `calibrateCameraExtended`, per-frame solvePnP, relative poses, WASM
   triangulation and bundle adjustment. Progress messages are throttled to ~25 Hz.
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
  WASM as JSON strings, so cap point counts (`Max points` in the SBA panel).
- **mp4box 0.5.2** (`lib/mp4box/mp4box.all.min.js`), classic script → `MP4Box`, `DataStream`.
  Samples arrive in decode order; `video.js` builds presentation order by sorting
  on `cts` and decodes whole GOPs when B-frames are present.

## Local development

```bash
python3 server.py 8080          # static + HTTP Range (python -m http.server also works)
node tests/run-mjs-tests.mjs    # unit tests (pure modules; Node ≥ 18)
```

`package.json` (`"type": "module"`) exists only so Node runs the `.js` ESM sources.

## Deploy

`.github/workflows/pages.yml` deploys `main` to the `gh-pages` branch
(JamesIves action, `folder: .`, `clean-exclude: pr/`); `pr-preview.yml` deploys each
PR under `pr/<n>/` and posts a sticky comment. Repo settings required: Pages source =
`gh-pages` / root; Actions workflow permissions = read and write. `.nojekyll` is present.

## Gotchas

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
