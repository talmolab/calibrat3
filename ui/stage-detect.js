/**
 * ui/stage-detect.js — Stage 2: board configuration, single-frame detection,
 * and the batch detection runner.
 *
 * Batch detection = one sequential decode pass per view (loading/video.js
 * iterateFrames) feeding the worker pool (loading/detect-pool.js) with a
 * per-view in-flight cap. Nothing is drawn to the display canvases during
 * the run; the DOM sees one throttled progress update at a time.
 */

import { state, controllers, resetDownstreamOfDetection, viewNames, cameraColor } from './app-state.js';
import { DetectionStore } from '../calib/detection-store.js';
import { normalizeBoard, numCorners, numMarkers } from '../calib/board.js';
import { stridedFrames } from '../calib/frame-selection.js';
import { log, fmtMs } from './log-panel.js';
import { $, el, intInput, numInput, setStageStatus, expandStage, setEnabled, showError, Progress, errorColor } from './stages.js';
import { FrameStrip, viridisLike } from './frame-strip.js';
import { VirtualTable } from './virtual-table.js';
import { emit, on } from './events.js';
import { registerKeyHandler } from './video-panel.js';

const MAX_INFLIGHT_PER_VIEW = 2;   // frames handed to the pool but not yet returned, per view
const THUMB_WIDTH = 160;

let strip = null, table = null, progress = null;

export function setupDetectStage() {
    progress = new Progress('detectionProgress');
    for (const id of ['boardX', 'boardY', 'squareLength', 'markerLength', 'arucoDict']) {
        $(id).addEventListener('change', onBoardFormChanged);
    }
    onBoardFormChanged();
    $('targetSamples').addEventListener('input', updateSamplingInfo);
    $('allFramesCheck').addEventListener('change', updateSamplingInfo);
    $('detectCurrentBtn').addEventListener('click', () => detectCurrentFrame());
    $('runDetectionBtn').addEventListener('click', () => runBatchDetection());
    $('cancelDetectionBtn').addEventListener('click', () => state.detectionAbort && state.detectionAbort.abort());
    $('prevSampledBtn').addEventListener('click', () => stepSampled(-1));
    $('nextSampledBtn').addEventListener('click', () => stepSampled(1));
    $('tableMinCommon').addEventListener('input', renderTable);
    $('tableFilter').addEventListener('change', renderTable);

    strip = new FrameStrip($('detectionStrip'), {
        height: 40,
        tooltipEl: $('detectionStripTooltip'),
        tooltip: (f) => {
            const s = state.detections;
            const parts = state.views.map((v, i) => `${v.name.padEnd(10)} ${s.count(f, i)}`);
            return `frame ${f} · common ${s.commonCount(f)}\n${parts.join('\n')}`;
        },
        onClick: (f) => controllers.video.seekToFrame(f),
    });
    table = new VirtualTable($('detectionTable'), {
        columns: [],   // set when views are known
        height: 300,
        rowHeight: 24,
        onRowClick: (row) => controllers.video.seekToFrame(row.frame),
        emptyText: 'No frames match the filter',
    });

    on('session-loaded', () => { updateSamplingInfo(); buildTableColumns(); state.liveDetection = null; $('detectionResults').style.display = 'none'; $('detectCurrentResult').textContent = ''; });
    on('frame', ({ frame }) => { strip.setCurrent(frame); if (state.detections && state.detections.has(frame)) table.setSelected(frame, { scroll: true }); });

    registerKeyHandler((e) => {
        if (e.key === '[') { stepSampled(-1); return true; }
        if (e.key === ']') { stepSampled(1); return true; }
        if (e.key === 'd' || e.key === 'D') { detectCurrentFrame(); return true; }
        return false;
    });
}

// ---- board form --------------------------------------------------------------

export function getBoardFromForm() {
    return normalizeBoard({
        boardX: intInput('boardX', 8), boardY: intInput('boardY', 11),
        squareLength: numInput('squareLength', 24), markerLength: numInput('markerLength', 18.75),
        dictName: $('arucoDict').value,
    });
}

export function setBoardForm(board, sourceLabel = '') {
    if (board.boardX) $('boardX').value = board.boardX;
    if (board.boardY) $('boardY').value = board.boardY;
    if (board.squareLength) $('squareLength').value = board.squareLength;
    if (board.markerLength) $('markerLength').value = board.markerLength;
    if (board.dictName) $('arucoDict').value = board.dictName;
    $('boardSource').textContent = sourceLabel ? `(from ${sourceLabel})` : '';
    onBoardFormChanged();
}

function onBoardFormChanged() {
    try {
        state.board = getBoardFromForm();
        $('boardInfo').textContent = `${numCorners(state.board)} corners · ${numMarkers(state.board)} markers`;
        $('boardInfo').style.color = '';
        emit('board-changed', { board: state.board });
    } catch (e) {
        $('boardInfo').textContent = e.message;
        $('boardInfo').style.color = 'var(--bad)';
    }
}

function updateSamplingInfo() {
    if (!state.totalFrames) { $('computedStride').textContent = '–'; $('framesToProcess').textContent = '–'; return; }
    const { frames, stride } = plannedFrames();
    $('computedStride').textContent = String(stride);
    $('framesToProcess').textContent = `${frames.length} × ${state.views.length} views`;
    $('poolInfo').textContent = controllers.pool ? `${controllers.pool.size}` : '–';
}

function plannedFrames() {
    if ($('allFramesCheck').checked) return { frames: Array.from({ length: state.totalFrames }, (_, i) => i), stride: 1 };
    return stridedFrames(state.totalFrames, Math.max(1, intInput('targetSamples', 100)));
}

// ---- single frame --------------------------------------------------------------

export async function detectCurrentFrame() {
    if (!state.views.length || state.detectionRunning) return;
    const pool = controllers.pool;
    const frame = state.currentFrame;
    const board = getBoardFromForm();
    const t0 = performance.now();
    try {
        $('detectCurrentResult').textContent = 'detecting…';
        await pool.configure(board, { fastMarkers: $('fastDetectCheck').checked });
        const results = await Promise.all(state.views.map(async (view, v) => {
            const r = await view.decoder.getFrame(frame);
            if (!r) return null;
            // Copy: the cached bitmap must not be transferred away.
            const copy = await createImageBitmap(r.bitmap);
            return pool.detect({ frame, view: v, image: copy, width: view.canvas.width, height: view.canvas.height });
        }));
        state.liveDetection = { frame, perView: results.map(r => r ? { ids: r.ids, corners: r.corners } : null) };
        const parts = results.map((r, v) => `${state.views[v].name}: ${r ? `${r.numMarkers} markers / ${r.ids.length} corners (${r.ms.toFixed(0)} ms)` : 'no frame'}`);
        $('detectCurrentResult').textContent = parts.join(' · ');
        log(`Frame ${frame}: ${parts.join('; ')} — total ${fmtMs(performance.now() - t0)}`, results.some(r => r && r.ids.length) ? 'success' : 'warn');
        controllers.video.redraw();
    } catch (e) {
        showError(`Detection failed: ${e.message}`);
        $('detectCurrentResult').textContent = e.message;
    }
}

// ---- batch --------------------------------------------------------------------

export async function runBatchDetection() {
    if (!state.views.length || state.detectionRunning) return;
    const pool = controllers.pool;
    const vc = controllers.video;
    if (state.isPlaying) vc.stopPlayback();
    const board = getBoardFromForm();
    const { frames, stride } = plannedFrames();
    const nViews = state.views.length;
    const totalJobs = frames.length * nViews;

    state.detectionRunning = true;
    const abort = new AbortController();
    state.detectionAbort = abort;
    setEnabled('runDetectionBtn', false);
    setEnabled('detectCurrentBtn', false);
    setEnabled('computeIntrinsicsBtn', false);
    setEnabled('computeExtrinsicsBtn', false);
    $('cancelDetectionBtn').style.display = '';
    setStageStatus('stage2', 'Detecting…', 'active');
    progress.show(`0 / ${totalJobs}`);
    $('detectionResults').style.display = 'none';
    log(`Batch detection: ${frames.length} frames (stride ${stride}) × ${nViews} views = ${totalJobs} detections, board ${board.boardX}x${board.boardY} ${board.dictName}, ${pool.size} worker(s)`);

    const store = new DetectionStore(viewNames());
    state.detections = store;
    state.sampledFrames = frames.slice();
    state.thumbnails = new Map();
    state.liveDetection = null;
    resetDownstreamOfDetection();
    for (const f of frames) store.touch(f);

    const t0 = performance.now();
    let done = 0, failed = 0, lastUi = 0;
    const perViewDone = new Array(nViews).fill(0);
    const decodedAtStart = state.views.reduce((a, v) => a + v.decoder.stats.decoded, 0);
    const update = (force) => {
        const now = performance.now();
        if (!force && now - lastUi < 100) return;
        lastUi = now;
        const el = (now - t0) / 1000;
        const rate = done / Math.max(1e-3, el);
        const eta = rate > 0 ? (totalJobs - done) / rate : 0;
        progress.set(done / totalJobs, `${done} / ${totalJobs} · ${rate.toFixed(1)}/s · ETA ${fmtMs(eta * 1000)}`);
        $('detectionRate').textContent = `decoded ${state.views.reduce((a, v) => a + v.decoder.stats.decoded, 0) - decodedAtStart} frames for ${totalJobs} samples`;
    };
    const ticker = setInterval(() => update(false), 200);

    try {
        await pool.configure(board, { fastMarkers: $('fastDetectCheck').checked });
        const t1 = performance.now();
        await Promise.all(state.views.map(async (view, v) => {
            const inflight = new Set();
            const decoder = view.decoder;
            const decodedBefore = decoder.stats.decoded;
            try {
                for await (const { frame, videoFrame } of decoder.iterateFrames(frames, { maxPending: 2, signal: abort.signal })) {
                    if (abort.signal.aborted) { videoFrame.close(); break; }
                    while (inflight.size >= MAX_INFLIGHT_PER_VIEW) await Promise.race(inflight);
                    let p;
                    try {
                        p = pool.detect({ frame, view: v, image: videoFrame, width: view.info.width, height: view.info.height, wantThumb: v === 0, thumbWidth: THUMB_WIDTH });
                    } catch (e) {
                        try { videoFrame.close(); } catch (_) { /* */ }
                        throw e;
                    }
                    const job = p.then((res) => {
                        store.set(frame, v, res);
                        if (res.thumb) state.thumbnails.set(frame, res.thumb);
                    }, (err) => {
                        failed++;
                        store.set(frame, v, null);
                        log(`${view.name} frame ${frame}: detection error: ${err.message}`, 'debug');
                    }).finally(() => { inflight.delete(job); done++; perViewDone[v]++; });
                    inflight.add(job);
                }
            } catch (e) {
                if (!abort.signal.aborted) log(`${view.name}: decode error during batch: ${e.message}`, 'error');
            }
            await Promise.all(inflight);
            log(`${view.name}: decoded ${decoder.stats.decoded - decodedBefore} frames for ${frames.length} samples`, 'debug');
        }));
        const total = performance.now() - t0;
        clearInterval(ticker);
        update(true);
        const summary = store.summary(intInput('minCorners', 6));
        const avgMs = pool.stats.detections ? pool.stats.totalMs / pool.stats.detections : 0;
        const status = abort.signal.aborted ? 'cancelled' : 'complete';
        log(`Batch detection ${status} in ${fmtMs(total)} (configure ${fmtMs(t1 - t0)}): ${done} detections, ${failed} errors, ` +
            `${(done / (total / 1000)).toFixed(1)} det/s wall, ${avgMs.toFixed(0)} ms/detection in-worker; ` +
            `${summary.framesWithAnyDetection}/${frames.length} frames with a board, ${summary.framesAllViewsGood} good in all views; ` +
            `per view: ${state.views.map((v, i) => `${v.name}=${summary.perView[i]}`).join(' ')}`, abort.signal.aborted ? 'warn' : 'success');
        setStageStatus('stage2', `${summary.framesAllViewsGood} frames good in all views (${frames.length} sampled)`, abort.signal.aborted ? 'warn' : 'complete');
        if (abort.signal.aborted) progress.fail('Cancelled'); else progress.hide();
        renderResults();
        setStageStatus('stage3', 'Ready');
        setEnabled('computeIntrinsicsBtn', true);
        setEnabled('saveSessionBtn', true);
        expandStage('stage3');
        emit('detections-changed', {});
        vc.redraw();
    } catch (e) {
        clearInterval(ticker);
        progress.fail(e.message);
        setStageStatus('stage2', 'Failed', 'error');
        showError(`Batch detection failed: ${e.message}`);
        log(`Batch detection failed: ${e.stack || e.message}`, 'error');
    } finally {
        state.detectionRunning = false;
        state.detectionAbort = null;
        $('cancelDetectionBtn').style.display = 'none';
        setEnabled('runDetectionBtn', true);
        setEnabled('detectCurrentBtn', true);
    }
}

// ---- results ------------------------------------------------------------------

function buildTableColumns() {
    const cols = [{ key: 'frame', label: 'Frame', width: '80px', align: 'right' }];
    state.views.forEach((v, i) => cols.push({
        key: `c${i}`, label: v.name, width: '1fr', align: 'right',
        render: (r) => r.counts[i],
        color: (r) => (r.counts[i] >= 6 ? cameraColor(i) : (r.counts[i] > 0 ? '#fbbf24' : '#666')),
    }));
    cols.push({ key: 'common', label: 'Common', width: '90px', align: 'right', color: (r) => errorColor(-r.common, -6, -1) });
    cols.push({ key: 'views', label: 'Views', width: '70px', align: 'right' });
    table.columns = cols;
    table._build();
}

export function renderResults() {
    const store = state.detections;
    if (!store) return;
    $('detectionResults').style.display = '';
    const frames = store.frames();
    const maxCorners = numCorners(state.board);
    strip.setData({
        frames,
        colorFn: (f) => { const c = store.commonCount(f); return c === 0 ? '#2a2a2a' : viridisLike(Math.min(1, c / maxCorners)); },
        excluded: new Set(),
    });
    $('detectionStripLegend').replaceChildren(
        el('span', {}, [el('span', { class: 'sw', style: { background: '#2a2a2a' } }), 'no common corners']),
        el('span', {}, [el('span', { class: 'sw', style: { background: viridisLike(0.25) } }), `${Math.round(maxCorners * 0.25)}`]),
        el('span', {}, [el('span', { class: 'sw', style: { background: viridisLike(0.5) } }), `${Math.round(maxCorners * 0.5)}`]),
        el('span', {}, [el('span', { class: 'sw', style: { background: viridisLike(1) } }), `${maxCorners} common`]),
    );
    const s = store.summary(intInput('minCorners', 6));
    $('detectionSummary').textContent = `${frames.length} sampled · ${s.framesWithAnyDetection} with a board · ${s.framesAllViewsGood} good in all views`;
    if (table.columns.length === 0) buildTableColumns();
    renderTable();
}

function renderTable() {
    const store = state.detections;
    if (!store) return;
    const minCommon = intInput('tableMinCommon', 0);
    const filter = $('tableFilter').value;
    const nViews = state.views.length;
    const rows = [];
    for (const f of store.frames()) {
        const counts = state.views.map((_, i) => store.count(f, i));
        const views = counts.filter(c => c > 0).length;
        const common = store.commonCount(f);
        if (common < minCommon) continue;
        if (filter === 'any' && views === 0) continue;
        if (filter === 'allviews' && views < nViews) continue;
        if (filter === 'failed' && views === nViews) continue;
        rows.push({ frame: f, counts, common, views: `${views}/${nViews}` });
    }
    table.setRows(rows);
    $('tableCount').textContent = `${rows.length} rows`;
    if (store.has(state.currentFrame)) table.setSelected(state.currentFrame);
}

export function stepSampled(dir) {
    const frames = state.detections ? state.detections.frames() : state.sampledFrames;
    if (!frames || !frames.length) return;
    const cur = state.currentFrame;
    let target;
    if (dir > 0) target = frames.find(f => f > cur);
    else { for (let i = frames.length - 1; i >= 0; i--) if (frames[i] < cur) { target = frames[i]; break; } }
    if (target === undefined) target = dir > 0 ? frames[0] : frames[frames.length - 1];
    controllers.video.seekToFrame(target);
}
