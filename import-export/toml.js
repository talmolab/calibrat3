/**
 * import-export/toml.js — sleap-anipose calibration.toml writer and a tiny
 * TOML reader for board.toml. Pure JS.
 *
 * calibration.toml (field names and order are read by sleap-anipose — keep):
 *
 *   [cam_0]
 *   name = "back"
 *   size = [1280, 1024]
 *   matrix = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]
 *   distortions = [k1, k2, p1, p2, k3]
 *   rotation = [rx, ry, rz]        # Rodrigues, world(=reference camera)->camera
 *   translation = [tx, ty, tz]     # board units (mm)
 */

import { dictNameFromToml, tomlFromDictName } from '../calib/board.js';

const f6 = v => Number(v).toFixed(6);
const f10 = v => Number(v).toFixed(10);

/**
 * @param {Array<{name:string, size:[number,number], K:number[][], dist:number[], rvec:number[], tvec:number[]}>} cameras
 * @param {{referenceName?:string, generated?:Date, generator?:string}} [meta]
 */
export function generateCalibrationToml(cameras, meta = {}) {
    const lines = [];
    lines.push('# Multi-camera calibration (calibrat3)');
    lines.push(`# Generated: ${(meta.generated || new Date()).toISOString()}`);
    if (meta.referenceName) lines.push(`# Reference camera: ${meta.referenceName}`);
    lines.push('');
    cameras.forEach((cam, i) => {
        const K = cam.K;
        lines.push(`[cam_${i}]`);
        lines.push(`name = "${escapeTomlString(cam.name)}"`);
        lines.push(`size = [${Math.round(cam.size[0])}, ${Math.round(cam.size[1])}]`);
        lines.push(`matrix = [[${f6(K[0][0])}, ${f6(K[0][1])}, ${f6(K[0][2])}], ` +
            `[${f6(K[1][0])}, ${f6(K[1][1])}, ${f6(K[1][2])}], ` +
            `[${f6(K[2][0])}, ${f6(K[2][1])}, ${f6(K[2][2])}]]`);
        lines.push(`distortions = [${cam.dist.map(f10).join(', ')}]`);
        lines.push(`rotation = [${cam.rvec.map(f10).join(', ')}]`);
        lines.push(`translation = [${cam.tvec.map(f6).join(', ')}]`);
        lines.push('');
    });
    if (meta.metadata) {
        lines.push('[metadata]');
        for (const [k, v] of Object.entries(meta.metadata)) {
            lines.push(`${k} = ${formatTomlValue(v)}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

/** board.toml writer (sleap-anipose keys). */
export function generateBoardToml(board) {
    const d = tomlFromDictName(board.dictName) || { markerBits: 4, dictSize: 1000 };
    return [
        `board_x = ${board.boardX}`,
        `board_y = ${board.boardY}`,
        `square_length = ${formatNumber(board.squareLength)}`,
        `marker_length = ${formatNumber(board.markerLength)}`,
        `marker_bits = ${d.markerBits}`,
        `dict_size = ${d.dictSize}`,
        '',
    ].join('\n');
}

/**
 * Parse board.toml into a board config. Accepts the sleap-anipose keys
 * (board_x, board_y, square_length, marker_length, marker_bits, dict_size);
 * unknown keys are kept in `extra`.
 * @returns {{board: object, extra: object}}
 */
export function parseBoardToml(text) {
    const raw = parseSimpleToml(text);
    const board = {};
    const extra = {};
    for (const [k, v] of Object.entries(raw)) {
        switch (k) {
            case 'board_x': board.boardX = Number(v); break;
            case 'board_y': board.boardY = Number(v); break;
            case 'square_length': board.squareLength = Number(v); break;
            case 'marker_length': board.markerLength = Number(v); break;
            case 'marker_bits': case 'dict_size': break;
            default: extra[k] = v;
        }
    }
    if (raw.marker_bits !== undefined && raw.dict_size !== undefined) {
        const name = dictNameFromToml(Number(raw.marker_bits), Number(raw.dict_size));
        if (name) board.dictName = name;
    }
    return { board, extra };
}

/**
 * Parse a calibration.toml (sleap-anipose / anipose format) back into camera
 * records. Used by session load and by tests.
 */
export function parseCalibrationToml(text) {
    const tables = parseTomlTables(text);
    const cameras = [];
    for (const [name, kv] of Object.entries(tables)) {
        if (!/^cam_\d+$/.test(name)) continue;
        cameras.push({
            index: parseInt(name.slice(4), 10),
            name: kv.name,
            size: kv.size,
            K: kv.matrix,
            dist: kv.distortions,
            rvec: kv.rotation,
            tvec: kv.translation,
        });
    }
    cameras.sort((a, b) => a.index - b.index);
    return { cameras, metadata: tables.metadata || {} };
}

// --- minimal TOML reader ---------------------------------------------------
// Handles: comments, `key = value` with numbers / booleans / strings /
// (nested) arrays, and `[table]` headers. Enough for board.toml and
// calibration.toml; not a general TOML parser.

export function parseSimpleToml(text) {
    return parseTomlTables(text).__root__ || {};
}

export function parseTomlTables(text) {
    const out = { __root__: {} };
    let cur = out.__root__;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripComment(rawLine).trim();
        if (!line) continue;
        const th = /^\[([^\]]+)\]$/.exec(line);
        if (th) {
            const name = th[1].trim();
            out[name] = out[name] || {};
            cur = out[name];
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().replace(/^"(.*)"$/, '$1');
        const value = line.slice(eq + 1).trim();
        cur[key] = parseTomlValue(value);
    }
    return out;
}

function stripComment(line) {
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== '\\') inStr = !inStr;
        if (c === '#' && !inStr) return line.slice(0, i);
    }
    return line;
}

function parseTomlValue(v) {
    if (v.startsWith('[')) return parseTomlArray(v);
    if (v.startsWith('"')) return v.slice(1, v.lastIndexOf('"')).replace(/\\"/g, '"');
    if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(v)) return v.includes('nan') ? NaN : (v.startsWith('-') ? -Infinity : Infinity);
    if (/^[+-]?(\d[\d_]*)(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return parseFloat(v.replace(/_/g, ''));
    return v;
}

function parseTomlArray(s) {
    // Recursive descent over a single-line (or joined) array literal.
    let i = 0;
    function parseAny() {
        skipWs();
        if (s[i] === '[') {
            i++;
            const arr = [];
            skipWs();
            while (s[i] !== ']') {
                arr.push(parseAny());
                skipWs();
                if (s[i] === ',') { i++; skipWs(); }
            }
            i++;
            return arr;
        }
        if (s[i] === '"') {
            let j = i + 1;
            while (j < s.length && !(s[j] === '"' && s[j - 1] !== '\\')) j++;
            const str = s.slice(i + 1, j);
            i = j + 1;
            return str.replace(/\\"/g, '"');
        }
        let j = i;
        while (j < s.length && s[j] !== ',' && s[j] !== ']') j++;
        const tok = s.slice(i, j).trim();
        i = j;
        return parseTomlValue(tok);
    }
    function skipWs() { while (i < s.length && /\s/.test(s[i])) i++; }
    return parseAny();
}

function formatTomlValue(v) {
    if (Array.isArray(v)) return `[${v.map(formatTomlValue).join(', ')}]`;
    if (typeof v === 'string') return `"${escapeTomlString(v)}"`;
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return formatNumber(v);
    return `"${escapeTomlString(String(v))}"`;
}

function formatNumber(v) {
    if (Number.isInteger(v)) return `${v}.0`;
    return String(v);
}

function escapeTomlString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
