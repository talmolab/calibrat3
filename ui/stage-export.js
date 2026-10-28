/**
 * ui/stage-export.js — Stage 5: calibration.toml / JSON exports, board.toml,
 * and session save. Each opens a save dialog in the session folder when the
 * browser can (see import-export/session-save.js saveText), else downloads.
 * (Session load lives in calib/initialization.js because it needs the video loader.)
 */

import { state } from './app-state.js';
import { generateCalibrationToml, generateBoardToml } from '../import-export/toml.js';
import { generateCalibrationJson } from '../import-export/sba-json.js';
import { serializeSession, saveText } from '../import-export/session-save.js';
import { log } from './log-panel.js';
import { $, setEnabled, setStageStatus, showError } from './stages.js';
import { on } from './events.js';

export function setupExportStage() {
    $('exportTomlBtn').addEventListener('click', async () => {
        const toml = buildToml();
        if (!toml) { showError('Complete intrinsics and extrinsics first.'); return; }
        if (await exportFile('calibration.toml', toml, 'text/plain')) setStageStatus('stage5', 'Exported', 'complete');
    });
    $('exportSbaJsonBtn').addEventListener('click', () => {
        const data = generateCalibrationJson(state);
        if (!data) { showError('Compute intrinsics first.'); return; }
        exportFile('calibration_data.json', () => JSON.stringify(data), 'application/json',
            (text) => ` (${(text.length / 1e6).toFixed(1)} MB, ${data.observations.length} frames, ${data.triangulated_points.length} triangulated frames)`);
    });
    $('exportBoardBtn').addEventListener('click', () => {
        exportFile('board.toml', generateBoardToml(state.board), 'text/plain');
    });
    $('saveSessionBtn').addEventListener('click', () => {
        const name = `${(state.sessionName || 'session').replace(/[^\w.-]+/g, '_')}.calibrat3.json`;
        exportFile(name, () => JSON.stringify(serializeSession(state)), 'application/json',
            (text) => ` (${(text.length / 1e6).toFixed(1)} MB)`);
    });
    on('extrinsics-changed', updateTomlPreview);
    on('intrinsics-changed', updateTomlPreview);
    on('detections-changed', updateTomlPreview);
    on('session-loaded', updateTomlPreview);
}

let warnedNoFolderSave = false;

/**
 * Save one export (saveText: dialog in the session folder, else a download) and log
 * where it went. `content` is the text or a function producing it; `details(text)`
 * is appended to the log line. Resolves true when the file was saved or downloaded.
 */
async function exportFile(filename, content, type, details = () => '') {
    let res;
    try { res = await saveText(filename, content, { type, startIn: state.sessionDirHandle }); }
    catch (e) { showError(`Saving ${filename} failed: ${e.message}`); log(e.stack || e.message, 'error'); return false; }
    if (!res) { log(`Saving ${filename} cancelled`); return false; }
    const extra = details(res.text);
    if (res.how === 'picker') {
        const rel = await state.sessionDirHandle.resolve(res.handle).catch(() => null);
        log(rel ? `Saved ${state.sessionName}/${rel.join('/')}${extra}` : `Saved ${res.handle.name} (outside the session folder)${extra}`, 'success');
        return true;
    }
    log(`Downloaded ${filename}${extra}`, 'success');
    if (res.reason === 'error') log(`The save dialog could not open in the session folder (${res.error.message}), so ${filename} was downloaded instead`, 'warn');
    if (res.reason === 'unsupported' && !warnedNoFolderSave) {
        warnedNoFolderSave = true;
        log('This browser cannot open a save dialog in the session folder, so exports go wherever it saves downloads. ' +
            'Chrome and Edge can; in Brave, turn on "File System Access API" in brave://flags, restart, and open the folder again.', 'warn');
    }
    return true;
}

export function buildToml() {
    const cams = [];
    state.views.forEach((v, i) => {
        const intr = state.intrinsics[i], extr = state.extrinsics[i];
        if (!intr || !extr || extr.error) return;
        cams.push({ name: v.name, size: [intr.imageSize.width, intr.imageSize.height], K: intr.K, dist: intr.dist, rvec: extr.rvec, tvec: extr.tvec });
    });
    if (cams.length === 0) return null;
    return generateCalibrationToml(cams, {
        referenceName: state.views[state.referenceView]?.name,
        metadata: {
            generator: 'calibrat3', session: state.sessionName, board: `${state.board.boardX}x${state.board.boardY} ${state.board.dictName}`,
            sampled_frames: state.sampledFrames.length, refined_by_sba: !!state.sbaResult,
            ...(state.reproj ? { mean_reprojection_error_px: Number(state.reproj.summary.overall.mean.toFixed(4)) } : {}),
        },
    });
}

export function updateTomlPreview() {
    const pre = $('tomlPreview');
    const toml = buildToml();
    const ready = !!toml && state.views.every((v, i) => state.extrinsics[i] && !state.extrinsics[i].error);
    setEnabled('exportTomlBtn', !!toml);
    setEnabled('exportSbaJsonBtn', state.intrinsics.some(Boolean));
    setEnabled('saveSessionBtn', !!state.detections);
    if (toml) { pre.textContent = toml; pre.classList.remove('muted'); if (ready) setStageStatus('stage5', 'Ready', ''); }
    else { pre.textContent = '# Complete intrinsics and extrinsics to generate the TOML'; pre.classList.add('muted'); }
}
