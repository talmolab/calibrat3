/**
 * ui/stage-intrinsics.js — Stage 3: per-camera intrinsics in the calibration
 * worker, with a progress bar per camera, per-frame error strip, aggregated
 * swarm plot, worst-frames gallery and frame exclusion (video-frame keyed).
 */

import { state, controllers, cameraColor } from './app-state.js';
import { log, fmtMs } from './log-panel.js';
import { $, el, intInput, setStageStatus, expandStage, setEnabled, showError, Progress, errorColor } from './stages.js';
import { FrameStrip, errorColormap } from './frame-strip.js';
import { SwarmPlot } from './plots.js';
import { FrameGallery } from './gallery.js';
import { emit, on } from './events.js';

let strip = null, plot = null, gallery = null, galleryBest = null, progress = null;
let worstOrder = [];   // frames sorted by max error desc (for { } navigation)

export function setupIntrinsicsStage() {
    progress = new Progress('intrinsicsProgress');
    $('computeIntrinsicsBtn').addEventListener('click', () => computeIntrinsics());
    $('clearIntrinsicsExclusionsBtn').addEventListener('click', () => {
        state.exclusions.intrinsics.clear();
        emit('exclusions-changed', { kind: 'intrinsics' });
    });
    strip = new FrameStrip($('intrinsicsStrip'), {
        height: 40,
        tooltipEl: $('intrinsicsStripTooltip'),
        tooltip: (f) => `frame ${f}\n${perCameraText(f)}${state.exclusions.intrinsics.has(f) ? '\nEXCLUDED' : ''}`,
        onClick: (f) => { setActive(); controllers.video.seekToFrame(f); },
    });
    plot = new SwarmPlot($('intrinsicsPlot'), $('intrinsicsPlotTooltip'), {
        yLabel: 'per-frame RMS (px)',
        height: 250,
        formatTooltip: (p) => `${p.group}  frame ${p.frame}\n${p.y.toFixed(3)} px${p.unused ? '  (not used in fit)' : ''}${p.excluded ? '  EXCLUDED' : ''}\nclick to seek`,
        onClick: (p) => { setActive(); controllers.video.seekToFrame(p.frame); },
    });
    const galleryOpts = { getThumb: (f) => state.thumbnails.get(f) || null, onSeek: (f) => { setActive(); controllers.video.seekToFrame(f); }, onToggleExclude: (f) => toggleIntrinsicsExclusion(f), limit: 30 };
    gallery = new FrameGallery($('intrinsicsGallery'), galleryOpts);
    galleryBest = new FrameGallery($('intrinsicsGalleryBest'), galleryOpts);
    $('stage3').addEventListener('mousedown', () => { if (state.intrinsics.some(Boolean)) setActive(); });

    on('frame', ({ frame }) => { strip.setCurrent(frame); gallery.setCurrent(frame); galleryBest.setCurrent(frame); });
    on('exclusions-changed', ({ kind }) => { if (kind === 'intrinsics') refreshExclusionViews(); });
    on('detections-changed', () => { $('intrinsicsResults').style.display = 'none'; setStageStatus('stage3', 'Ready'); });
    on('session-loaded', () => { $('intrinsicsResults').style.display = 'none'; setStageStatus('stage3', 'Waiting for detections'); setEnabled('computeIntrinsicsBtn', false); });
}

function setActive() { if (state.activeExclusion !== 'intrinsics') { state.activeExclusion = 'intrinsics'; emit('active-exclusion', { kind: 'intrinsics' }); } }

/** Per-camera intrinsic error entries for a frame: [{name, err, used}] (NaN err if none). */
function perCameraErrors(f) {
    return state.views.map((v, i) => {
        const intr = state.intrinsics[i];
        if (!intr || !intr.perFrame) return { name: v.name, err: NaN, used: false };
        const idx = indexOf(intr.perFrame.frames, f);
        if (idx < 0) return { name: v.name, err: NaN, used: false };
        return { name: v.name, err: intr.perFrame.errors[idx], used: !!intr.perFrame.used[idx] };
    });
}

/** One line per camera (tooltips). ° marks frames evaluated but not used in the fit. */
function perCameraText(f) {
    return perCameraErrors(f).map(e => `${e.name.padEnd(10)} ${Number.isFinite(e.err) ? e.err.toFixed(2) + (e.used ? '' : '°') : '–'}`).join('\n');
}

/** Compact caption for gallery cards: the worst three cameras. */
function perCameraShort(f) {
    const es = perCameraErrors(f).filter(e => Number.isFinite(e.err)).sort((a, b) => b.err - a.err).slice(0, 3);
    return es.map(e => `${e.name}:${e.err.toFixed(2)}`).join(' ');
}

function indexOf(frames, f) {
    let lo = 0, hi = frames.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (frames[m] === f) return m; if (frames[m] < f) lo = m + 1; else hi = m - 1; }
    return -1;
}

/** Map the distortion-model selector to calibrateCamera flags. */
export function distortionFlags(model) {
    switch (model) {
        case 'k1': return { fixK2: true, fixK3: true, zeroTangent: true };
        case 'k1k2': return { fixK3: true, zeroTangent: true };
        case 'k1k2k3': return { zeroTangent: true };
        default: return {};
    }
}

// ---- compute -------------------------------------------------------------------

export async function computeIntrinsics() {
    const store = state.detections;
    if (!store || store.size === 0) { showError('Run batch detection first.'); return; }
    const cw = controllers.calib;
    const minCorners = intInput('minCorners', 6);
    const maxFrames = intInput('maxCalibFrames', 50);
    const flags = distortionFlags($('distModel').value);
    const nViews = state.views.length;
    setEnabled('computeIntrinsicsBtn', false);
    setEnabled('computeExtrinsicsBtn', false);
    setStageStatus('stage3', 'Computing…', 'active');
    progress.show('starting');
    const t0 = performance.now();
    log(`Intrinsics: minCorners=${minCorners}, maxFrames/camera=${maxFrames || 'all'}, excluded=${state.exclusions.intrinsics.size}, distortion model=${$('distModel').value}`);
    const results = new Array(nViews).fill(null);
    let ok = 0;
    try {
        // One request per camera, dispatched across the calibration worker pool in parallel.
        const fractions = new Array(nViews).fill(0);
        const msgs = new Array(nViews).fill('queued');
        const report = () => progress.set(fractions.reduce((a, b) => a + b, 0) / nViews,
            state.views.map((v, i) => `${v.name} ${Math.round(fractions[i] * 100)}%`).join(' · '));
        await Promise.all(state.views.map(async (view, v) => {
            const samples = [];
            for (const f of store.frames()) {
                const d = store.get(f, v);
                if (d && d.ids.length >= 4) samples.push({ frame: f, ids: d.ids, corners: d.corners });
            }
            const imageSize = { width: view.info.width, height: view.info.height };
            msgs[v] = `${samples.length} frames`;
            report();
            let res;
            try {
                res = await cw.request('intrinsics', {
                    samples, imageSize, board: state.board,
                    opts: { minCorners, maxFrames, exclusions: Array.from(state.exclusions.intrinsics), flags },
                }, { onProgress: (f, msg) => { fractions[v] = f; msgs[v] = msg || ''; report(); } });
            } catch (e) {
                log(`${view.name}: intrinsics failed: ${e.message}`, 'error');
                fractions[v] = 1; report();
                return;
            }
            fractions[v] = 1; report();
            if (res.error) { log(`${view.name}: ${res.error}`, 'error'); return; }
            res.distModel = $('distModel').value;
            results[v] = res;
            ok++;
            const med = medianOf(res.perFrame.errors);
            log(`${view.name}: RMS ${res.rmsError.toFixed(3)} px over ${res.framesUsed}/${res.framesValid} frames (coverage ${(res.coverage * 100).toFixed(0)}%), ` +
                `median per-frame ${med.toFixed(3)} px | fx=${res.fx.toFixed(1)} fy=${res.fy.toFixed(1)} cx=${res.cx.toFixed(1)} cy=${res.cy.toFixed(1)} ` +
                `k1=${res.k1.toFixed(4)} k2=${res.k2.toFixed(4)} p1=${res.p1.toFixed(5)} p2=${res.p2.toFixed(5)} k3=${res.k3.toFixed(4)} | ` +
                `calibrateCamera ${fmtMs(res.timings.calibrateMs)}, eval ${fmtMs(res.timings.reprojectMs)}`, res.rmsError < 1 ? 'success' : 'warn');
        }));
    } catch (e) {
        progress.fail(e.message);
        setStageStatus('stage3', 'Failed', 'error');
        showError(`Intrinsics failed: ${e.message}`);
        log(`Intrinsics failed: ${e.stack || e.message}`, 'error');
        setEnabled('computeIntrinsicsBtn', true);
        return;
    }
    state.intrinsics = results;
    state.sbaResult = null;
    state.extrinsics = [];
    state.reproj = null; state.reprojByFrame = new Map();
    progress.hide();
    setEnabled('computeIntrinsicsBtn', true);
    log(`Intrinsics done for ${ok}/${nViews} cameras in ${fmtMs(performance.now() - t0)}`, ok === nViews ? 'success' : 'warn');
    setStageStatus('stage3', ok === nViews ? `${ok} cameras · RMS ${results.map(r => r.rmsError.toFixed(2)).join(' / ')} px` : `${ok}/${nViews} cameras`, ok === nViews ? 'complete' : 'warn');
    renderResults();
    setActive();
    if (ok >= 2) {
        setStageStatus('stage4', 'Ready');
        setEnabled('computeExtrinsicsBtn', true);
        expandStage('stage4');
    }
    emit('intrinsics-changed', {});
    controllers.video.redraw();
}

function medianOf(arr) {
    const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : NaN;
}

// ---- render -------------------------------------------------------------------

export function renderResults() {
    const anyIntr = state.intrinsics.some(Boolean);
    $('intrinsicsResults').style.display = anyIntr ? '' : 'none';
    if (!anyIntr) return;
    const tbody = $('intrinsicsTableBody');
    tbody.replaceChildren(...state.views.map((v, i) => {
        const r = state.intrinsics[i];
        if (!r) return el('tr', {}, [el('td', { text: v.name, style: { color: cameraColor(i) } }), el('td', { text: 'failed', colspan: '13', style: { color: 'var(--bad)' } })]);
        const med = medianOf(r.perFrame.errors);
        const cells = [v.name, r.fx.toFixed(2), r.fy.toFixed(2), r.cx.toFixed(2), r.cy.toFixed(2), r.k1.toFixed(5), r.k2.toFixed(5), r.p1.toFixed(6), r.p2.toFixed(6), r.k3.toFixed(5),
            `${r.framesUsed}/${r.framesValid}`, `${(r.coverage * 100).toFixed(0)}%`, r.rmsError.toFixed(4), med.toFixed(4)];
        const tr = el('tr', {}, cells.map((c, j) => el('td', { text: c })));
        tr.children[0].style.color = cameraColor(i);
        tr.children[0].style.fontWeight = '600';
        if (r.refinedBySba) tr.children[0].title = 'refined by bundle adjustment';
        tr.children[12].style.color = errorColor(r.rmsError);
        tr.children[13].style.color = errorColor(med);
        return tr;
    }));

    // per-frame aggregate: max error over cameras
    const frameMax = new Map();
    const used = new Set();
    for (let i = 0; i < state.views.length; i++) {
        const r = state.intrinsics[i];
        if (!r) continue;
        const pf = r.perFrame;
        for (let k = 0; k < pf.frames.length; k++) {
            const f = pf.frames[k], e = pf.errors[k];
            if (!Number.isFinite(e)) continue;
            frameMax.set(f, Math.max(frameMax.get(f) ?? 0, e));
            if (pf.used[k]) used.add(f);
        }
    }
    const frames = Array.from(frameMax.keys()).sort((a, b) => a - b);
    strip.setData({ frames, colorFn: (f) => errorColormap(frameMax.get(f)), excluded: state.exclusions.intrinsics, marked: used });

    plot.setData(state.views.map((v, i) => {
        const r = state.intrinsics[i];
        const pts = [];
        if (r) for (let k = 0; k < r.perFrame.frames.length; k++) {
            pts.push({ y: r.perFrame.errors[k], frame: r.perFrame.frames[k], excluded: state.exclusions.intrinsics.has(r.perFrame.frames[k]), unused: !r.perFrame.used[k] });
        }
        return { label: v.name, color: cameraColor(i), points: pts };
    }), { thresholds: [1], note: 'white bar = median · hollow = evaluated only' });

    worstOrder = frames.slice().sort((a, b) => frameMax.get(b) - frameMax.get(a));
    const items = frames.map(f => ({ frame: f, value: frameMax.get(f), excluded: state.exclusions.intrinsics.has(f), used: used.has(f), sub: perCameraShort(f) }));
    gallery.setItems(items, { sort: 'desc' });
    galleryBest.setItems(items.filter(i => !i.excluded), { sort: 'asc' });
    gallery.setCurrent(state.currentFrame);
    galleryBest.setCurrent(state.currentFrame);
    strip.setCurrent(state.currentFrame);
    refreshExclusionInfo();
}

function refreshExclusionViews() {
    strip.setExcluded(state.exclusions.intrinsics);
    gallery.updateExclusions(state.exclusions.intrinsics);
    galleryBest.updateExclusions(state.exclusions.intrinsics);
    if (state.intrinsics.some(Boolean)) {
        plot.setData(plot.groups.map(g => ({ ...g, points: g.points.map(p => ({ ...p, excluded: state.exclusions.intrinsics.has(p.frame) })) })), { thresholds: [1], note: plot.note });
    }
    refreshExclusionInfo();
    controllers.video.redraw();
}

function refreshExclusionInfo() {
    const n = state.exclusions.intrinsics.size;
    $('intrinsicsExclusionInfo').textContent = n ? `${n} frame(s) excluded — recompute to apply` : '';
    $('clearIntrinsicsExclusionsBtn').style.display = n ? '' : 'none';
}

/** Toggle a frame's intrinsics exclusion (any camera). */
export function toggleIntrinsicsExclusion(frame) {
    if (!state.detections || !state.detections.has(frame)) { log(`Frame ${frame} is not a sampled frame`, 'warn'); return; }
    const set = state.exclusions.intrinsics;
    if (set.has(frame)) { set.delete(frame); log(`Frame ${frame} re-included for intrinsics`); }
    else { set.add(frame); log(`Frame ${frame} excluded from intrinsics (recompute to apply)`, 'warn'); }
    emit('exclusions-changed', { kind: 'intrinsics' });
}

/** Step through frames ordered by worst intrinsic error. */
export function stepWorst(dir) {
    if (!worstOrder.length) return;
    const i = worstOrder.indexOf(state.currentFrame);
    const next = i < 0 ? 0 : (i + dir + worstOrder.length) % worstOrder.length;
    controllers.video.seekToFrame(worstOrder[next]);
}
