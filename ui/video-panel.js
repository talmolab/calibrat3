/**
 * ui/video-panel.js — open a session's videos, build the view canvases,
 * wire the seekbar / transport / overlay toggles / hotkeys, and the
 * resizable two-pane layout.
 */

import { state, controllers, resetCalibrationState } from './app-state.js';
import { OnDemandVideoDecoder, VideoController } from '../loading/video.js';
import { log, fmtMs } from './log-panel.js';
import { $, el, setStageStatus, expandStage, showError, hideError, setEnabled } from './stages.js';
import { drawAllOverlays } from './overlays.js';
import { emit, on } from './events.js';

const keyHandlers = [];   // [(e) => boolean]
const BITMAP_BUDGET = 640 * 1024 * 1024;   // total ImageBitmap cache across all views

/** Register a hotkey handler; return true from it to stop further processing. */
export function registerKeyHandler(fn) { keyHandlers.push(fn); }

export function setupVideoPanel() {
    const vc = new VideoController(state, {
        drawOverlays: (frame) => drawAllOverlays(frame),
        onFrameRendered: (frame, ms) => {
            updateFrameInfo(frame);
            emit('frame', { frame, ms });
            if (ms > 250) log(`Frame ${frame}: ${fmtMs(ms)}${state.views.some(v => v.decoder.stats.restarts !== v.decoder._lastRestarts) ? ' (restarted from keyframe)' : ''}`, 'debug');
            for (const v of state.views) v.decoder._lastRestarts = v.decoder.stats.restarts;
        },
        onPlaybackStateChange: (playing) => { $('playBtn').textContent = playing ? '❚❚ Pause' : '▶ Play'; },
        onKey: (e) => {
            for (const h of keyHandlers) if (h(e)) return true;
            return false;
        },
    });
    controllers.video = vc;

    $('playBtn').addEventListener('click', () => vc.togglePlayback());
    $('prevFrameBtn').addEventListener('click', () => vc.seekToFrame(state.currentFrame - 1));
    $('nextFrameBtn').addEventListener('click', () => vc.seekToFrame(state.currentFrame + 1));
    $('prev10Btn').addEventListener('click', () => vc.seekToFrame(state.currentFrame - 10));
    $('next10Btn').addEventListener('click', () => vc.seekToFrame(state.currentFrame + 10));
    vc.setupSeekbar($('seekbar'), (frame) => updateSeekbarVisual(frame));
    vc.setupKeyboardHandlers();

    const bind = (id, key) => $(id).addEventListener('change', (e) => { state.overlays[key] = e.target.checked; vc.redraw(); });
    bind('ovDetections', 'detections');
    bind('ovIds', 'ids');
    bind('ovIntrinsics', 'intrinsics');
    bind('ovExtrinsics', 'extrinsics');

    setupResizeHandle();
    on('exclusions-changed', () => updateFrameInfo(state.currentFrame));
    on('detections-changed', () => updateFrameInfo(state.currentFrame));
    on('intrinsics-changed', () => updateFrameInfo(state.currentFrame));
}

/**
 * Open all videos of a session description (from loading/folder-loader.js).
 * @param {{views:Array<{name,source,path}>, board?:object, layout:string, rootName?:string, notes?:string[]}} session
 */
export async function loadSession(session) {
    hideError();
    const vc = controllers.video;
    if (state.isPlaying) vc.stopPlayback();
    for (const v of state.views) { try { v.decoder.close(); } catch (_) { /* */ } }
    state.views = [];
    resetCalibrationState();
    state.sessionName = session.rootName || 'session';
    state.sessionLayout = session.layout;
    $('sessionLabel').textContent = `${state.sessionName} (${session.layout})`;
    setStageStatus('stage1', 'Loading…', 'active');
    log(`Opening session "${state.sessionName}" — ${session.views.length} view(s), layout=${session.layout}`);
    for (const n of session.notes || []) log(n, 'warn');

    const list = $('viewList');
    list.replaceChildren(...session.views.map(v => el('div', { class: 'view-item' }, [
        el('span', { class: 'view-status loading' }),
        el('span', { class: 'view-name', text: v.name }),
        el('span', { class: 'view-path', text: v.path }),
        el('span', { class: 'view-meta', text: '' }),
    ])));
    const grid = $('videoGrid');
    grid.replaceChildren();
    const n = session.views.length;
    grid.className = `video-grid cols-${n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 25 ? 5 : 6}`;
    $('videoPanel').classList.remove('hidden');
    $('mainLayout').classList.remove('no-videos');

    const t0 = performance.now();
    const results = await Promise.all(session.views.map(async (v, i) => {
        const item = list.children[i];
        try {
            const decoder = new OnDemandVideoDecoder({ name: v.name, cacheSize: 24, lookahead: 8, log });
            const info = await decoder.init(v.source);
            item.querySelector('.view-status').className = 'view-status loaded';
            item.querySelector('.view-meta').textContent = `${info.width}×${info.height} · ${info.fps.toFixed(2)} fps · ${info.totalFrames} frames · ${info.keyframes} keyframes (GOP≈${info.avgGop.toFixed(0)})${info.hasBFrames ? ' · B-frames' : ''} · ${info.codec}`;
            log(`${v.name}: ${info.width}x${info.height}, ${info.totalFrames} frames @ ${info.fps.toFixed(2)} fps, ${info.keyframes} keyframes, codec ${info.codec}${info.hasBFrames ? ', B-frames present' : ''}`, 'success');
            return { v, decoder, info };
        } catch (err) {
            item.querySelector('.view-status').className = 'view-status error';
            item.querySelector('.view-meta').textContent = err.message;
            log(`Failed to open ${v.name}: ${err.message}`, 'error');
            return null;
        }
    }));

    for (const r of results) {
        if (!r) continue;
        const cell = el('div', { class: 'video-cell' });
        const canvas = el('canvas');
        canvas.width = r.info.width; canvas.height = r.info.height;
        cell.append(canvas, el('div', { class: 'video-label', text: r.v.name }), el('div', { class: 'video-metrics', text: `${r.info.width}×${r.info.height}` }));
        grid.appendChild(cell);
        state.views.push({ name: r.v.name, decoder: r.decoder, canvas, ctx: canvas.getContext('2d'), info: r.info, path: r.v.path, source: r.v.source });
        vc.setupZoomHandlers(r.v.name, canvas);
    }

    if (state.views.length === 0) {
        setStageStatus('stage1', 'Failed', 'error');
        showError('No video could be opened. Check the codec (H.264/H.265/VP8/VP9/AV1 via WebCodecs) and the folder layout.');
        return false;
    }
    // Bitmap cache budget. ImageBitmaps cost w*h*4 bytes. With many views the on-screen cells
    // are small, so cache display bitmaps at reduced resolution (overlays still draw at native
    // resolution on the canvas) and keep enough frames per view for smooth stepping/playback
    // (>= reorder depth + lookahead). Zooming a reduced-resolution view is softer, by design.
    const nV = state.views.length;
    const nativeBytes = state.views.reduce((a, v) => a + v.info.width * v.info.height * 4, 0) / nV;
    const MIN_FRAMES = 12;   // >= lookahead + B-frame reorder feed + slack, so stepping never restarts a GOP
    let scale = 1;
    while (scale > 0.25 && MIN_FRAMES * nativeBytes * scale * scale * nV > BITMAP_BUDGET) scale = Math.max(0.25, scale - 0.125);
    const perView = Math.max(MIN_FRAMES, Math.floor(BITMAP_BUDGET / (nativeBytes * scale * scale) / nV));
    for (const v of state.views) { v.decoder.cacheSize = Math.min(perView, 32); v.decoder.lookahead = Math.max(1, Math.min(8, perView - 10)); v.decoder.bitmapScale = scale; }
    log(`Frame cache: ${Math.min(perView, 32)} bitmaps/view at ${(scale * 100).toFixed(0)}% resolution (${(nativeBytes * scale * scale / 1e6).toFixed(1)} MB each, ${nV} views), lookahead ${state.views[0].decoder.lookahead}`, scale < 1 ? 'info' : 'debug');
    const counts = state.views.map(v => v.info.totalFrames);
    state.totalFrames = Math.min(...counts);
    state.fps = state.views[0].info.fps;
    state.currentFrame = 0;
    if (Math.max(...counts) !== state.totalFrames) {
        log(`Frame counts differ across views (${counts.join(', ')}); using the minimum ${state.totalFrames}`, 'warn');
    }
    $('totalFrames').textContent = String(state.totalFrames);
    const ref = $('referenceCamera');
    ref.replaceChildren(...state.views.map((v, i) => el('option', { value: String(i), text: v.name })));
    state.referenceView = 0;

    await vc.seekToFrame(0);
    setStageStatus('stage1', `${state.views.length} views · ${state.totalFrames} frames`, 'complete');
    setStageStatus('stage2', 'Ready');
    expandStage('stage2');
    setEnabled('detectCurrentBtn', true);
    setEnabled('runDetectionBtn', true);
    setEnabled('exportBoardBtn', true);
    log(`Session open in ${fmtMs(performance.now() - t0)}: ${state.views.length} synchronized views, ${state.totalFrames} frames`, 'success');
    emit('session-loaded', { session });
    return true;
}

export function updateSeekbarVisual(frame) {
    const maxFrame = Math.max(1, state.totalFrames - 1);
    const pct = state.totalFrames > 0 ? (frame / maxFrame) * 100 : 0;
    $('seekbarProgress').style.width = `${pct}%`;
    $('seekbarThumb').style.left = `${pct}%`;
    $('currentFrame').textContent = String(frame);
}

export function updateFrameInfo(frame) {
    updateSeekbarVisual(frame);
    const t = frame / (state.fps || 30);
    const mins = Math.floor(t / 60), secs = (t % 60).toFixed(3).padStart(6, '0');
    $('currentTime').textContent = `${mins}:${secs}`;
    const badges = [];
    if (state.detections && state.detections.has(frame)) badges.push(el('span', { class: 'badge sampled', text: 'sampled' }));
    if (state.exclusions.intrinsics.has(frame)) badges.push(el('span', { class: 'badge excluded', text: 'excl. intr' }));
    if (state.exclusions.extrinsics.has(frame)) badges.push(el('span', { class: 'badge excluded', text: 'excl. extr' }));
    $('frameBadges').replaceChildren(...badges);
}

function setupResizeHandle() {
    const handle = $('resizeHandle'), panel = $('videoPanel'), layout = $('mainLayout');
    let resizing = false;
    handle.addEventListener('mousedown', (e) => { resizing = true; handle.classList.add('dragging'); layout.classList.add('resizing'); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const rect = layout.getBoundingClientRect();
        const pct = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
        panel.style.width = `${pct}%`;
    });
    document.addEventListener('mouseup', () => { if (resizing) { resizing = false; handle.classList.remove('dragging'); layout.classList.remove('resizing'); } });
}
