/**
 * ui/app-state.js — the single mutable application state plus controller
 * singletons. Everything UI-side imports `state` from here.
 *
 * Index space: VIDEO FRAME everywhere. There is no separate "calibration
 * index"; per-frame results are typed arrays paired with a `frames` array,
 * and exclusion sets hold video frame numbers.
 */

import { DEFAULT_BOARD } from '../calib/board.js';

export const state = {
    // --- videos -------------------------------------------------------------
    /** @type {Array<{name:string, decoder:any, canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, info:object, lastBitmap?:ImageBitmap}>} */
    views: [],
    sessionName: '',
    sessionLayout: 'none',
    currentFrame: 0,
    totalFrames: 0,
    fps: 30,
    isPlaying: false,

    // --- board / detection --------------------------------------------------
    board: { ...DEFAULT_BOARD },
    /** @type {import('../calib/detection-store.js').DetectionStore|null} */
    detections: null,
    /** @type {number[]} frames that were sampled in the last batch run */
    sampledFrames: [],
    /** @type {Map<number, Blob>} frame -> JPEG thumbnail (view 0), captured during the batch pass */
    thumbnails: new Map(),
    /** detection results for "Detect Current Frame" (not stored in the store) */
    liveDetection: null,   // {frame, perView: Array<{ids, corners}|null>}
    detectionRunning: false,
    detectionAbort: null,

    // --- calibration results (arrays indexed by view index) -------------------
    /** @type {Array<object|null>} */
    intrinsics: [],
    /** @type {Array<object|null>} */
    extrinsics: [],
    extrinsicsMeta: null,     // {pairCounts, chain, relativePoses, refIdx}
    /** @type {{frames:object[], summary:object}|null} */
    reproj: null,
    reprojByFrame: new Map(),
    sbaResult: null,
    referenceView: 0,

    // --- exclusions (video frame keys) ---------------------------------------
    exclusions: {
        intrinsics: new Set(),
        extrinsics: new Set(),
    },

    // --- overlay toggles ------------------------------------------------------
    overlays: { detections: true, intrinsics: true, extrinsics: true, ids: false },

    // --- misc -----------------------------------------------------------------
    dirty: false,
};

/** Controller singletons, set during initialization. */
export const controllers = {
    video: null,      // VideoController
    pool: null,       // DetectorPool
    calib: null,      // CalibWorker
};

export function viewNames() { return state.views.map(v => v.name); }
export function viewIndex(name) { return state.views.findIndex(v => v.name === name); }

/** Camera colors (consistent across plots, strips, overlays, 3D). Red is reserved for errors. */
export const CAMERA_COLORS = ['#667eea', '#4ade80', '#fbbf24', '#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#34d399'];
export const cameraColor = (i) => CAMERA_COLORS[i % CAMERA_COLORS.length];

/** Reset everything downstream of a fresh video load. */
export function resetCalibrationState() {
    state.detections = null;
    state.sampledFrames = [];
    for (const b of state.thumbnails.values()) if (b && typeof b.close === 'function') b.close();
    state.thumbnails = new Map();
    state.liveDetection = null;
    state.intrinsics = [];
    state.extrinsics = [];
    state.extrinsicsMeta = null;
    state.reproj = null;
    state.reprojByFrame = new Map();
    state.sbaResult = null;
    state.exclusions.intrinsics = new Set();
    state.exclusions.extrinsics = new Set();
}

/** Reset results that depend on detections (after re-running batch detection). */
export function resetDownstreamOfDetection() {
    state.intrinsics = [];
    state.extrinsics = [];
    state.extrinsicsMeta = null;
    state.reproj = null;
    state.reprojByFrame = new Map();
    state.sbaResult = null;
    state.exclusions.intrinsics = new Set();
    state.exclusions.extrinsics = new Set();
}

/** Expose for e2e tests / debugging. */
if (typeof window !== 'undefined') {
    window.__calibrat3 = window.__calibrat3 || {};
    window.__calibrat3.state = state;
    window.__calibrat3.controllers = controllers;
}
