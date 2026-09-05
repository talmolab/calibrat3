/**
 * calib/board.js — ChArUco board configuration and object points.
 *
 * Single source of truth for the board geometry. Pure JS, no DOM, no OpenCV.
 *
 * Corner id convention (matches OpenCV's CharucoBoard::getChessboardCorners):
 *   numCornersX = boardX - 1, numCornersY = boardY - 1
 *   col = id % numCornersX, row = floor(id / numCornersX)
 *   objectPoint = [(col + 1) * squareLength, (row + 1) * squareLength, 0]
 */

export const DICT_NAMES = [
    'DICT_4X4_50', 'DICT_4X4_100', 'DICT_4X4_250', 'DICT_4X4_1000',
    'DICT_5X5_50', 'DICT_5X5_100', 'DICT_5X5_250', 'DICT_5X5_1000',
    'DICT_6X6_50', 'DICT_6X6_100', 'DICT_6X6_250', 'DICT_6X6_1000',
];

/** Defaults match sample_session/board.toml (sleap-anipose minimal_session). */
export const DEFAULT_BOARD = Object.freeze({
    boardX: 8,
    boardY: 11,
    squareLength: 24.0,
    markerLength: 18.75,
    dictName: 'DICT_4X4_1000',
});

/** Build a dictionary name from board.toml's marker_bits / dict_size. */
export function dictNameFromToml(markerBits, dictSize) {
    const name = `DICT_${markerBits}X${markerBits}_${dictSize}`;
    return DICT_NAMES.includes(name) ? name : null;
}

/** Inverse of dictNameFromToml: 'DICT_4X4_1000' -> {markerBits: 4, dictSize: 1000}. */
export function tomlFromDictName(dictName) {
    const m = /^DICT_(\d)X\d_(\d+)$/.exec(dictName);
    if (!m) return null;
    return { markerBits: parseInt(m[1], 10), dictSize: parseInt(m[2], 10) };
}

/**
 * Normalize a board config, filling defaults and coercing numbers.
 * Throws on nonsensical values.
 */
export function normalizeBoard(cfg = {}) {
    const b = {
        boardX: Math.round(Number(cfg.boardX ?? DEFAULT_BOARD.boardX)),
        boardY: Math.round(Number(cfg.boardY ?? DEFAULT_BOARD.boardY)),
        squareLength: Number(cfg.squareLength ?? DEFAULT_BOARD.squareLength),
        markerLength: Number(cfg.markerLength ?? DEFAULT_BOARD.markerLength),
        dictName: cfg.dictName ?? DEFAULT_BOARD.dictName,
    };
    if (!(b.boardX >= 3) || !(b.boardY >= 3)) throw new Error(`Board must be at least 3x3 squares (got ${b.boardX}x${b.boardY})`);
    if (!(b.squareLength > 0)) throw new Error('squareLength must be > 0');
    if (!(b.markerLength > 0) || b.markerLength >= b.squareLength) {
        throw new Error(`markerLength must be in (0, squareLength) (got ${b.markerLength} vs ${b.squareLength})`);
    }
    if (!DICT_NAMES.includes(b.dictName)) throw new Error(`Unknown dictionary: ${b.dictName}`);
    return b;
}

/** Stable string key for a board config (used to cache detectors per config). */
export function boardKey(cfg) {
    const b = normalizeBoard(cfg);
    return `${b.boardX}x${b.boardY}|${b.squareLength}|${b.markerLength}|${b.dictName}`;
}

/** Number of interior chessboard corners on the board. */
export function numCorners(cfg) {
    return (cfg.boardX - 1) * (cfg.boardY - 1);
}

/** Number of ArUco markers on the board (white squares carry markers). */
export function numMarkers(cfg) {
    return Math.floor((cfg.boardX * cfg.boardY) / 2);
}

/** Object point [x, y, 0] for a chessboard corner id. */
export function cornerObjectPoint(id, cfg) {
    const nx = cfg.boardX - 1;
    const col = id % nx;
    const row = Math.floor(id / nx);
    return [(col + 1) * cfg.squareLength, (row + 1) * cfg.squareLength, 0];
}

/**
 * Object points for a list of corner ids as a flat Float64Array [x0,y0,z0, x1,...].
 * @param {ArrayLike<number>} ids
 */
export function objectPointsForIds(ids, cfg) {
    const nx = cfg.boardX - 1;
    const out = new Float64Array(ids.length * 3);
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        out[i * 3] = ((id % nx) + 1) * cfg.squareLength;
        out[i * 3 + 1] = (Math.floor(id / nx) + 1) * cfg.squareLength;
        out[i * 3 + 2] = 0;
    }
    return out;
}

/** All board corner object points keyed by id: {id: [x, y, 0]}. */
export function allCornerObjectPoints(cfg) {
    const out = {};
    const n = numCorners(cfg);
    for (let id = 0; id < n; id++) out[id] = cornerObjectPoint(id, cfg);
    return out;
}

/** Physical board extent in board units (mm): [width, height]. */
export function boardSize(cfg) {
    return [cfg.boardX * cfg.squareLength, cfg.boardY * cfg.squareLength];
}
