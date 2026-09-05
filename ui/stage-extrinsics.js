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
import { prepareSbaInput, applySbaResults, sbaReferenceIndex } from '../calib/sba.js';
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
            const per = state.views.map((v, i) => rec.views[i] ? `${v.name}:${rec.views[i].mean.toFixed(2)}` : `${v.name}:–`).join(' ');
            return `frame ${f}\nmean ${rec.meanErr.toFixed(2)} px · ${rec.n} pts\n${per}${state.exclusions.extrinsics.has(f) ? '\nEXCLUDED' : ''}`;
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
}

function setActive() { if (state.activeExclusion !== 'extrinsics') { state.activeExclusion = 'extrinsics'; emit('active-exclusion', { kind: 'extrinsics' }); } }

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
    setEnabled('computeExtrinsicsBtn', false);
    setEnabled('runSbaBtn', false);
    setStageStatus('stage4', 'Computing…', 'active');
    progress.show('building covisibility graph');
    const t0 = performance.now();
    log(`Extrinsics: reference=${state.views[refIdx].name}, minCovisible=${minCovisible}, maxFrames/pair=${maxFramesPerPair || 'all'}, excluded=${state.exclusions.extrinsics.size}`);
    try {
        const res = await cw.request('extrinsics', {
            store: store.toPlain(), intrinsics: intrinsicsPayload(), board: state.board, refIdx,
            minCovisible, minCorners, excluded: Array.from(state.exclusions.extrinsics), maxFramesPerPair,
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

/** Triangulate + reproject with the current intrinsics/extrinsics; updates strip/plot/gallery. */
async function computeReprojection(onProgress) {
    const cw = controllers.calib;
    const t0 = performance.now();
    const res = await cw.request('reprojection', {
        store: state.detections.toPlain(), intrinsics: intrinsicsPayload(), extrinsics: extrinsicsPayload(),
        opts: { minCorners: 4, minViews: 2 },
    }, { onProgress });
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
    const cw = controllers.calib;
    const refIdx = state.referenceView;
    const input = prepareSbaInput(state.reproj, state.intrinsics, state.extrinsics, {
        excludedFrames: state.exclusions.extrinsics, maxPoints: intInput('sbaMaxPoints', 60000),
    });
    if (input.points.length < 10) { showError('Not enough triangulated points for bundle adjustment.'); return; }
    const config = {
        max_iterations: intInput('sbaMaxIterations', 100),
        robust_loss: $('sbaRobustLoss').value,
        robust_loss_param: numInput('sbaLossParam', 1.0),
        outlier_threshold: numInput('sbaOutlierThreshold', 30),
        optimize_extrinsics: $('sbaOptExtrinsics').checked,
        optimize_intrinsics: $('sbaOptIntrinsics').checked,
        optimize_points: $('sbaOptPoints').checked,
        cost_tolerance: numInput('sbaCostTol', 1e-6),
        parameter_tolerance: numInput('sbaParamTol', 1e-8),
        gradient_tolerance: numInput('sbaGradTol', 1e-10),
        reference_camera: sbaReferenceIndex(input, refIdx),
    };
    setEnabled('runSbaBtn', false);
    setEnabled('computeExtrinsicsBtn', false);
    sbaProgress.show('preparing');
    log(`SBA: ${input.meta.numCameras} cameras, ${input.meta.numPoints} points (${input.meta.numFrames} frames${input.meta.frameStride > 1 ? `, every ${input.meta.frameStride}th` : ''}), ${input.meta.numObservations} observations; ` +
        `${config.max_iterations} iters, ${config.robust_loss}(${config.robust_loss_param}), outlier>${config.outlier_threshold}px, ref=${state.views[refIdx].name}`);
    const t0 = performance.now();
    try {
        if (!preSba) preSba = { intrinsics: state.intrinsics.slice(), extrinsics: state.extrinsics.slice() };
        const result = await cw.request('sba', { input, config }, { onProgress: (f, msg) => sbaProgress.set(0.1 + 0.8 * f, msg) });
        const improvement = (result.initial_cost - result.final_cost) / result.initial_cost * 100;
        const rmsBefore = Math.sqrt(result.initial_cost / Math.max(1, result.num_observations_used));
        const rmsAfter = Math.sqrt(result.final_cost / Math.max(1, result.num_observations_used));
        log(`SBA ${result.converged ? 'converged' : 'stopped'} (${result.status}) after ${result.iterations} iterations in ${fmtMs(result.ms)}: ` +
            `cost ${result.initial_cost.toFixed(1)} → ${result.final_cost.toFixed(1)} (${improvement.toFixed(1)}% lower, RMS ≈ ${rmsBefore.toFixed(3)} → ${rmsAfter.toFixed(3)} px); ` +
            `${result.num_observations_filtered} outliers filtered`, 'success');
        state.sbaResult = { result, config, meta: input.meta };
        const applied = applySbaResults(result, input, state.intrinsics, state.extrinsics);
        state.intrinsics = applied.intrinsics;
        state.extrinsics = applied.extrinsics;
        sbaProgress.set(0.9, 'recomputing reprojection');
        await computeReprojection((f, msg) => sbaProgress.set(0.9 + 0.1 * f, msg));
        sbaProgress.hide();
        renderPoseTables();
        $('sbaResult').style.display = '';
        $('revertSbaBtn').style.display = '';
        $('sbaSummary').textContent = `${result.iterations} iterations · cost ${result.initial_cost.toFixed(1)} → ${result.final_cost.toFixed(1)} (−${improvement.toFixed(1)}%) · ` +
            `${result.num_observations_used} obs used, ${result.num_observations_filtered} filtered · ${result.status}`;
        drawLineChart($('sbaChart'), result.cost_history, { label: 'cost (log)' });
        const s = state.reproj.summary;
        setStageStatus('stage4', `refined · mean ${s.overall.mean.toFixed(2)} px (median ${s.overall.median.toFixed(2)})`, s.overall.median < 1 ? 'complete' : 'warn');
        emit('extrinsics-changed', {});
        emit('intrinsics-changed-values', {});
    } catch (e) {
        sbaProgress.fail(e.message);
        showError(`Bundle adjustment failed: ${e.message}`);
        log(`SBA failed: ${e.stack || e.message}`, 'error');
    } finally {
        setEnabled('runSbaBtn', true);
        setEnabled('computeExtrinsicsBtn', true);
    }
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
        sub: state.views.map((v, i) => r.views[i] ? `${v.name}:${r.views[i].mean.toFixed(2)}` : `${v.name}:–`).join(' '),
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
