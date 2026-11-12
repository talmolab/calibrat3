/**
 * calib/detection-store.js — compact, indexed storage for ChArUco detections.
 *
 * Detections are keyed by (video frame, view index) and stored as typed arrays:
 *   { ids: Int32Array(n), corners: Float32Array(2n) [x0,y0,x1,y1,...], numMarkers, ms }
 *
 * Downstream code never scans an array to find a frame — everything is a
 * Map lookup. Frames are video frame indices everywhere (no separate
 * "calibration index" space).
 */

export class DetectionStore {
    /** @param {string[]} viewNames */
    constructor(viewNames) {
        this.viewNames = viewNames.slice();
        /** @type {Map<number, Array<object|null>>} frame -> per-view detection (or null) */
        this._frames = new Map();
        this._sortedFrames = null;
    }

    get numViews() { return this.viewNames.length; }
    get size() { return this._frames.size; }

    clear() {
        this._frames.clear();
        this._sortedFrames = null;
    }

    /**
     * Store a detection. `det` may be null for "processed, nothing found".
     * corners/ids are copied by reference (transfer them here once).
     */
    set(frame, viewIdx, det) {
        let row = this._frames.get(frame);
        if (!row) {
            row = new Array(this.numViews).fill(null);
            this._frames.set(frame, row);
            this._sortedFrames = null;
        }
        if (det && det.ids && det.ids.length > 0) {
            row[viewIdx] = {
                ids: det.ids instanceof Int32Array ? det.ids : Int32Array.from(det.ids),
                corners: det.corners instanceof Float32Array ? det.corners : Float32Array.from(det.corners),
                numMarkers: det.numMarkers ?? 0,
                ms: det.ms ?? 0,
            };
        } else {
            row[viewIdx] = { ids: EMPTY_I32, corners: EMPTY_F32, numMarkers: det?.numMarkers ?? 0, ms: det?.ms ?? 0 };
        }
    }

    /** Mark a frame as processed (all views null) without a detection. */
    touch(frame) {
        if (!this._frames.has(frame)) {
            this._frames.set(frame, new Array(this.numViews).fill(null));
            this._sortedFrames = null;
        }
    }

    has(frame) { return this._frames.has(frame); }

    /** @returns {object|null} detection record or null */
    get(frame, viewIdx) {
        const row = this._frames.get(frame);
        return row ? row[viewIdx] : null;
    }

    /** Corner count for (frame, view); 0 if none. */
    count(frame, viewIdx) {
        const d = this.get(frame, viewIdx);
        return d ? d.ids.length : 0;
    }

    /** Sorted list of frames that have been processed. */
    frames() {
        if (!this._sortedFrames) {
            this._sortedFrames = Array.from(this._frames.keys()).sort((a, b) => a - b);
        }
        return this._sortedFrames;
    }

    /** Frames where view `viewIdx` has at least `minCorners` corners. */
    framesForView(viewIdx, minCorners = 1) {
        return this.frames().filter(f => this.count(f, viewIdx) >= minCorners);
    }

    /** View indices with >= minCorners corners at `frame`. */
    viewsWithMin(frame, minCorners) {
        const out = [];
        const row = this._frames.get(frame);
        if (!row) return out;
        for (let v = 0; v < row.length; v++) if (row[v] && row[v].ids.length >= minCorners) out.push(v);
        return out;
    }

    /**
     * Corner ids common to all listed views at `frame` (sorted ascending).
     * @returns {Int32Array}
     */
    commonIds(frame, viewIdxs) {
        if (viewIdxs.length === 0) return EMPTY_I32;
        const row = this._frames.get(frame);
        if (!row) return EMPTY_I32;
        let set = null;
        for (const v of viewIdxs) {
            const d = row[v];
            if (!d || d.ids.length === 0) return EMPTY_I32;
            if (set === null) { set = new Set(d.ids); continue; }
            const next = new Set();
            for (const id of d.ids) if (set.has(id)) next.add(id);
            set = next;
            if (set.size === 0) return EMPTY_I32;
        }
        return Int32Array.from(set).sort();
    }

    /** Number of ids common to ALL views that have any detection at `frame`. */
    commonCount(frame) {
        const views = this.viewsWithMin(frame, 1);
        if (views.length < 2) return 0;
        return this.commonIds(frame, views).length;
    }

    /**
     * Look up the 2D corner for `id` in (frame, view). Returns [x, y] or null.
     * Builds a per-record id->index map lazily.
     */
    cornerForId(frame, viewIdx, id) {
        const d = this.get(frame, viewIdx);
        if (!d || d.ids.length === 0) return null;
        const idx = indexOfId(d, id);
        return idx < 0 ? null : [d.corners[idx * 2], d.corners[idx * 2 + 1]];
    }

    /** Summary counts used by the UI. */
    summary(minCorners = 6) {
        const frames = this.frames();
        let good = 0, anyDet = 0;
        const perView = new Array(this.numViews).fill(0);
        for (const f of frames) {
            const row = this._frames.get(f);
            let any = false, allGood = true;
            for (let v = 0; v < row.length; v++) {
                const n = row[v] ? row[v].ids.length : 0;
                if (n > 0) { any = true; perView[v]++; }
                if (n < minCorners) allGood = false;
            }
            if (any) anyDet++;
            if (allGood && row.length > 0) good++;
        }
        return { frames: frames.length, framesWithAnyDetection: anyDet, framesAllViewsGood: good, perView };
    }

    /**
     * Structured-clone-friendly form for postMessage (Map + typed arrays are
     * cloned natively; no base64). Only the fields the worker needs.
     */
    toPlain() {
        return { viewNames: this.viewNames, frames: this._frames };
    }

    static fromPlain(obj) {
        const store = new DetectionStore(obj.viewNames);
        store._frames = obj.frames instanceof Map ? obj.frames : new Map(obj.frames);
        store._sortedFrames = null;
        return store;
    }

    /** Serialize to a JSON-friendly object (typed arrays -> base64). */
    toJSON() {
        const frames = [];
        for (const f of this.frames()) {
            const row = this._frames.get(f);
            frames.push({
                frame: f,
                views: row.map(d => d ? {
                    ids: b64FromTyped(d.ids),
                    corners: b64FromTyped(d.corners),
                    numMarkers: d.numMarkers,
                    ms: d.ms,
                } : null),
            });
        }
        return { version: 1, viewNames: this.viewNames, frames };
    }

    static fromJSON(obj) {
        const store = new DetectionStore(obj.viewNames);
        for (const fr of obj.frames) {
            store.touch(fr.frame);
            fr.views.forEach((d, v) => {
                if (!d) return;
                store.set(fr.frame, v, {
                    ids: typedFromB64(d.ids, Int32Array),
                    corners: typedFromB64(d.corners, Float32Array),
                    numMarkers: d.numMarkers, ms: d.ms,
                });
            });
        }
        return store;
    }
}

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F32 = new Float32Array(0);

function indexOfId(d, id) {
    if (!d._idx) {
        const m = new Map();
        for (let i = 0; i < d.ids.length; i++) m.set(d.ids[i], i);
        Object.defineProperty(d, '_idx', { value: m, enumerable: false });
    }
    const i = d._idx.get(id);
    return i === undefined ? -1 : i;
}

// --- base64 helpers (work in Node and browsers) --------------------------

export function b64FromTyped(arr) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function typedFromB64(b64, Ctor) {
    let bytes;
    if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    else {
        const s = atob(b64);
        bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    }
    // copy to an aligned buffer
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Ctor(buf);
}
