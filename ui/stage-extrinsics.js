/**
 * ui/stage-extrinsics.js — Stage 4: initial extrinsics (covisibility graph →
 * relative poses → chain), cross-view triangulation/reprojection, and bundle
 * adjustment. All heavy work runs in the calibration worker with progress.
 */

import { state, controllers, cameraColor } from './app-state.js';
import { log, fmtMs } from './log-panel.js';
import { $, el, intInput, numInput, setStageStatus, expandStage, setEnabled, showError, Progress, errorColor } from './stages.js';
import { FrameStrip, errorColormap } from './frame-strip.js';
import { SwarmPlot, drawLineChart } from './plots.js';
import { FrameGallery } from './gallery.js';
import { indexReprojectionByFrame } from '../calib/triangulation.js';
import { prepareSbaInput, applySbaResults, sbaReferenceIndex, filterSbaInput, outlierSchedule } from '../calib/sba.js';
import { percentile } from '../calib/geometry.js';
import { boardMotionScores, framesAboveMotion, motionSummary } from '../calib/motion.js';
import { cameraCenter } from '../calib/geometry.js';
import { emit, on } from './events.js';

let strip = null, plot = null, gallery = null, progress = null, sbaProgress = null;
let worstOrder = [];
let preSba = null;   // {intrinsics, extrinsics} before the last SBA run

export function setupExtrinsicsStage() {
    progress = new Progress('extrinsicsProgress');
    sbaProgress = new Progress('sbaProgress');
    $('computeExtrinsicsBtn').addEventListener('click', () => computeExtrinsics());
    $('runSbaBtn').addEventListener('click', () => runSba());
    $('revertSbaBtn').addEventListener('click', () => revertSba());
    $('referenceCamera').addEventListener('change', (e) => { state.referenceView = parseInt(e.target.value, 10) || 0; });
    $('clearExtrinsicsExclusionsBtn').addEventListener('click', () => { state.exclusions.extrinsics.clear(); emit('exclusions-changed', { kind: 'extrinsics' }); });

    strip = new FrameStrip($('extrinsicsStrip'), {
        height: 40,
        tooltipEl: $('extrinsicsStripTooltip'),
        tooltip: (f) => {
            const rec = state.reprojByFrame.get(f);
            if (!rec) return `frame ${f}\nno triangulation`;
            const per = state.views.map((v, i) => `${v.name.padEnd(10)} ${rec.views[i] ? rec.views[i].mean.toFixed(2) + ' (' + rec.views[i].count + ')' : '–'}`).join('\n');
            return `frame ${f} · mean ${rec.meanErr.toFixed(2)} px · ${rec.n} pts${state.exclusions.extrinsics.has(f) ? ' · EXCLUDED' : ''}\n${per}`;
        },
        onClick: (f) => { setActive(); controllers.video.seekToFrame(f); },
    });
    plot = new SwarmPlot($('extrinsicsPlot'), $('extrinsicsPlotTooltip'), {
        yLabel: 'mean reproj error / frame (px)',
        height: 250,
        formatTooltip: (p) => `${p.group}  frame ${p.frame}\nmean ${p.y.toFixed(3)} px over ${p.meta.count} pts (max ${p.meta.max.toFixed(2)})${p.excluded ? '\nEXCLUDED' : ''}\nclick to seek`,
        onClick: (p) => { setActive(); controllers.video.seekToFrame(p.frame); },
    });
    gallery = new FrameGallery($('extrinsicsGallery'), {
        getThumb: (f) => state.thumbnails.get(f) || null,
        onSeek: (f) => { setActive(); controllers.video.seekToFrame(f); },
        onToggleExclude: (f) => toggleExtrinsicsExclusion(f),
        limit: 40,
    });
    $('stage4').addEventListener('mousedown', () => { if (state.reproj) setActive(); });

    on('frame', ({ frame }) => { strip.setCurrent(frame); gallery.setCurrent(frame); });
    on('exclusions-changed', ({ kind }) => { if (kind === 'extrinsics') refreshExclusionViews(); });
    on('intrinsics-changed', () => { hideResults(); });
    on('detections-changed', () => { hideResults(); setEnabled('computeExtrinsicsBtn', false); });
    on('session-loaded', () => { hideResults(); setEnabled('computeExtrinsicsBtn', false); setStageStatus('stage4', 'Waiting for intrinsics'); });
}

function hideResults() {
    $('extrinsicsResults').style.display = 'none';
    $('sbaPanel').style.display = 'none';
    $('sbaResult').style.display = 'none';
    $('revertSbaBtn').style.display = 'none';
    setEnabled('runSbaBtn', false);
    preSba = null;
    state.reprojInitialSummary = null;
}

function setActive() { if (state.activeExclusion !== 'extrinsics') { state.activeExclusion = 'extrinsics'; emit('active-exclusion', { kind: 'extrinsics' }); } }

/** Frames excluded from fitting: the user's manual exclusions plus motion-filtered frames. */
function fitExclusions() {
    const set = new Set(state.exclusions.extrinsics);
    if (state.motionExcluded) for (const f of state.motionExcluded) set.add(f);
    return set;
}

function intrinsicsPayload() { return state.intrinsics.map(r => r ? { K: r.K, dist: r.dist } : null); }
function extrinsicsPayload() { return state.extrinsics.map(e => (e && !e.error) ? { R: e.R, tvec: e.tvec } : null); }

// ---- compute initial extrinsics -----------------------------------------------

export async function computeExtrinsics() {
    const store = state.detections;
    const calibrated = state.intrinsics.filter(Boolean).length;
    if (!store || calibrated < 2) { showError('Compute intrinsics for at least two cameras first.'); return; }
    const cw = controllers.calib;
    const refIdx = state.referenceView = parseInt($('referenceCamera').value, 10) || 0;
    if (!state.intrinsics[refIdx]) { showError('The reference camera has no intrinsics.'); return; }
    const minCovisible = intInput('minCovisible', 10);
    const maxFramesPerPair = intInput('maxPairFrames', 300);
    const minCorners = intInput('minCorners', 6);
    const maxMotion = numInput('maxMotion', 0);
    // Board motion per frame: frames above the threshold are excluded from the graph and from SBA
    // (kept separate from the user's manual exclusions; still evaluated in the reprojection report).
    const motion = boardMotionScores(store, { minCorners });
    state.motionScores = motion;
    state.motionExcluded = framesAboveMotion(motion, maxMotion);
    const ms = motionSummary(motion);
    if (ms) log(`Board motion (px/frame, max over cameras): median ${ms.median.toFixed(1)}, p25 ${ms.p25.toFixed(1)}, p75 ${ms.p75.toFixed(1)}, p90 ${ms.p90.toFixed(1)}` + (maxMotion > 0 ? ` — ${state.motionExcluded.size} frames above ${maxMotion} excluded from extrinsics/SBA` : ' — motion filter off'));
    setEnabled('computeExtrinsicsBtn', false);
    setEnabled('runSbaBtn', false);
    setStageStatus('stage4', 'Computing…', 'active');
    progress.show('building covisibility graph');
    const t0 = performance.now();
    log(`Extrinsics: reference=${state.views[refIdx].name}, minCovisible=${minCovisible}, maxFrames/pair=${maxFramesPerPair || 'all'}, excluded=${state.exclusions.extrinsics.size}`);
    try {
        const res = await cw.request('extrinsics', {
            store: store.toPlain(), intrinsics: intrinsicsPayload(), board: state.board, refIdx,
            minCovisible, minCorners, excluded: Array.from(fitExclusions()), maxFramesPerPair,
        }, { onProgress: (f, msg) => progress.set(f * 0.5, msg) });

        state.extrinsics = res.extrinsics;
        state.extrinsicsMeta = { pairCounts: res.pairCounts, chain: res.chain, relativePoses: new Map(res.relativePoses), refIdx };
        state.sbaResult = null; preSba = null;
        const names = state.views.map(v => v.name);
        for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
            const c = res.pairCounts[a][b];
            log(`covisibility ${names[a]}–${names[b]}: ${c} frames`, c ? 'debug' : 'warn');
        }
        for (const [key, rp] of state.extrinsicsMeta.relativePoses) {
            const [p, c] = key.split('->').map(Number);
            if (rp.error) { log(`relative pose ${names[p]}→${names[c]}: ${rp.error}`, 'error'); continue; }
            log(`relative pose ${names[p]}→${names[c]}: ${rp.inliers}/${rp.framesUsed} inlier frames, |t|=${Math.hypot(...rp.tvec).toFixed(1)} mm, σt=${rp.tStd.toFixed(2)} mm, σrot=${rp.rotStdDeg.toFixed(3)}°`, rp.tStd > 5 ? 'warn' : 'info');
        }
        for (const u of res.chain.unreachable) log(`${names[u]} is not reachable from ${names[refIdx]} — increase sampling or lower min covisible corners`, 'error');
        log(`Initial extrinsics in ${fmtMs(res.timings.totalMs)} (graph ${fmtMs(res.timings.graphMs)})`, 'success');
        renderPoseTables();

        await computeReprojection((f, msg) => progress.set(0.5 + 0.5 * f, msg));
        state.reprojInitialSummary = state.reproj.summary;   // kept for the before/after table
        renderStatsTable();
        progress.hide();
        const s = state.reproj.summary;
        setStageStatus('stage4', `initial · mean ${s.overall.mean.toFixed(2)} px (median ${s.overall.median.toFixed(2)})`, s.overall.median < 1 ? 'complete' : 'warn');
        $('sbaPanel').style.display = '';
        setEnabled('runSbaBtn', true);
        setActive();
        emit('extrinsics-changed', {});
        expandStage('stage5');
        setStageStatus('stage5', 'Ready');
    } catch (e) {
        progress.fail(e.message);
        setStageStatus('stage4', 'Failed', 'error');
        showError(`Extrinsics failed: ${e.message}`);
        log(`Extrinsics failed: ${e.stack || e.message}`, 'error');
    } finally {
        setEnabled('computeExtrinsicsBtn', true);
    }
}

/** Triangulate + reproject for arbitrary intrinsics/extrinsics arrays (no state change). */
async function requestReprojection(intr, extr, onProgress) {
    return controllers.calib.request('reprojection', {
        store: state.detections.toPlain(),
        intrinsics: intr.map(r => r ? { K: r.K, dist: r.dist } : null),
        extrinsics: extr.map(e => (e && !e.error) ? { R: e.R, tvec: e.tvec } : null),
        opts: { minCorners: 4, minViews: 2 },
    }, { onProgress });
}

/** Triangulate + reproject with the current intrinsics/extrinsics; updates strip/plot/gallery. */
async function computeReprojection(onProgress) {
    const t0 = performance.now();
    const res = await requestReprojection(state.intrinsics, state.extrinsics, onProgress);
    state.reproj = res;
    state.reprojByFrame = indexReprojectionByFrame(res);
    const s = res.summary;
    log(`Cross-view reprojection: ${s.frames} frames, ${s.points} points, ${s.observations} observations in ${fmtMs(performance.now() - t0)} | ` +
        `mean ${s.overall.mean.toFixed(3)} px, median ${s.overall.median.toFixed(3)}, p95 ${s.overall.p95.toFixed(2)}, max ${s.overall.max.toFixed(1)} | ` +
        `per camera: ${state.views.map((v, i) => `${v.name}=${s.perView[i].mean.toFixed(2)}`).join(' ')}`, s.overall.median < 1 ? 'success' : 'warn');
    renderReprojection();
    controllers.video.redraw();
}

// ---- SBA ----------------------------------------------------------------------

export async function runSba() {
    if (!state.reproj) return;
    const refIdx = state.referenceView;
    const rounds = Math.max(1, intInput('sbaOutlierRounds', 2));
    const finalThr = numInput('sbaOutlierThreshold', 3);
    const startThr = numInput('sbaOutlierStart', 0);
    const maxIters = intInput('sbaMaxIterations', 100);
    const maxPoints = intInput('sbaMaxPoints', 20000);
    const prep = (reproj, intr, extr) => prepareSbaInput(reproj, intr, extr, { excludedFrames: fitExclusions(), maxPoints });
    const input0 = prep(state.reproj, state.intrinsics, state.extrinsics);
    if (input0.points.length < 10) { showError('Not enough triangulated points for bundle adjustment.'); return; }
    const baseConfig = {
        max_iterations: maxIters,
        robust_loss: $('sbaRobustLoss').value,
        robust_loss_param: numInput('sbaLossParam', 1.0),
        outlier_threshold: 0,                       // rejection is done here (anipose-style, per point), not inside the solver
        optimize_extrinsics: $('sbaOptExtrinsics').checked,
        optimize_intrinsics: $('sbaOptIntrinsics').checked,
        optimize_points: $('sbaOptPoints').checked,
        cost_tolerance: numInput('sbaCostTol', 1e-6),
        parameter_tolerance: numInput('sbaParamTol', 1e-8),
        gradient_tolerance: numInput('sbaGradTol', 1e-10),
        reference_camera: sbaReferenceIndex(input0, refIdx),
    };
    setEnabled('runSbaBtn', false);
    setEnabled('computeExtrinsicsBtn', false);
    sbaProgress.show('preparing');
    const t0 = performance.now();
    try {
        if (!preSba) preSba = { intrinsics: state.intrinsics.slice(), extrinsics: state.extrinsics.slice() };
        const s0 = state.reprojInitialSummary || state.reproj.summary;
        const finite0 = input0.meta.pointErr.filter(Number.isFinite);
        const start = startThr > 0 ? startThr : Math.max(finalThr * 3, percentile(finite0, 0.95));
        const schedule = finalThr > 0 ? outlierSchedule(Math.max(start, finalThr), finalThr, rounds) : [Infinity];
        log(`SBA: ${input0.meta.numCameras} cameras, ${input0.meta.numPoints} points (${input0.meta.numFrames} frames${input0.meta.frameStride > 1 ? `, every ${input0.meta.frameStride}th` : ''}), ${input0.meta.numObservations} observations; ` +
            `${schedule.length} round(s), point-error thresholds ${schedule.map(t => Number.isFinite(t) ? t.toFixed(1) : 'none').join(' → ')} px, ${baseConfig.robust_loss}(${baseConfig.robust_loss_param}), ref=${state.views[refIdx].name}, ` +
            `optimize: ${['extrinsics', 'intrinsics', 'points'].filter((k, i) => [baseConfig.optimize_extrinsics, baseConfig.optimize_intrinsics, baseConfig.optimize_points][i]).join('+')}; ` +
            `initial per-point error median ${percentile(finite0, 0.5).toFixed(2)} px, p95 ${percentile(finite0, 0.95).toFixed(2)} px`);

        // Model selection: try the configured fit; if the re-triangulated error over ALL
        // observations gets worse and intrinsics were free, retry with intrinsics fixed.
        // Never accept a result worse than the initial calibration.
        const attempts = [];
        const a1 = await sbaAttempt(baseConfig, schedule, prep, 0, baseConfig.optimize_intrinsics ? 0.5 : 1);
        attempts.push(a1);
        const median = (r) => r.reproj.summary.overall.median;
        if (baseConfig.optimize_intrinsics && median(a1) > s0.overall.median * 0.98) {
            log(`SBA with free intrinsics did not improve the re-triangulated error (${s0.overall.median.toFixed(2)} → ${median(a1).toFixed(2)} px); retrying with intrinsics fixed`, 'warn');
            attempts.push(await sbaAttempt({ ...baseConfig, optimize_intrinsics: false }, schedule, prep, 0.5, 0.5));
        }
        attempts.sort((a, b) => median(a) - median(b));
        const best = attempts[0];
        const improved = median(best) < s0.overall.median * 0.995;
        if (!improved) {
            // Keep the initial calibration; report what was tried.
            sbaProgress.fail('no improvement');
            state.sbaResult = null;
            $('sbaResult').style.display = '';
            $('revertSbaBtn').style.display = 'none';
            $('sbaSummary').textContent = `No improvement: ${attempts.map(a => `${a.label} → median ${median(a).toFixed(2)} px`).join('; ')} vs initial ${s0.overall.median.toFixed(2)} px. Initial calibration kept. ${fmtMs(performance.now() - t0)}`;
            drawLineChart($('sbaChart'), best.lastResult.cost_history, { label: `cost, ${best.label} (log)` });
            log(`Bundle adjustment could not improve on the initial calibration (${attempts.map(a => `${a.label}: ${median(a).toFixed(2)} px`).join(', ')} vs ${s0.overall.median.toFixed(2)} px). ` +
                `The solver lowers its own cost by moving free 3D points, so the 2D observations are not mutually consistent across cameras (camera timing / board motion / bad frames). ` +
                `Try: exclude fast frames (max board motion), fewer rounds, check that the videos are frame-synchronized.`, 'warn');
            showError(`Bundle adjustment did not improve the cross-view error (best ${median(best).toFixed(2)} vs initial ${s0.overall.median.toFixed(2)} px median); the initial calibration was kept. See the log for suggestions.`);
            setStageStatus('stage4', `initial · mean ${s0.overall.mean.toFixed(2)} px (median ${s0.overall.median.toFixed(2)}) · SBA gave no improvement`, 'warn');
            preSba = null;
            emit('extrinsics-changed', {});
            return;
        }
        state.intrinsics = best.intr;
        state.extrinsics = best.extr;
        state.reproj = best.reproj;
        state.reprojByFrame = indexReprojectionByFrame(best.reproj);
        const nPts = best.input.points.length, kept = best.lastInput.points.length;
        const lr = best.lastResult;
        const improvement = (lr.initial_cost - lr.final_cost) / Math.max(1e-9, lr.initial_cost) * 100;
        state.sbaResult = { result: lr, rounds: best.roundLog, attempts: attempts.map(a => ({ label: a.label, median: median(a) })), config: { ...best.config, rounds: schedule.length, thresholds: schedule, finalThreshold: best.lastMu }, meta: { ...best.lastInput.meta, pointsTotal: nPts, pointsExcluded: nPts - kept, observationsTotal: best.input.observations.length, observationsExcluded: best.input.observations.length - best.lastInput.observations.length } };
        sbaProgress.hide();
        renderPoseTables();
        renderReprojection();
        renderStatsTable();
        controllers.video.redraw();
        $('sbaResult').style.display = '';
        $('revertSbaBtn').style.display = '';
        $('sbaSummary').textContent = `${best.label} · ${schedule.length} round(s) · final fit on ${kept}/${nPts} points (threshold ${Number.isFinite(best.lastMu) ? best.lastMu.toFixed(1) : 'none'} px) · ` +
            `last round ${lr.iterations} iterations, cost ${lr.initial_cost.toFixed(0)} → ${lr.final_cost.toFixed(0)} (−${improvement.toFixed(1)}%) · ${lr.status}` +
            (attempts.length > 1 ? ` · also tried ${attempts.slice(1).map(a => `${a.label} (${median(a).toFixed(2)} px)`).join(', ')}` : '') + ` · ${fmtMs(performance.now() - t0)}`;
        drawLineChart($('sbaChart'), lr.cost_history, { label: 'cost, last round (log)' });
        const s = state.reproj.summary;
        log(`Bundle adjustment done in ${fmtMs(performance.now() - t0)} (${best.label}): cross-view reprojection median ${s0.overall.median.toFixed(2)} → ${s.overall.median.toFixed(2)} px, mean ${s0.overall.mean.toFixed(2)} → ${s.overall.mean.toFixed(2)} px over all observations; ${nPts - kept} points excluded from the final fit`, 'success');
        setStageStatus('stage4', `refined · mean ${s.overall.mean.toFixed(2)} px (median ${s.overall.median.toFixed(2)})`, s.overall.median < 1 ? 'complete' : 'warn');
        emit('extrinsics-changed', {});
    } catch (e) {
        sbaProgress.fail(e.message);
        showError(`Bundle adjustment failed: ${e.message}`);
        log(`SBA failed: ${e.stack || e.message}`, 'error');
    } finally {
        setEnabled('runSbaBtn', true);
        setEnabled('computeExtrinsicsBtn', true);
    }
}

/**
 * One SBA attempt: rounds of per-point rejection + solve + re-triangulation, starting
 * from the current state. Returns refined arrays without touching state.
 */
async function sbaAttempt(config, schedule, prep, progressBase, progressSpan) {
    const cw = controllers.calib;
    const label = `optimize ${['extrinsics', 'intrinsics', 'points'].filter((k, i) => [config.optimize_extrinsics, config.optimize_intrinsics, config.optimize_points][i]).join('+')}`;
    let intr = state.intrinsics, extr = state.extrinsics, reproj = state.reproj;
    let input = prep(reproj, intr, extr);
    let lastResult = null, lastInput = null, lastMu = Infinity;
    const roundLog = [];
    const P = (f, msg) => sbaProgress.set(progressBase + progressSpan * f, `${label}: ${msg}`);
    for (let r = 0; r < schedule.length; r++) {
        const errs = input.meta.pointErr;
        const finite = errs.filter(Number.isFinite);
        const floor = percentile(finite, 0.8);   // never reject more than ~20 % of points in one round
        const mu = Math.max(schedule[r], Number.isFinite(floor) ? floor : 0);
        lastMu = mu;
        const keepObs = new Uint8Array(input.observations.length);
        for (let i = 0; i < input.observations.length; i++) { const e = errs[input.observations[i].point_idx]; keepObs[i] = (Number.isFinite(e) && e <= mu) ? 1 : 0; }
        const filtered = filterSbaInput(input, keepObs);
        P(r / schedule.length, `round ${r + 1}/${schedule.length}: ${filtered.points.length}/${input.points.length} points ≤ ${Number.isFinite(mu) ? mu.toFixed(1) : '∞'} px`);
        if (filtered.points.length < 10) { log(`SBA round ${r + 1}: only ${filtered.points.length} points left; stopping`, 'warn'); break; }
        const result = await cw.request('sba', { input: filtered, config }, { onProgress: (f, msg) => P((r + 0.05 + 0.75 * f) / schedule.length, `round ${r + 1}/${schedule.length}: ${msg || ''}`) });
        lastResult = result; lastInput = filtered;
        const applied = applySbaResults(result, filtered, intr, extr);
        intr = applied.intrinsics; extr = applied.extrinsics;
        const fitRms = Math.sqrt(result.final_cost / Math.max(1, result.num_observations_used));
        P((r + 0.85) / schedule.length, `round ${r + 1}/${schedule.length}: re-triangulating`);
        reproj = await requestReprojection(intr, extr);
        input = prep(reproj, intr, extr);
        const fin = input.meta.pointErr.filter(Number.isFinite);
        roundLog.push({ round: r + 1, label, threshold: mu, pointsFit: filtered.points.length, pointsTotal: errs.length, obsFit: filtered.observations.length, iterations: result.iterations, status: result.status, initialCost: result.initial_cost, finalCost: result.final_cost, fitRms, medianAll: percentile(fin, 0.5), p95All: percentile(fin, 0.95), medianObs: reproj.summary.overall.median, ms: result.ms });
        log(`SBA ${label}, round ${r + 1}/${schedule.length} (threshold ${Number.isFinite(mu) ? mu.toFixed(1) : 'none'} px${mu > schedule[r] ? ', raised so ≤20 % of points are rejected' : ''}): fit on ${filtered.points.length}/${errs.length} points / ${filtered.observations.length} obs, ` +
            `${result.iterations} iters, cost ${result.initial_cost.toFixed(0)} → ${result.final_cost.toFixed(0)} (${result.status}, fit RMS ≈ ${fitRms.toFixed(2)} px) in ${fmtMs(result.ms)}; ` +
            `re-triangulated all observations: median ${reproj.summary.overall.median.toFixed(2)} px, p95 ${reproj.summary.overall.p95.toFixed(2)} px`, 'info');
    }
    if (!lastResult) throw new Error('bundle adjustment produced no result');
    return { label, config, intr, extr, reproj, input, lastResult, lastInput, lastMu, roundLog };
}

export async function revertSba() {
    if (!preSba) return;
    state.intrinsics = preSba.intrinsics;
    state.extrinsics = preSba.extrinsics;
    state.sbaResult = null;
    preSba = null;
    $('sbaResult').style.display = 'none';
    $('revertSbaBtn').style.display = 'none';
    log('Reverted to the initial (pre-SBA) calibration');
    progress.show('recomputing reprojection');
    try {
        await computeReprojection((f, msg) => progress.set(f, msg));
        progress.hide();
        renderPoseTables();
        renderStatsTable();
        emit('extrinsics-changed', {});
    } catch (e) { progress.fail(e.message); }
}

// ---- render -------------------------------------------------------------------

function renderPoseTables() {
    $('extrinsicsResults').style.display = '';
    const names = state.views.map(v => v.name);
    const meta = state.extrinsicsMeta;
    // covisibility matrix
    if (meta) {
        const n = names.length;
        const grid = el('div', { class: 'covis-grid', style: { gridTemplateColumns: `auto repeat(${n}, 1fr)` } });
        grid.appendChild(el('div', { class: 'covis-cell head' }));
        for (let j = 0; j < n; j++) grid.appendChild(el('div', { class: 'covis-cell head', text: names[j], style: { color: cameraColor(j) } }));
        for (let i = 0; i < n; i++) {
            grid.appendChild(el('div', { class: 'covis-cell head', text: names[i], style: { color: cameraColor(i) } }));
            for (let j = 0; j < n; j++) {
                if (i === j) { grid.appendChild(el('div', { class: 'covis-cell diag' })); continue; }
                const c = meta.pairCounts[i][j];
                const isEdge = meta.chain.parent[j] === i || meta.chain.parent[i] === j;
                grid.appendChild(el('div', { class: `covis-cell${c === 0 ? ' zero' : ''}${isEdge ? ' edge' : ''}`, text: String(c), title: isEdge ? 'used in pose chain' : '' }));
            }
        }
        $('covisTable').replaceChildren(grid);
        const chainTxt = meta.chain.order.map(v => meta.chain.parent[v] === null ? `${names[v]} (ref)` : `${names[meta.chain.parent[v]]}→${names[v]}`).join(', ');
        $('chainInfo').textContent = `Pose chain: ${chainTxt}${meta.chain.unreachable.length ? ` · unreachable: ${meta.chain.unreachable.map(u => names[u]).join(', ')}` : ''}. Outlined cells are chain edges.`;
    }
    // poses
    const tbody = $('extrinsicsTableBody');
    tbody.replaceChildren(...state.views.map((v, i) => {
        const e = state.extrinsics[i];
        if (!e || e.error) return el('tr', {}, [el('td', { text: v.name, style: { color: cameraColor(i) } }), el('td', { text: e ? e.error : 'n/a', colspan: '8', style: { color: 'var(--bad)' } })]);
        const via = e.chain ? e.chain.map(k => names[k]).join('→') : '';
        const cells = [v.name, ...e.rvec.map(x => x.toFixed(5)), ...e.tvec.map(x => x.toFixed(2)), via, e.pairStd !== undefined ? e.pairStd.toFixed(2) : ''];
        const tr = el('tr', {}, cells.map(c => el('td', { text: c })));
        tr.children[0].style.color = cameraColor(i); tr.children[0].style.fontWeight = '600';
        const C = cameraCenter(e.R, e.tvec);
        tr.title = `camera center in world: [${C.map(x => x.toFixed(1)).join(', ')}] mm${e.refinedBySba ? ' · refined by SBA' : ''}`;
        return tr;
    }));
}

/** Per-camera reprojection statistics: initial extrinsics vs after bundle adjustment. */
function renderStatsTable() {
    const tbody = $('reprojStatsBody');
    if (!tbody) return;
    const cur = state.reproj ? state.reproj.summary : null;
    const init = state.reprojInitialSummary || cur;
    const refined = state.sbaResult ? cur : null;
    const fmt = (v) => Number.isFinite(v) ? v.toFixed(3) : '–';
    const rows = state.views.map((v, i) => {
        const a = init ? init.perView[i] : null, b = refined ? refined.perView[i] : null;
        const tr = el('tr', {}, [
            el('td', { text: v.name, style: { color: cameraColor(i), fontWeight: '600' } }),
            el('td', { text: a ? String(a.n) : '–' }),
            el('td', { text: a ? fmt(a.mean) : '–' }), el('td', { text: a ? fmt(a.median) : '–' }), el('td', { text: a ? fmt(a.p95) : '–' }),
            el('td', { text: b ? fmt(b.mean) : '–' }), el('td', { text: b ? fmt(b.median) : '–' }), el('td', { text: b ? fmt(b.p95) : '–' }),
        ]);
        if (a) tr.children[3].style.color = errorColor(a.median);
        if (b) tr.children[6].style.color = errorColor(b.median);
        return tr;
    });
    if (init) {
        const a = init.overall, b = refined ? refined.overall : null;
        const tr = el('tr', { class: 'total' }, [
            el('td', { text: 'all', style: { fontWeight: '600' } }), el('td', { text: String(a.n) }),
            el('td', { text: fmt(a.mean) }), el('td', { text: fmt(a.median) }), el('td', { text: fmt(a.p95) }),
            el('td', { text: b ? fmt(b.mean) : '–' }), el('td', { text: b ? fmt(b.median) : '–' }), el('td', { text: b ? fmt(b.p95) : '–' }),
        ]);
        rows.push(tr);
    }
    tbody.replaceChildren(...rows);
}

function renderReprojection() {
    const rp = state.reproj;
    if (!rp) return;
    const s = rp.summary;
    $('reprojSummary').textContent = `${s.frames} frames · ${s.points} points · mean ${s.overall.mean.toFixed(3)} px · median ${s.overall.median.toFixed(3)} · p95 ${s.overall.p95.toFixed(2)}`;
    const frames = rp.frames.map(r => r.frame);
    strip.setData({ frames, colorFn: (f) => errorColormap(state.reprojByFrame.get(f)?.meanErr), excluded: state.exclusions.extrinsics });
    plot.setData(state.views.map((v, i) => ({
        label: v.name, color: cameraColor(i),
        points: rp.frames.filter(r => r.views[i] && isFinite(r.views[i].mean)).map(r => ({ y: r.views[i].mean, frame: r.frame, excluded: state.exclusions.extrinsics.has(r.frame), meta: { count: r.views[i].count, max: r.views[i].max } })),
    })), { thresholds: [1], note: `mean ${s.overall.mean.toFixed(2)} · median ${s.overall.median.toFixed(2)} · n=${s.observations}` });
    worstOrder = frames.slice().sort((a, b) => state.reprojByFrame.get(b).meanErr - state.reprojByFrame.get(a).meanErr);
    gallery.setItems(rp.frames.map(r => ({
        frame: r.frame, value: r.meanErr, excluded: state.exclusions.extrinsics.has(r.frame),
        sub: state.views.map((v, i) => r.views[i] ? { name: v.name, m: r.views[i].mean } : null).filter(x => x && Number.isFinite(x.m)).sort((a, b) => b.m - a.m).slice(0, 3).map(x => `${x.name}:${x.m.toFixed(2)}`).join(' '),
    })));
    gallery.setCurrent(state.currentFrame);
    strip.setCurrent(state.currentFrame);
    refreshExclusionInfo();
}

function refreshExclusionViews() {
    strip.setExcluded(state.exclusions.extrinsics);
    gallery.updateExclusions(state.exclusions.extrinsics);
    if (state.reproj) plot.setData(plot.groups.map(g => ({ ...g, points: g.points.map(p => ({ ...p, excluded: state.exclusions.extrinsics.has(p.frame) })) })), { thresholds: [1], note: plot.note });
    refreshExclusionInfo();
    controllers.video.redraw();
}

function refreshExclusionInfo() {
    const n = state.exclusions.extrinsics.size;
    $('extrinsicsExclusionInfo').textContent = n ? `${n} frame(s) excluded — recompute extrinsics / rerun SBA to apply` : '';
    $('clearExtrinsicsExclusionsBtn').style.display = n ? '' : 'none';
}

export function toggleExtrinsicsExclusion(frame) {
    if (!state.detections || !state.detections.has(frame)) { log(`Frame ${frame} is not a sampled frame`, 'warn'); return; }
    const set = state.exclusions.extrinsics;
    if (set.has(frame)) { set.delete(frame); log(`Frame ${frame} re-included for extrinsics`); }
    else { set.add(frame); log(`Frame ${frame} excluded from extrinsics/SBA (recompute to apply)`, 'warn'); }
    emit('exclusions-changed', { kind: 'extrinsics' });
}

export function stepWorst(dir) {
    if (!worstOrder.length) return;
    const i = worstOrder.indexOf(state.currentFrame);
    const next = i < 0 ? 0 : (i + dir + worstOrder.length) % worstOrder.length;
    controllers.video.seekToFrame(worstOrder[next]);
}
