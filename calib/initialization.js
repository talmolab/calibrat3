/**
 * calib/initialization.js — app startup: wires the UI modules, spins up the
 * detection worker pool and the calibration worker, and handles the three
 * ways to open a session (sample, folder, saved session file).
 */

import { state, controllers } from '../ui/app-state.js';
import { initLogPanel, log, fmtMs } from '../ui/log-panel.js';
import { $, setupStageHeaders, showError, setStageStatus, expandStage, setEnabled } from '../ui/stages.js';
import { setupVideoPanel, loadSession, registerKeyHandler } from '../ui/video-panel.js';
import { setupDetectStage, setBoardForm, renderResults as renderDetections } from '../ui/stage-detect.js';
import { setupIntrinsicsStage, toggleIntrinsicsExclusion, stepWorst as stepWorstIntr, renderResults as renderIntrinsics } from '../ui/stage-intrinsics.js';
import { setupExtrinsicsStage, toggleExtrinsicsExclusion, stepWorst as stepWorstExtr } from '../ui/stage-extrinsics.js';
import { setupExportStage } from '../ui/stage-export.js';
import { DetectorPool } from '../loading/detect-pool.js';
import { CalibWorker } from '../loading/calib-client.js';
import { loadSampleSession, pickSessionFolder, scanFileList } from '../loading/folder-loader.js';
import { validateSession, restoreSession } from '../import-export/session-save.js';
import { emit } from '../ui/events.js';

export function initApp() {
    initLogPanel({ bodyEl: $('logBody'), copyBtn: $('copyLogBtn'), clearBtn: $('clearLogBtn'), verboseToggle: $('logVerbose'), countEl: $('logCount') });
    $('toggleLogBtn').addEventListener('click', (e) => {
        const c = $('diagnosticConsole').classList.toggle('collapsed');
        e.target.textContent = c ? 'Show' : 'Hide';
    });
    log('calibrat3 starting');
    if (!('VideoDecoder' in window)) showError('WebCodecs is not available in this browser. Use Chrome / Edge / recent Firefox.');
    if (!('OffscreenCanvas' in window)) showError('OffscreenCanvas is not available; detection workers need it.');

    setupStageHeaders();
    setupVideoPanel();
    setupDetectStage();
    setupIntrinsicsStage();
    setupExtrinsicsStage();
    setupExportStage();
    setupLoaders();
    setupGlobalKeys();
    startWorkers();

    window.addEventListener('beforeunload', () => {
        for (const v of state.views) { try { v.decoder.close(); } catch (_) { /* */ } }
        controllers.pool && controllers.pool.terminate();
        controllers.calib && controllers.calib.terminate();
    });
}

function startWorkers() {
    const status = $('workerStatus');
    const pool = new DetectorPool({ log });
    const calib = new CalibWorker({ log });
    controllers.pool = pool;
    controllers.calib = calib;
    const t0 = performance.now();
    status.textContent = `workers: loading OpenCV (${pool.size} detect + 1 calib)…`;
    Promise.all([pool.init(), calib.init()]).then(() => {
        status.textContent = `workers: ${pool.size} detect + 1 calib ready`;
        status.className = 'worker-status ok';
        $('poolInfo').textContent = String(pool.size);
        log(`All workers ready in ${fmtMs(performance.now() - t0)}`, 'success');
    }).catch((e) => {
        status.textContent = 'workers: failed';
        status.className = 'worker-status err';
        showError(`Worker startup failed: ${e.message}. Detection and calibration will not work.`);
    });
}

function setupLoaders() {
    $('loadSampleBtn').addEventListener('click', async () => {
        try {
            const session = await loadSampleSession('sample_session');
            await openSession(session);
        } catch (e) { showError(`Sample session failed: ${e.message}`); log(e.stack || e.message, 'error'); }
    });
    $('loadFolderBtn').addEventListener('click', async () => {
        try {
            const res = await pickSessionFolder();
            if (res === null) { log('Folder selection cancelled'); return; }
            if (res.unsupported) { $('folderInput').click(); return; }
            await openSession(res);
        } catch (e) { showError(`Failed to open folder: ${e.message}`); log(e.stack || e.message, 'error'); }
    });
    $('folderInput').addEventListener('change', async (e) => {
        if (!e.target.files.length) return;
        try { await openSession(await scanFileList(e.target.files)); }
        catch (err) { showError(`Failed to open folder: ${err.message}`); }
        e.target.value = '';
    });
    $('loadSessionBtn').addEventListener('click', () => $('sessionInput').click());
    $('sessionInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try { await loadSavedSession(JSON.parse(await file.text())); }
        catch (err) { showError(`Failed to load session: ${err.message}`); log(err.stack || err.message, 'error'); }
    });
}

async function openSession(session) {
    if (session.views.length === 0) {
        showError(`No calibration videos found (layout: ${session.layout}). Expected {root}/{view}.mp4 or {root}/{view}/calibration_images/*.mp4.`);
        return false;
    }
    const ok = await loadSession(session);
    if (ok && session.board) {
        setBoardForm(session.board, session.boardPath || 'board.toml');
        log(`Board from ${session.boardPath}: ${session.board.boardX}x${session.board.boardY}, square ${session.board.squareLength}, marker ${session.board.markerLength}, ${session.board.dictName || 'dictionary unchanged'}`, 'success');
    }
    return ok;
}

/** Restore a saved session: requires the same videos to be open (or opens them via a folder pick). */
async function loadSavedSession(saved) {
    if (saved.app !== 'calibrat3') throw new Error('not a calibrat3 session file');
    if (state.views.length === 0) {
        log(`Session "${saved.session?.name}" needs its videos: pick the session folder`, 'warn');
        const res = await pickSessionFolder();
        if (!res || res.unsupported) { if (res?.unsupported) showError('Open the folder first (button above), then load the saved session.'); return; }
        const ok = await loadSession(res);
        if (!ok) return;
    }
    const { ok, problems } = validateSession(saved, state);
    if (!ok) { showError(`Session does not match the open videos: ${problems.join('; ')}`); return; }
    restoreSession(saved, state);
    setBoardForm(state.board, 'saved session');
    $('referenceCamera').value = String(state.referenceView);
    log(`Restored session: ${state.detections ? state.detections.size : 0} sampled frames, ${state.intrinsics.filter(Boolean).length} intrinsics, ${state.extrinsics.filter(e => e && !e.error).length} extrinsics` +
        `${state.exclusions.intrinsics.size + state.exclusions.extrinsics.size ? `, ${state.exclusions.intrinsics.size}/${state.exclusions.extrinsics.size} exclusions` : ''}. Thumbnails are not stored; galleries show frame numbers only.`, 'success');
    if (state.detections) {
        renderDetections();
        setStageStatus('stage2', `${state.detections.summary(6).framesAllViewsGood} frames good in all views (${state.detections.size} sampled, restored)`, 'complete');
        setEnabled('computeIntrinsicsBtn', true);
        setStageStatus('stage3', 'Ready');
        emit('detections-changed', {});
    }
    if (state.intrinsics.some(Boolean)) {
        renderIntrinsics();
        setStageStatus('stage3', `${state.intrinsics.filter(Boolean).length} cameras (restored)`, 'complete');
        setEnabled('computeExtrinsicsBtn', true);
        setStageStatus('stage4', state.extrinsics.some(e => e && !e.error) ? 'Extrinsics restored — recompute to view reprojection' : 'Ready');
        expandStage('stage3');
        emit('intrinsics-changed', {});
    }
    controllers.video.redraw();
}

function setupGlobalKeys() {
    registerKeyHandler((e) => {
        if (e.key === 'x' || e.key === 'X') {
            const kind = state.activeExclusion || (state.reproj ? 'extrinsics' : 'intrinsics');
            if (kind === 'extrinsics') toggleExtrinsicsExclusion(state.currentFrame);
            else toggleIntrinsicsExclusion(state.currentFrame);
            return true;
        }
        if (e.key === '{' || e.key === '}') {
            const dir = e.key === '}' ? 1 : -1;
            const kind = state.activeExclusion || (state.reproj ? 'extrinsics' : 'intrinsics');
            if (kind === 'extrinsics') stepWorstExtr(dir); else stepWorstIntr(dir);
            return true;
        }
        return false;
    });
}
