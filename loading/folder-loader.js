/**
 * loading/folder-loader.js — discover calibration videos in a session folder.
 *
 * Supported layouts (both from the original calibration-studio prompt):
 *
 *   flat:    {root}/{view}.mp4                 view name = file stem
 *   nested:  {root}/{view}/calibration_images/*.mp4   (sleap-anipose / anipose)
 *            {root}/{view}/calibration/*.mp4
 *            {root}/{view}/*.mp4               (one video directly in the camera folder)
 *
 * board.toml is looked up at {root}/board.toml, then {root}/calibration/board.toml,
 * then inside any view's calibration folder.
 *
 * Two entry points produce the same session description:
 *   - scanDirectoryHandle(handle)  File System Access API (Chromium)
 *   - scanFileList(fileList)       <input type="file" webkitdirectory> fallback
 * and the sample session comes from loadSampleSession().
 */

import { parseBoardToml } from '../import-export/toml.js';

export const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const CALIB_DIRS = ['calibration_images', 'calibration', 'calib', 'calibration_videos'];

/**
 * @typedef {{name:string, source: File|string, path:string, size?:number}} ViewSource
 * @typedef {{layout:'flat'|'nested'|'none', views:ViewSource[], board:object|null, boardPath:string|null, notes:string[]}} SessionDescription
 */

/** Build a session description from a flat list of {path, file} (paths relative to root, '/'-separated). */
export async function buildSession(entries) {
    const notes = [];
    const norm = entries.map(e => ({ path: e.path.replace(/\\/g, '/').replace(/^\.?\//, ''), file: e.file }));
    const rootVideos = norm.filter(e => !e.path.includes('/') && VIDEO_EXT.test(e.path));
    let layout = 'none';
    let views = [];

    if (rootVideos.length > 0) {
        layout = 'flat';
        const stems = rootVideos.map(e => stem(e.path));
        const short = shortenNames(stems);
        views = rootVideos.map((e, i) => ({ name: short[i], source: e.file, path: e.path, size: e.file.size }));
        if (short.some((n, i) => n !== stems[i])) notes.push(`View names shortened from file names (common prefix/suffix removed): ${short.join(', ')}`);
    } else {
        // nested: group by first path segment
        const byCam = new Map();
        for (const e of norm) {
            if (!VIDEO_EXT.test(e.path)) continue;
            const parts = e.path.split('/');
            if (parts.length < 2) continue;
            const cam = parts[0];
            const sub = parts.slice(1, -1).map(s => s.toLowerCase());
            const inCalibDir = sub.some(s => CALIB_DIRS.includes(s));
            const direct = parts.length === 2;
            if (!inCalibDir && !direct) continue;   // ignore e.g. {cam}/recordings/*.mp4
            let list = byCam.get(cam);
            if (!list) { list = []; byCam.set(cam, list); }
            list.push({ ...e, inCalibDir, direct });
        }
        if (byCam.size > 0) {
            layout = 'nested';
            for (const [cam, list] of byCam) {
                // Prefer calibration-dir videos over direct ones; then alphabetical.
                list.sort((a, b) => (Number(b.inCalibDir) - Number(a.inCalibDir)) || a.path.localeCompare(b.path));
                const pick = list[0];
                if (list.length > 1) notes.push(`${cam}: ${list.length} calibration videos found, using ${pick.path}`);
                views.push({ name: cam, source: pick.file, path: pick.path, size: pick.file.size, alternates: list.slice(1).map(x => x.path) });
            }
        }
    }
    views.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    // board.toml discovery
    let board = null, boardPath = null;
    const tomls = norm.filter(e => /(^|\/)board\.toml$/i.test(e.path));
    if (tomls.length) {
        const rank = (p) => (p.split('/').length === 1 ? 0 : (/^calibration\//i.test(p) ? 1 : 2));
        tomls.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
        try {
            const text = await tomls[0].file.text();
            board = parseBoardToml(text).board;
            boardPath = tomls[0].path;
            if (tomls.length > 1) notes.push(`${tomls.length} board.toml files found, using ${boardPath}`);
        } catch (e) {
            notes.push(`Failed to parse ${tomls[0].path}: ${e.message}`);
        }
    }
    return { layout, views, board, boardPath, notes };
}

/** File System Access API: recursively list files up to `maxDepth` and build the session. */
export async function scanDirectoryHandle(dirHandle, maxDepth = 3) {
    const entries = [];
    async function walk(handle, prefix, depth) {
        for await (const entry of handle.values()) {
            const p = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === 'file') {
                if (VIDEO_EXT.test(entry.name) || /^board\.toml$/i.test(entry.name)) {
                    entries.push({ path: p, file: await entry.getFile() });
                }
            } else if (entry.kind === 'directory' && depth < maxDepth && !entry.name.startsWith('.')) {
                await walk(entry, p, depth + 1);
            }
        }
    }
    await walk(dirHandle, '', 0);
    const session = await buildSession(entries);
    session.rootName = dirHandle.name;
    return session;
}

/** <input type=file webkitdirectory> fallback. */
export async function scanFileList(fileList) {
    const files = Array.from(fileList);
    // webkitRelativePath includes the picked root folder as first segment: strip it.
    const entries = files.map(f => {
        const rel = f.webkitRelativePath || f.name;
        const parts = rel.split('/');
        return { path: parts.length > 1 ? parts.slice(1).join('/') : rel, file: f };
    });
    const session = await buildSession(entries);
    const first = files[0]?.webkitRelativePath?.split('/')[0];
    session.rootName = first || 'folder';
    return session;
}

/** Open the directory picker (Chromium) and scan it. Returns null if cancelled. */
export async function pickSessionFolder() {
    if (!('showDirectoryPicker' in window)) return { unsupported: true };
    try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        return await scanDirectoryHandle(handle);
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}

/** The bundled sample session (sleap-anipose minimal_session). */
export async function loadSampleSession(base = 'sample_session') {
    const names = ['back', 'mid', 'side', 'top'];
    const views = names.map(n => ({ name: n, source: `${base}/${n}.mp4`, path: `${base}/${n}.mp4` }));
    let board = null, boardPath = null;
    try {
        const resp = await fetch(`${base}/board.toml`);
        if (resp.ok) { board = parseBoardToml(await resp.text()).board; boardPath = `${base}/board.toml`; }
    } catch (_) { /* optional */ }
    return { layout: 'flat', views, board, boardPath, notes: [], rootName: base };
}

function stem(p) {
    const base = p.split('/').pop();
    return base.replace(/\.[^.]+$/, '');
}

/**
 * Strip the longest common prefix and suffix shared by ALL names, at token boundaries
 * ("-", "_", ".", " "), so `10072022145420-back-calibration` becomes `back`. Falls back
 * to the originals if the result would be empty or not unique.
 */
export function shortenNames(names) {
    if (names.length < 2) return names.slice();
    const sep = /[-_. ]/;
    const toks = names.map(n => n.split(/([-_. ])/));   // keep separators as tokens
    let pre = 0;
    while (toks.every(t => t.length > pre + 1 && t[pre] === toks[0][pre])) pre++;
    let suf = 0;
    while (toks.every(t => t.length - suf - 1 > pre && t[t.length - 1 - suf] === toks[0][toks[0].length - 1 - suf])) suf++;
    const out = toks.map(t => t.slice(pre, t.length - suf).join('').replace(new RegExp(`^${sep.source}+|${sep.source}+$`, 'g'), ''));
    if (out.some(n => !n) || new Set(out).size !== out.length) return names.slice();
    return out;
}
