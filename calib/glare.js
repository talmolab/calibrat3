/**
 * calib/glare.js — detector settings for overexposed boards / glare.
 *
 * Pure JS, no DOM, no OpenCV: the settings are plain numbers that
 * loading/detect-worker.js applies to OpenCV's ArUco / ChArUco detectors.
 *
 * When a board is overexposed, the white bits inside each ArUco marker bleed
 * ("bloom") into their black neighbours, so OpenCV reads the wrong bit pattern
 * and drops the marker; ChArUco corners need detected markers around them, so
 * whole regions of the board lose their corners. The settings, in the order
 * they help (measured on a 3-camera session whose overexposed camera went
 * from 32.9k to 71.6k corners at level 1, every frame >= 6 corners, no frame
 * losing a corner, corner positions unchanged where both found them):
 *
 *  - cellMargin (DetectorParameters.perspectiveRemoveIgnoredMarginPerCell,
 *    OpenCV default 0.13): fraction of each marker cell ignored at its border
 *    when reading the bit. With OpenCV's 4 px per cell this is truncated to
 *    whole pixels, so 0.13 = read the whole cell and 0.25-0.49 = read only its
 *    centre 2x2 px. Free (no extra time).
 *  - boardRefine (ArucoDetector.refineDetectedMarkers with the board): uses the
 *    markers already found plus the board layout to re-read candidates that
 *    were rejected. ~+1 ms.
 *  - gamma: darkens highlights (pixel^gamma) on the copy of the image used to
 *    FIND markers; corners are still located on the original image. ~+2 ms.
 *  - minMarkers (CharucoParameters.minMarkers, OpenCV default 2): a corner is
 *    kept when at least this many of its neighbouring markers were found. 1
 *    recovers corners at the board edge and next to washed-out markers, at the
 *    cost of slightly more mislocated corners (~0.1 % of the extra corners).
 */

/** Settings that reproduce the detector as it was before these options existed. */
export const GLARE_OFF = Object.freeze({ cellMargin: 0.13, boardRefine: false, gamma: 1, minMarkers: 2 });

/** The ladder offered in the UI. Level 0 is the default and changes nothing. */
export const GLARE_LEVELS = Object.freeze([
    Object.freeze({ id: 'off', label: 'Off — standard detection (default)', settings: GLARE_OFF }),
    Object.freeze({ id: 'light', label: 'Level 1 — read marker cell centres', settings: Object.freeze({ ...GLARE_OFF, cellMargin: 0.3 }) }),
    Object.freeze({ id: 'medium', label: 'Level 2 — + board-guided marker recovery', settings: Object.freeze({ ...GLARE_OFF, cellMargin: 0.3, boardRefine: true }) }),
    Object.freeze({ id: 'strong', label: 'Level 3 — + darken highlights (gamma 2)', settings: Object.freeze({ ...GLARE_OFF, cellMargin: 0.3, boardRefine: true, gamma: 2 }) }),
    Object.freeze({ id: 'max', label: 'Level 4 — + corners next to a single marker', settings: Object.freeze({ ...GLARE_OFF, cellMargin: 0.3, boardRefine: true, gamma: 2, minMarkers: 1 }) }),
]);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? d : Number(v);

/** Fill defaults and clamp to ranges OpenCV accepts. */
export function normalizeGlare(o = {}) {
    return {
        cellMargin: clamp(num(o.cellMargin, GLARE_OFF.cellMargin), 0, 0.49),
        boardRefine: !!(o.boardRefine ?? GLARE_OFF.boardRefine),
        gamma: clamp(num(o.gamma, GLARE_OFF.gamma), 0.2, 5),
        minMarkers: clamp(Math.round(num(o.minMarkers, GLARE_OFF.minMarkers)), 1, 2),
    };
}

/** Settings of a level id ('off', 'light', ...); unknown ids -> off. */
export function glareLevel(id) {
    const l = GLARE_LEVELS.find((x) => x.id === id);
    return { ...(l ? l.settings : GLARE_OFF) };
}

/** The level whose settings equal `o`, or 'custom'. */
export function matchGlareLevel(o) {
    const k = glareKey(o);
    const l = GLARE_LEVELS.find((x) => glareKey(x.settings) === k);
    return l ? l.id : 'custom';
}

/** Stable string key (detector caches are keyed on it). */
export function glareKey(o) {
    const g = normalizeGlare(o);
    return `m${g.cellMargin}|r${g.boardRefine ? 1 : 0}|g${g.gamma}|n${g.minMarkers}`;
}

/** True when the settings differ from the plain detector. */
export function glareActive(o) { return glareKey(o) !== glareKey(GLARE_OFF); }

/** Short human description for the log, e.g. "cell margin 0.3, board refine, gamma 2". */
export function describeGlare(o) {
    const g = normalizeGlare(o);
    if (!glareActive(g)) return 'off';
    const parts = [];
    if (g.cellMargin !== GLARE_OFF.cellMargin) parts.push(`cell margin ${g.cellMargin}`);
    if (g.boardRefine) parts.push('board refine');
    if (g.gamma !== 1) parts.push(`gamma ${g.gamma}`);
    if (g.minMarkers !== GLARE_OFF.minMarkers) parts.push(`min markers/corner ${g.minMarkers}`);
    return parts.join(', ');
}
