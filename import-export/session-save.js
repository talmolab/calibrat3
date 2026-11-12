/**
 * import-export/session-save.js — save / restore a calibrat3 session as JSON
 * so a long detection run never has to be repeated.
 *
 * Contents: board, view list (names + sizes, for validation), sampled frames,
 * detections (typed arrays as base64), exclusions, intrinsics (incl. per-frame
 * arrays), extrinsics, SBA metadata. Thumbnails and the cross-view
 * reprojection are NOT saved (cheap to recompute).
 *
 * Videos are not embedded: on load the user re-opens the same folder and the
 * session is applied if the view names match.
 */

import { DetectionStore, b64FromTyped, typedFromB64 } from '../calib/detection-store.js';
import { shortenNames } from '../loading/folder-loader.js';

export const SESSION_FORMAT_VERSION = 1;

export function serializeSession(state) {
    const typed = (a) => a ? { t: a.constructor.name, b64: b64FromTyped(a) } : null;
    return {
        app: 'calibrat3', version: SESSION_FORMAT_VERSION, created: new Date().toISOString(),
        session: {
            name: state.sessionName, layout: state.sessionLayout, totalFrames: state.totalFrames, fps: state.fps,
            views: state.views.map(v => ({ name: v.name, path: v.path || null, width: v.info.width, height: v.info.height, totalFrames: v.info.totalFrames })),
        },
        board: state.board,
        sampledFrames: state.sampledFrames,
        detections: state.detections ? state.detections.toJSON() : null,
        exclusions: { intrinsics: Array.from(state.exclusions.intrinsics), extrinsics: Array.from(state.exclusions.extrinsics) },
        referenceView: state.referenceView,
        intrinsics: state.intrinsics.map(r => r ? {
            ...r,
            perFrame: r.perFrame ? { frames: typed(r.perFrame.frames), errors: typed(r.perFrame.errors), rvecs: typed(r.perFrame.rvecs), tvecs: typed(r.perFrame.tvecs), used: typed(r.perFrame.used), counts: typed(r.perFrame.counts) } : null,
        } : null),
        extrinsics: state.extrinsics.map(e => e || null),
        extrinsicsMeta: state.extrinsicsMeta ? { pairCounts: state.extrinsicsMeta.pairCounts, chain: state.extrinsicsMeta.chain, refIdx: state.extrinsicsMeta.refIdx, relativePoses: Array.from(state.extrinsicsMeta.relativePoses.entries()).map(([k, v]) => [k, { ...v, residuals: undefined }]) } : null,
        sba: state.sbaResult ? { config: state.sbaResult.config, meta: state.sbaResult.meta, result: { ...state.sbaResult.result, points: undefined, cameras: undefined } } : null,
    };
}

/**
 * Validate a saved session against the currently open views.
 * @returns {{ok:boolean, problems:string[]}}
 */
export function validateSession(saved, state) {
    const problems = [];
    if (saved.app !== 'calibrat3') problems.push('Not a calibrat3 session file');
    if (saved.version !== SESSION_FORMAT_VERSION) problems.push(`Unsupported session version ${saved.version}`);
    const savedNames = (saved.session?.views || []).map(v => v.name);
    const names = state.views.map(v => v.name);
    // Accept sessions saved before/after view-name shortening (file stems vs short names).
    const same = savedNames.join('|') === names.join('|') || shortenNames(savedNames).join('|') === shortenNames(names).join('|');
    if (!same) problems.push(`View names differ: saved [${savedNames.join(', ')}] vs open [${names.join(', ')}]`);
    saved.session?.views?.forEach((sv, i) => {
        const v = state.views[i];
        if (v && (v.info.width !== sv.width || v.info.height !== sv.height)) problems.push(`${sv.name}: size ${sv.width}x${sv.height} saved vs ${v.info.width}x${v.info.height} open`);
    });
    return { ok: problems.length === 0, problems };
}

/** Apply a saved session to state (views must already be open and validated). */
export function restoreSession(saved, state) {
    const TYPES = { Int32Array, Float32Array, Float64Array, Uint8Array, Uint16Array };
    const untyped = (t) => t ? typedFromB64(t.b64, TYPES[t.t] || Float64Array) : null;
    state.board = { ...saved.board };
    state.sampledFrames = saved.sampledFrames || [];
    state.detections = saved.detections ? DetectionStore.fromJSON(saved.detections) : null;
    state.exclusions.intrinsics = new Set(saved.exclusions?.intrinsics || []);
    state.exclusions.extrinsics = new Set(saved.exclusions?.extrinsics || []);
    state.referenceView = saved.referenceView ?? 0;
    state.intrinsics = (saved.intrinsics || []).map(r => r ? {
        ...r,
        perFrame: r.perFrame ? { frames: untyped(r.perFrame.frames), errors: untyped(r.perFrame.errors), rvecs: untyped(r.perFrame.rvecs), tvecs: untyped(r.perFrame.tvecs), used: untyped(r.perFrame.used), counts: untyped(r.perFrame.counts) } : null,
    } : null);
    state.extrinsics = saved.extrinsics || [];
    state.extrinsicsMeta = saved.extrinsicsMeta ? { ...saved.extrinsicsMeta, relativePoses: new Map(saved.extrinsicsMeta.relativePoses) } : null;
    state.sbaResult = saved.sba ? { config: saved.sba.config, meta: saved.sba.meta, result: saved.sba.result } : null;
    state.reproj = null;
    state.reprojByFrame = new Map();
    state.thumbnails = new Map();
}

/**
 * Save text to a file. With the File System Access API (Chrome, Edge) and a folder
 * handle in `startIn`, a save dialog opens IN that folder (the session folder), so
 * calibration.toml lands next to the videos instead of in Downloads; the user can
 * still rename it or pick another place. Without either it is a plain download, which
 * the browser puts in its downloads folder.
 *
 * `content` may be a function returning the text: it then runs only once the user has
 * picked the file, so a slow serialization cannot use up the click's user activation
 * (the dialog needs one) before the dialog opens.
 *
 * @returns {Promise<null | {how:'picker', handle:FileSystemFileHandle, text:string}
 *                        | {how:'download', text:string, reason:'no-folder'|'unsupported'|'error', error?:Error}>}
 *          null if the user cancelled the dialog. reason: no folder handle; the browser
 *          has no save dialog API (Firefox, Safari, Brave unless its flag is on); or the
 *          dialog failed to open (the file is downloaded instead).
 */
export async function saveText(filename, content, { type = 'application/octet-stream', startIn = null } = {}) {
    const getText = () => (typeof content === 'function' ? content() : content);
    const supported = typeof window.showSaveFilePicker === 'function';
    if (!startIn || !supported) {
        const text = getText();
        downloadText(filename, text, type);
        return { how: 'download', text, reason: supported ? 'no-folder' : 'unsupported' };
    }
    const ext = /\.[^.]+$/.exec(filename)?.[0];
    let handle;
    try {
        handle = await window.showSaveFilePicker({
            suggestedName: filename, startIn,
            ...(ext ? { types: [{ description: `${ext.slice(1).toUpperCase()} file`, accept: { [type]: [ext] } }] } : {}),
        });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        const text = getText();
        downloadText(filename, text, type);
        return { how: 'download', text, reason: 'error', error: e };
    }
    const text = getText();
    const writable = await handle.createWritable();
    try { await writable.write(text); await writable.close(); }
    catch (e) { await writable.abort().catch(() => {}); throw e; }
    return { how: 'picker', handle, text };
}

/** Trigger a browser download of text/JSON. */
export function downloadText(filename, text, type = 'application/octet-stream') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
