# calibrat3 module reference

One entry per ES module: purpose, key exports, what it imports from the project.
Vendored globals (`MP4Box`, `DataStream`, `cv`) and `lib/` are not listed as imports.

---

## root

### app.js
Entry point: `import { initApp } from './calib/initialization.js'; initApp();`

### index.html / styles.css
All markup (stages 1–5, video panel, diagnostic log) and styling. Element ids are
the contract with the `ui/stage-*.js` modules.

---

## calib/ — pure logic

### calib/board.js
Board config + object points (single source of truth).
Exports: `DICT_NAMES`, `DEFAULT_BOARD`, `normalizeBoard`, `boardKey`, `numCorners`,
`numMarkers`, `cornerObjectPoint`, `objectPointsForIds` (flat Float64Array),
`allCornerObjectPoints`, `boardSize`, `dictNameFromToml`, `tomlFromDictName`.
Imports: none.

### calib/geometry.js
Rotations/poses/projection in pure JS. Exports: `rodriguesToMatrix`, `matrixToRodrigues`,
`matrixToQuaternion`, `quaternionToMatrix`, `quaternionToRodrigues`, `rodriguesToQuaternion`,
`quaternionAngle`, `averageQuaternions`, `robustAveragePoses`, `relativePose`,
`composePoses`, `invertPose`, `projectPoint`, `projectPoints`, `rmsPointError`,
`makeCamera`, `toWasmCamera`, `cameraCenter`, `median`, `percentile`, vector helpers.
Imports: none.

### calib/detection-store.js
`DetectionStore` — Map<frame, per-view {ids:Int32Array, corners:Float32Array}>.
`set/get/count/has/touch`, `frames()`, `framesForView`, `viewsWithMin`, `commonIds`
(true intersection), `commonCount`, `cornerForId`, `summary`, `toJSON/fromJSON`
(base64), `toPlain/fromPlain` (structured clone for workers). Also `b64FromTyped`,
`typedFromB64`. Imports: none.

### calib/covisibility.js
`buildCovisibilityGraph(store, minCovisible, excluded)` → `{numViews, edges, pairCounts}`;
`findPoseChain(graph, refIdx)` → `{parent, order, unreachable}` (BFS, most-covisible
neighbour first); `pairFrames`, `edgeKey`, `pathToRoot`. Imports: none.

### calib/frame-selection.js
`stridedFrames(total, target)`; `selectFramesForCoverage(samples, imageSize, {maxFrames, grid})`
greedy grid-coverage subset; `coverageFraction`. Imports: none.

### calib/intrinsics.js  (needs `cv`)
`calibrateIntrinsics(cv, samples, imageSize, board, flags)` wraps
`calibrateCameraExtended`; `reprojectFrames(cv, K, dist, samples, board)` solvePnP +
pure-JS reprojection per frame; `computeIntrinsicsForCamera(cv, allSamples, imageSize,
board, {minCorners, exclusions, maxFrames, flags, onProgress})` = filter → select →
calibrate → evaluate all valid frames. Imports: board, frame-selection, geometry.

### calib/extrinsics.js  (needs `cv`)
`solveBoardPose`, `computeRelativePoses(cv, store, graph, chain, intrinsics, board, opts)`
(pose cache per (frame,view), robust quaternion average, per-pair residuals),
`chainAbsoluteExtrinsics(relPoses, chain, refIdx, n)`. Imports: board, covisibility, geometry.

### calib/triangulation.js  (needs sba wrapper)
`computeCrossViewReprojection(sba, store, intrinsics, extrinsics, opts)` — per frame,
ids seen by ≥2 cameras, batched `triangulatePoints`, per-camera reprojection; compact
typed-array records + summary. `indexReprojectionByFrame`. Imports: geometry.

### calib/sba.js
`prepareSbaInput(reproj, intrinsics, extrinsics, {excludedFrames, maxPoints})`,
`sbaReferenceIndex`, `applySbaResults(result, input, intrinsics, extrinsics)` → new
arrays, `DEFAULT_SBA_CONFIG`. Imports: geometry.

### calib/initialization.js
`initApp()` — wires log panel, stages, video panel, loaders (sample / folder / saved
session), global hotkeys (`X`, `{ }`), starts `DetectorPool` + `CalibWorker`.
Imports: ui/app-state, ui/log-panel, ui/stages, ui/video-panel, ui/stage-*, ui/events,
loading/detect-pool, loading/calib-client, loading/folder-loader, import-export/session-save.

---

## ui/

### ui/app-state.js
`state` (views, board, detections, sampledFrames, thumbnails, intrinsics[],
extrinsics[], extrinsicsMeta, reproj, reprojByFrame, sbaResult, referenceView,
exclusions{intrinsics,extrinsics}, overlays, activeExclusion), `controllers`
{video, pool, calib}, `viewNames`, `cameraColor`, `resetCalibrationState`,
`resetDownstreamOfDetection`. Exposes `window.__calibrat3`. Imports: calib/board.

### ui/events.js
`on(type, fn)`, `emit(type, payload)`. Event names documented in the file header.

### ui/log-panel.js
Ring-buffer log with rAF-batched DOM flush. `initLogPanel`, `log(msg, level)`,
`debug`, `onLog`, `dumpLog`, `clearLog`, `setVerbose`, `fmtMs`.

### ui/stages.js
`toggleStage/expandStage/collapseStage`, `setStageStatus`, `setupStageHeaders`,
`Progress` (rAF-coalesced bar: show/set/hide/fail), `showError/hideError`, `$`, `el`,
`numInput/intInput`, `setEnabled`, `errorColor`, `nextTick`.

### ui/video-panel.js
`setupVideoPanel()` (VideoController, transport, seekbar, overlay toggles, resize
handle), `loadSession(sessionDesc)` (opens decoders in parallel, builds canvases,
emits `session-loaded`), `updateFrameInfo`, `registerKeyHandler`.
Imports: app-state, loading/video, log-panel, stages, overlays, events.

### ui/overlays.js
`drawAllOverlays(frame)` — detections (green), intrinsic reprojection (red X, via
geometry.projectPoints from stored rvec/tvec), triangulated reprojection (blue +),
legend + footer with per-frame errors and exclusion flags. `drawCorners`.
Imports: app-state, calib/board, calib/geometry.

### ui/frame-strip.js
`FrameStrip(canvas, {height, onClick, tooltip, tooltipEl})` — `setData({frames,
colorFn, excluded, marked})`, `setExcluded`, `setCurrent` (O(1) blit of a cached
base). Colormaps `viridisLike`, `errorColormap`.

### ui/virtual-table.js
`VirtualTable(container, {columns, rowHeight, height, onRowClick, rowKey, rowClass})`
— `setRows`, `setSelected(key, {scroll})`, `scrollToRow`. Only visible rows in the DOM.

### ui/plots.js
`SwarmPlot(canvas, tooltipEl, {yLabel, log, height, onClick, formatTooltip})` —
`setData(groups, {thresholds, note})`; grid-bucket hover index; medians.
`drawLineChart(canvas, values, opts)` for SBA cost history.

### ui/gallery.js
`FrameGallery(container, {getThumb, onSeek, onToggleExclude, limit})` — `setItems`,
`updateExclusions`, `setCurrent`; IntersectionObserver-lazy object URLs.

### ui/stage-detect.js
Board form (`getBoardFromForm`, `setBoardForm`), sampling info, `detectCurrentFrame`,
`runBatchDetection` (sequential decode → pool, in-flight cap, cancel, throttled
progress, summary log), `renderResults` (strip + virtual table + filters), `stepSampled`.
Imports: app-state, calib/detection-store, calib/board, calib/frame-selection, log-panel,
stages, frame-strip, virtual-table, events, video-panel.

### ui/stage-intrinsics.js
`setupIntrinsicsStage`, `computeIntrinsics` (per-camera worker requests with progress),
`renderResults` (table, strip of max error, swarm, gallery), `toggleIntrinsicsExclusion`,
`stepWorst`. Imports: app-state, log-panel, stages, frame-strip, plots, gallery, events.

### ui/stage-extrinsics.js
`setupExtrinsicsStage`, `computeExtrinsics` (worker: graph → poses → chain, then
reprojection), covisibility matrix + pose table, strip/plot/gallery of cross-view
errors, `runSba` / `revertSba`, `toggleExtrinsicsExclusion`, `stepWorst`.
Imports: app-state, log-panel, stages, frame-strip, plots, gallery, calib/triangulation,
calib/sba, calib/geometry, events.

### ui/stage-export.js
`setupExportStage`, `buildToml`, `updateTomlPreview`; downloads TOML / JSON /
board.toml / session. Imports: app-state, import-export/*, log-panel, stages, events.

---

## loading/

### loading/video.js
`OnDemandVideoDecoder` — `init(url|File)`, `getFrame(i)` (LRU ImageBitmap, decode from
keyframe, only [i, i+lookahead] bitmapped), `iterateFrames(frames, {maxPending, signal})`
(single sequential pass, GOP-grouped, back-pressured, yields `{frame, videoFrame}`),
`readSampleRange`, `close`, `stats`. `VideoController` — coalesced `seekToFrame`,
`redraw`, playback, seekbar, keyboard, zoom/pan. Imports: none.

### loading/detect-worker.js  (classic worker)
`importScripts` opencv.js; caches dictionary/board/detectors per board key; `detect`
draws the transferred VideoFrame/ImageBitmap to an OffscreenCanvas, runs
`detectMarkers` + `detectBoard`, optional JPEG thumbnail; replies with transferred
typed arrays.

### loading/detect-pool.js
`DetectorPool({size, log})` — `init`, `configure(board)`, `detect({frame, view, image,
width, height, wantThumb})` → Promise, least-loaded dispatch, `stats`, `terminate`.

### loading/calib-worker.js  (classic worker)
`importScripts` opencv.js + dynamic `import()` of calib modules and the sba wrapper.
Requests: `intrinsics`, `extrinsics`, `reprojection`, `sba`, `ping`; replies `progress`
/ `result` / `error` / `log`.

### loading/calib-client.js
`CalibWorker({log})` — `init`, `request(type, payload, {onProgress})`, `terminate`.

### loading/folder-loader.js
`buildSession(entries)` (flat / nested layouts, board.toml discovery),
`scanDirectoryHandle`, `scanFileList`, `pickSessionFolder`, `loadSampleSession`,
`VIDEO_EXT`. Imports: import-export/toml.

### loading/opencv-ready.js
`waitForOpenCV(cvGlobal)` — resolves the initialized module for either UMD flavour.

---

## import-export/

### import-export/toml.js
`generateCalibrationToml(cameras, meta)`, `parseCalibrationToml`, `generateBoardToml`,
`parseBoardToml`, `parseSimpleToml`, `parseTomlTables`. Imports: calib/board.

### import-export/sba-json.js
`generateCalibrationJson(state)` — cameras, board, observations, triangulated points,
SBA + reprojection metadata (flat arrays). Imports: calib/board.

### import-export/session-save.js
`serializeSession(state)`, `validateSession(saved, state)`, `restoreSession(saved, state)`,
`downloadText`, `SESSION_FORMAT_VERSION`. Imports: calib/detection-store.

---

## tests/
`run-mjs-tests.mjs` runs `test-*.mjs` (board, geometry, detection-store, covisibility,
frame-selection, toml) with `harness.mjs`.
