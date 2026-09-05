/**
 * ui/overlays.js — draw detections / reprojections onto the view canvases.
 *
 * Overlays are drawn on the same canvas as the video (after the bitmap),
 * in layers so markers stay on top of circles across overlay types:
 *   1. detected corners (green circles, optional ids)
 *   2. intrinsic reprojection (red X)      — from per-frame rvec/tvec via pure-JS projectPoints
 *   3. cross-view reprojection (blue +)    — from triangulated points
 *   4. legend + frame info
 *
 * No OpenCV on the main thread: reprojection uses calib/geometry.js.
 */

import { state, cameraColor } from './app-state.js';
import { objectPointsForIds } from '../calib/board.js';
import { projectPoints, rodriguesToMatrix } from '../calib/geometry.js';

const C = {
    det: '#86efac', detStroke: '#166534',
    live: '#4ade80',
    intr: '#ef4444',
    extr: '#60a5fa',
    excluded: '#ff6b6b',
};

/** Draw every enabled overlay for `frame` on all views. */
export function drawAllOverlays(frame) {
    const ov = state.overlays;
    const store = state.detections;
    const scale = (view) => Math.max(1, view.canvas.width / 640);   // marker size scales with resolution

    for (let v = 0; v < state.views.length; v++) {
        const view = state.views[v];
        const ctx = view.ctx;
        const s = scale(view);
        const legend = [];
        let footer = [];

        // --- detections
        let det = null;
        if (state.liveDetection && state.liveDetection.frame === frame) det = state.liveDetection.perView[v];
        else if (store && store.has(frame)) det = store.get(frame, v);
        if (ov.detections && det && det.ids.length) {
            drawCorners(ctx, det.corners, { fill: C.det, stroke: C.detStroke, r: 4 * s, ids: ov.ids ? det.ids : null });
            legend.push({ kind: 'circle', color: C.det, label: `Detected (${det.ids.length})` });
        }

        // --- intrinsic reprojection
        const intr = state.intrinsics[v];
        if (ov.intrinsics && intr && intr.perFrame && det && det.ids.length) {
            const idx = frameIndex(intr.perFrame.frames, frame);
            if (idx >= 0 && isFinite(intr.perFrame.errors[idx])) {
                const rvec = Array.from(intr.perFrame.rvecs.subarray(idx * 3, idx * 3 + 3));
                const tvec = Array.from(intr.perFrame.tvecs.subarray(idx * 3, idx * 3 + 3));
                const cam = { K: intr.K, dist: intr.dist, R: rodriguesToMatrix(rvec), t: tvec };
                const proj = projectPoints(objectPointsForIds(det.ids, state.board), cam);
                drawX(ctx, proj, { color: C.intr, size: 4 * s });
                legend.push({ kind: 'x', color: C.intr, label: 'Intrinsic reproj' });
                const used = intr.perFrame.used[idx] ? 'used' : 'not used';
                const exc = state.exclusions.intrinsics.has(frame) ? ' · EXCLUDED' : '';
                footer.push(`intr ${intr.perFrame.errors[idx].toFixed(2)} px (${used}${exc})`);
            }
        }

        // --- cross-view reprojection
        const rec = state.reprojByFrame.get(frame);
        if (ov.extrinsics && rec && rec.views[v]) {
            const vr = rec.views[v];
            drawPlus(ctx, vr.proj, vr.mask, { color: C.extr, size: 5 * s });
            legend.push({ kind: 'plus', color: C.extr, label: 'Triangulated' });
            const exc = state.exclusions.extrinsics.has(frame) ? ' · EXCLUDED' : '';
            footer.push(`xview ${isFinite(vr.mean) ? vr.mean.toFixed(2) : '—'} px, ${vr.count} pts${exc}`);
        }

        if (legend.length) drawLegend(ctx, view.canvas.width, legend, s);
        if (footer.length) drawFooter(ctx, view.canvas, footer.join('  |  '), s);
    }
}

function frameIndex(frames, frame) {
    // frames is sorted ascending
    let lo = 0, hi = frames.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid] === frame) return mid;
        if (frames[mid] < frame) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

export function drawCorners(ctx, corners, { fill, stroke, r = 4, ids = null }) {
    const n = corners.length / 2;
    ctx.lineWidth = Math.max(1, r * 0.35);
    ctx.fillStyle = fill; ctx.strokeStyle = stroke;
    for (let i = 0; i < n; i++) {
        ctx.beginPath(); ctx.arc(corners[2 * i], corners[2 * i + 1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (ids) {
        ctx.font = `${Math.round(r * 2.6)}px monospace`;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 2;
        for (let i = 0; i < n; i++) {
            const x = corners[2 * i] + r + 2, y = corners[2 * i + 1] - r;
            ctx.strokeText(String(ids[i]), x, y); ctx.fillText(String(ids[i]), x, y);
        }
    }
}

function drawX(ctx, pts, { color, size }) {
    const n = pts.length / 2;
    ctx.lineCap = 'round';
    for (const pass of [['#fff', size * 0.9], [color, size * 0.45]]) {
        ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = pts[2 * i], y = pts[2 * i + 1];
            if (!isFinite(x)) continue;
            ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size);
            ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size);
        }
        ctx.stroke();
    }
}

function drawPlus(ctx, pts, mask, { color, size }) {
    const n = pts.length / 2;
    ctx.lineCap = 'round';
    for (const pass of [['#fff', size * 0.7], [color, size * 0.32]]) {
        ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            if (mask && !mask[i]) continue;
            const x = pts[2 * i], y = pts[2 * i + 1];
            if (!isFinite(x)) continue;
            ctx.moveTo(x - size, y); ctx.lineTo(x + size, y);
            ctx.moveTo(x, y - size); ctx.lineTo(x, y + size);
        }
        ctx.stroke();
    }
}

function drawLegend(ctx, canvasW, entries, s) {
    const fs = Math.round(11 * s);
    ctx.font = `${fs}px system-ui, sans-serif`;
    const w = Math.round(150 * s), lh = Math.round(18 * s);
    const x0 = canvasW - w - 6 * s, y0 = 6 * s;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x0, y0, w, lh * entries.length + 8 * s);
    entries.forEach((e, i) => {
        const cy = y0 + 4 * s + lh * i + lh / 2;
        const cx = x0 + 12 * s;
        ctx.lineCap = 'round';
        if (e.kind === 'circle') { ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(cx, cy, 4 * s, 0, Math.PI * 2); ctx.fill(); }
        else if (e.kind === 'x') { ctx.strokeStyle = e.color; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.moveTo(cx - 4 * s, cy - 4 * s); ctx.lineTo(cx + 4 * s, cy + 4 * s); ctx.moveTo(cx + 4 * s, cy - 4 * s); ctx.lineTo(cx - 4 * s, cy + 4 * s); ctx.stroke(); }
        else { ctx.strokeStyle = e.color; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.moveTo(cx - 5 * s, cy); ctx.lineTo(cx + 5 * s, cy); ctx.moveTo(cx, cy - 5 * s); ctx.lineTo(cx, cy + 5 * s); ctx.stroke(); }
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
        ctx.fillText(e.label, cx + 12 * s, cy + fs * 0.35);
    });
}

function drawFooter(ctx, canvas, text, s) {
    const fs = Math.round(11 * s);
    ctx.font = `${fs}px monospace`;
    const w = ctx.measureText(text).width + 12 * s, h = fs + 10 * s;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(6 * s, canvas.height - h - 6 * s, w, h);
    ctx.fillStyle = '#ddd'; ctx.textAlign = 'left';
    ctx.fillText(text, 12 * s, canvas.height - 6 * s - 5 * s);
}

/** Camera color helper re-export for stage modules. */
export { cameraColor };
