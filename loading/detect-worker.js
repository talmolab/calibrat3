/**
 * loading/detect-worker.js — ChArUco detection in a Web Worker.
 *
 * Classic worker (importScripts) because opencv.js is a UMD/global script.
 * The dictionary, board, parameters and both detectors are built ONCE per
 * board config and reused for every frame.
 *
 * Protocol (all messages carry `type`):
 *   -> {type:'configure', board}
 *   <- {type:'configured', key}
 *   -> {type:'detect', requestId, frame, view, image: VideoFrame|ImageBitmap, width, height,
 *          wantThumb?:boolean, thumbWidth?:number}
 *   <- {type:'result', requestId, frame, view, ids:Int32Array, corners:Float32Array,
 *          numMarkers, ms, timings:{convert,markers,charuco}, thumb: Blob|null}
 *   <- {type:'error', requestId?, error}
 *   <- {type:'ready'}   once OpenCV is initialized
 *   <- {type:'log', level, msg}
 */

/* global importScripts, cv, OffscreenCanvas */

importScripts('../lib/opencv/opencv.js');

let CV = null;
let det = null;          // cached detector bundle
let canvas = null, ctx = null;
let thumbCanvas = null, thumbCtx = null;
const queue = [];
let ready = false;

const DICT_IDS = () => ({
    DICT_4X4_50: CV.DICT_4X4_50, DICT_4X4_100: CV.DICT_4X4_100, DICT_4X4_250: CV.DICT_4X4_250, DICT_4X4_1000: CV.DICT_4X4_1000,
    DICT_5X5_50: CV.DICT_5X5_50, DICT_5X5_100: CV.DICT_5X5_100, DICT_5X5_250: CV.DICT_5X5_250, DICT_5X5_1000: CV.DICT_5X5_1000,
    DICT_6X6_50: CV.DICT_6X6_50, DICT_6X6_100: CV.DICT_6X6_100, DICT_6X6_250: CV.DICT_6X6_250, DICT_6X6_1000: CV.DICT_6X6_1000,
});

function log(msg, level = 'info') { postMessage({ type: 'log', level, msg }); }

/**
 * Resolve the initialized OpenCV module. Emscripten's MODULARIZE build exposes
 * `cv.then(cb)` but that `then` RETURNS THE MODULE (a thenable) — so `await cv`
 * or `resolve(cv)` recurses forever. Never await the module directly; hand it
 * back wrapped in a plain object.
 */
function whenOpenCVReady(cvObj) {
    return new Promise((resolve, reject) => {
        if (!cvObj) { reject(new Error('cv global is undefined')); return; }
        const done = (m) => resolve({ module: m });
        if (typeof cvObj.Mat === 'function') { done(cvObj); return; }
        if (typeof cvObj.then === 'function') {
            cvObj.then((m) => done(m && typeof m.Mat === 'function' ? m : cvObj));
            return;
        }
        const prev = cvObj.onRuntimeInitialized;
        cvObj.onRuntimeInitialized = () => { if (typeof prev === 'function') prev(); done(cvObj); };
    });
}

(async () => {
    try {
        const { module: m } = await whenOpenCVReady(cv);
        CV = m;
        ready = true;
        postMessage({ type: 'ready' });
        while (queue.length) handle(queue.shift());
    } catch (e) {
        postMessage({ type: 'error', error: `OpenCV init failed: ${e.message || e}` });
    }
})();

onmessage = (e) => { if (!ready) queue.push(e.data); else handle(e.data); };

function handle(msg) {
    try {
        switch (msg.type) {
            case 'configure': configure(msg.board, msg.options || {}); break;
            case 'detect': detect(msg); break;
            case 'close': dispose(); close(); break;
            default: postMessage({ type: 'error', error: `unknown message type ${msg.type}` });
        }
    } catch (err) {
        if (msg.image && typeof msg.image.close === 'function') { try { msg.image.close(); } catch (_) { /* */ } }
        postMessage({ type: 'error', requestId: msg.requestId, error: err.message || String(err) });
    }
}

function boardKey(b) { return `${b.boardX}x${b.boardY}|${b.squareLength}|${b.markerLength}|${b.dictName}`; }

function dispose() {
    if (!det) return;
    for (const k of ['charucoDetector', 'arucoDetector', 'charucoParams', 'refineParams', 'detectorParams', 'board', 'dictionary']) {
        try { det[k] && det[k].delete(); } catch (_) { /* */ }
    }
    det = null;
}

let fastMarkers = true;    // search markers on a half-resolution image when the frame is large; corners are refined at full resolution

function configure(board, options) {
    fastMarkers = options.fastMarkers !== false;
    const key = boardKey(board);
    if (det && det.key === key) { postMessage({ type: 'configured', key }); return; }
    dispose();
    const dictId = DICT_IDS()[board.dictName];
    if (dictId === undefined) throw new Error(`Unknown dictionary ${board.dictName}`);
    const dictionary = CV.getPredefinedDictionary(dictId);
    const ids = new CV.Mat();
    const cvBoard = new CV.aruco_CharucoBoard(new CV.Size(board.boardX, board.boardY), board.squareLength, board.markerLength, dictionary, ids);
    ids.delete();
    const detectorParams = new CV.aruco_DetectorParameters();
    // Subpixel corner refinement makes a measurable difference for calibration.
    if ('cornerRefinementMethod' in detectorParams && CV.CORNER_REFINE_SUBPIX !== undefined) {
        try { detectorParams.cornerRefinementMethod = CV.CORNER_REFINE_SUBPIX; } catch (_) { /* read-only in some builds */ }
    }
    const refineParams = new CV.aruco_RefineParameters(10.0, 3.0, true);
    const arucoDetector = new CV.aruco_ArucoDetector(dictionary, detectorParams, refineParams);
    const charucoParams = new CV.aruco_CharucoParameters();
    const charucoDetector = new CV.aruco_CharucoDetector(cvBoard, charucoParams, detectorParams, refineParams);
    det = { key, dictionary, board: cvBoard, detectorParams, refineParams, arucoDetector, charucoParams, charucoDetector };
    postMessage({ type: 'configured', key });
}

function ensureCanvas(w, h) {
    if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
}

function detect(msg) {
    if (!det) throw new Error('detector not configured');
    const t0 = performance.now();
    const { requestId, frame, view, image, width, height } = msg;
    const w = width || image.displayWidth || image.width;
    const h = height || image.displayHeight || image.height;
    ensureCanvas(w, h);
    ctx.drawImage(image, 0, 0, w, h);

    let thumb = null;
    let thumbPromise = null;
    if (msg.wantThumb) {
        const tw = msg.thumbWidth || 160;
        const th = Math.max(1, Math.round(h * tw / w));
        if (!thumbCanvas || thumbCanvas.width !== tw || thumbCanvas.height !== th) {
            thumbCanvas = new OffscreenCanvas(tw, th);
            thumbCtx = thumbCanvas.getContext('2d');
        }
        thumbCtx.drawImage(image, 0, 0, tw, th);
        thumbPromise = thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    }
    if (typeof image.close === 'function') image.close();

    const imageData = ctx.getImageData(0, 0, w, h);
    const src = CV.matFromImageData(imageData);
    const gray = new CV.Mat();
    CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
    src.delete();
    const t1 = performance.now();

    let markerCorners = new CV.MatVector();
    let markerIds = new CV.Mat();
    const rejected = new CV.MatVector();
    let searchScale = 1;
    if (fastMarkers && Math.max(w, h) >= 1400) {
        // Marker search at half resolution (~3-4x cheaper); the ChArUco corner interpolation +
        // subpixel refinement below still runs on the full-resolution gray image.
        searchScale = 0.5;
        const small = new CV.Mat();
        CV.resize(gray, small, new CV.Size(Math.round(w * searchScale), Math.round(h * searchScale)), 0, 0, CV.INTER_AREA);
        det.arucoDetector.detectMarkers(small, markerCorners, markerIds, rejected);
        small.delete();
        if (markerIds.rows >= 4) {
            for (let m = 0; m < markerCorners.size(); m++) {
                const c = markerCorners.get(m);
                const d = c.data32F;
                for (let k = 0; k < d.length; k++) d[k] /= searchScale;
                c.delete();
            }
        } else {
            // Too few markers at half resolution (small/far board): redo at full resolution.
            markerCorners.delete(); markerIds.delete();
            markerCorners = new CV.MatVector(); markerIds = new CV.Mat();
            searchScale = 1;
            det.arucoDetector.detectMarkers(gray, markerCorners, markerIds, rejected);
        }
    } else {
        det.arucoDetector.detectMarkers(gray, markerCorners, markerIds, rejected);
    }
    const numMarkers = markerIds.rows;
    const t2 = performance.now();

    let ids = new Int32Array(0), corners = new Float32Array(0);
    if (numMarkers > 0) {
        const cc = new CV.Mat(), ci = new CV.Mat();
        det.charucoDetector.detectBoard(gray, cc, ci, markerCorners, markerIds);
        const n = ci.rows;
        if (n > 0) {
            ids = new Int32Array(n);
            corners = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) {
                ids[i] = ci.intAt(i, 0);
                corners[i * 2] = cc.floatAt(i, 0);
                corners[i * 2 + 1] = cc.floatAt(i, 1);
            }
        }
        cc.delete(); ci.delete();
    }
    const t3 = performance.now();
    gray.delete(); markerCorners.delete(); markerIds.delete(); rejected.delete();

    const send = (blob) => {
        postMessage({
            type: 'result', requestId, frame, view, ids, corners, numMarkers,
            ms: t3 - t0, timings: { convert: t1 - t0, markers: t2 - t1, charuco: t3 - t2, searchScale },
            thumb: blob || null,
        }, [ids.buffer, corners.buffer]);
    };
    if (thumbPromise) thumbPromise.then(send, () => send(null)); else send(thumb);
}
