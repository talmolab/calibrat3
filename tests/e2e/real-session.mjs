/**
 * tests/e2e/real-session.mjs — run the pipeline on a REAL session folder and
 * report (no ground truth): playback smoothness, detection throughput,
 * intrinsics, extrinsics, SBA, and — if the folder contains a reference
 * calibration.toml (e.g. from anipose) — camera-to-camera distances compared
 * with it (invariant to the choice of world frame).
 *
 *   SESSION=/path/to/session [TARGET=600] [REFERENCE=/path/calibration.toml] \
 *   [PLAY_SECONDS=5] [SCREENSHOT=out.png] node tests/e2e/real-session.mjs
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCalibrationToml } from '../../import-export/toml.js';
import { rodriguesToMatrix, cameraCenter, norm3, sub3 } from '../../calib/geometry.js';

const BASE = process.env.BASE || 'http://localhost:8080';
const SESSION = process.env.SESSION;
if (!SESSION) { console.error('SESSION=/path/to/session is required'); process.exit(2); }
const TARGET = process.env.TARGET || '600';
const PLAY_SECONDS = parseFloat(process.env.PLAY_SECONDS || '5');
const REF = process.env.REFERENCE || [path.join(SESSION, 'calibration_reference.toml'), path.join(SESSION, 'calibration.toml')].find(existsSync);
const ref = REF ? parseCalibrationToml(readFileSync(REF, 'utf8')) : null;

const browser = await chromium.launch({ headless: !process.env.HEADFUL });
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`); });
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const waitState = (pred, arg, opts) => Promise.race([
    page.waitForFunction(pred, arg, opts),
    (async () => { while (true) { await page.waitForTimeout(500); const b = await page.evaluate(() => { const e = document.getElementById('errorMsg'); return e && e.style.display === 'block' ? e.textContent : null; }).catch(() => null); if (b) throw new Error(`app error banner: ${b}`); } })(),
]);

try {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await waitState(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 180000 });
    step(await page.textContent('#workerStatus'));
    await page.setInputFiles('#folderInput', SESSION);
    await waitState(() => window.__calibrat3.state.views.length >= 2 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 600000 });
    const info = await page.evaluate(() => ({ layout: window.__calibrat3.state.sessionLayout, views: window.__calibrat3.state.views.map(v => v.name), frames: window.__calibrat3.state.totalFrames, fps: window.__calibrat3.state.fps, board: window.__calibrat3.state.board, gop: window.__calibrat3.state.views[0].info.avgGop, size: [window.__calibrat3.state.views[0].info.width, window.__calibrat3.state.views[0].info.height], cache: window.__calibrat3.state.views[0].decoder.cacheSize, lookahead: window.__calibrat3.state.views[0].decoder.lookahead }));
    step(`session: ${info.views.length} views ${info.size.join('x')} @ ${info.fps} fps, ${info.frames} frames, GOP≈${info.gop.toFixed(0)}, layout ${info.layout}, cache ${info.cache}/view lookahead ${info.lookahead}`);

    // ---- playback smoothness ------------------------------------------------------
    const stepTimes = await page.evaluate(async () => {
        const vc = window.__calibrat3.controllers.video, s = window.__calibrat3.state;
        const times = [];
        await vc.seekToFrame(0);
        for (let i = 1; i <= 40; i++) { const t = performance.now(); await vc.seekToFrame(i); times.push(performance.now() - t); }
        const restarts = s.views.reduce((a, v) => a + v.decoder.stats.restarts, 0);
        const decoded = s.views.reduce((a, v) => a + v.decoder.stats.decoded, 0);
        return { times, restarts, decoded };
    });
    const st = stepTimes.times, mean = st.reduce((a, b) => a + b, 0) / st.length, max = Math.max(...st);
    step(`sequential stepping (40 frames): mean ${mean.toFixed(0)} ms/frame, max ${max.toFixed(0)} ms, decoder restarts ${stepTimes.restarts} (${(stepTimes.decoded / 41 / info.views.length).toFixed(2)} decodes per displayed frame per view)`);
    const farSeek = await page.evaluate(async () => { const vc = window.__calibrat3.controllers.video; const t = performance.now(); await vc.seekToFrame(Math.floor(window.__calibrat3.state.totalFrames * 0.6) + 7); return performance.now() - t; });
    step(`far seek (mid-GOP): ${farSeek.toFixed(0)} ms`);
    const play = await page.evaluate(async (secs) => {
        const vc = window.__calibrat3.controllers.video, s = window.__calibrat3.state;
        await vc.seekToFrame(100);
        let rendered = 0, gaps = [], last = performance.now();
        const off = (await import('./ui/events.js')).on('frame', () => { const n = performance.now(); gaps.push(n - last); last = n; rendered++; });
        vc.startPlayback();
        await new Promise(r => setTimeout(r, secs * 1000));
        vc.stopPlayback();
        off();
        gaps.sort((a, b) => a - b);
        return { rendered, fps: rendered / secs, medGap: gaps[gaps.length >> 1] || 0, p95Gap: gaps[Math.floor(gaps.length * 0.95)] || 0, maxGap: gaps[gaps.length - 1] || 0, target: s.fps };
    }, PLAY_SECONDS);
    step(`playback ${PLAY_SECONDS}s: ${play.rendered} frames rendered = ${play.fps.toFixed(1)} fps (video ${play.target} fps); frame gap median ${play.medGap.toFixed(0)} ms, p95 ${play.p95Gap.toFixed(0)} ms, max ${play.maxGap.toFixed(0)} ms`);

    // ---- detection ------------------------------------------------------------------
    await page.fill('#targetSamples', TARGET); await page.dispatchEvent('#targetSamples', 'input');
    const tDet = Date.now();
    await page.click('#runDetectionBtn');
    await waitState(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections && window.__calibrat3.state.detections.size > 0, null, { timeout: 3600000 });
    const summary = await page.evaluate(() => window.__calibrat3.state.detections.summary(6));
    step(`detection: ${summary.frames} frames x ${info.views.length} views in ${((Date.now() - tDet) / 1000).toFixed(0)} s (${(summary.frames * info.views.length / ((Date.now() - tDet) / 1000)).toFixed(1)} det/s); frames with board per view: ${JSON.stringify(summary.perView)}; all-views-good ${summary.framesAllViewsGood}`);

    // ---- intrinsics -----------------------------------------------------------------
    const tI = Date.now();
    await page.click('#computeIntrinsicsBtn');
    await waitState(() => document.getElementById('computeIntrinsicsBtn').disabled === false && window.__calibrat3.state.intrinsics.length > 0, null, { timeout: 3600000 });
    const intr = await page.evaluate(() => window.__calibrat3.state.intrinsics.map(r => r ? { rms: r.rmsError, used: r.framesUsed, valid: r.framesValid, fx: r.fx, cx: r.cx, cy: r.cy, k1: r.k1 } : null));
    step(`intrinsics in ${((Date.now() - tI) / 1000).toFixed(0)} s: ${intr.map((r, i) => r ? `${info.views[i]} rms=${r.rms.toFixed(2)} fx=${r.fx.toFixed(0)} k1=${r.k1.toFixed(3)} (${r.used}/${r.valid})` : `${info.views[i]} FAILED`).join('; ')}`);
    if (ref) intr.forEach((r, i) => { const g = ref.cameras.find(c => c.name === info.views[i]); if (r && g) step(`  ${info.views[i]}: fx ${r.fx.toFixed(1)} vs reference ${g.K[0][0].toFixed(1)}, k1 ${r.k1.toFixed(3)} vs ${g.dist[0].toFixed(3)}`); });

    // ---- extrinsics -----------------------------------------------------------------
    const tE = Date.now();
    await page.click('#computeExtrinsicsBtn');
    await waitState(() => window.__calibrat3.state.reproj !== null, null, { timeout: 3600000 });
    const ext0 = await page.evaluate(() => ({ e: window.__calibrat3.state.extrinsics.map(e => e && !e.error ? { rvec: e.rvec, tvec: e.tvec, chain: e.chain } : { error: e ? e.error : 'none' }), s: window.__calibrat3.state.reproj.summary, meta: { unreachable: window.__calibrat3.state.extrinsicsMeta.chain.unreachable } }));
    step(`extrinsics + reprojection in ${((Date.now() - tE) / 1000).toFixed(0)} s: ${ext0.s.frames} frames, ${ext0.s.points} points, ${ext0.s.observations} obs; mean ${ext0.s.overall.mean.toFixed(2)} px, median ${ext0.s.overall.median.toFixed(2)}, p95 ${ext0.s.overall.p95.toFixed(1)}; unreachable ${JSON.stringify(ext0.meta.unreachable)}`);
    step(`  per camera median: ${ext0.s.perView.map((p, i) => `${info.views[i]}=${p.median.toFixed(2)}`).join(' ')}`);
    ext0.e.forEach((e, i) => { if (e.chain && e.chain.length > 2) step(`  ${info.views[i]} chained via ${e.chain.map(k => info.views[k]).join('→')}`); if (e.error) step(`  ${info.views[i]}: ${e.error}`); });

    const compareRef = (label, exts) => {
        if (!ref) return;
        const ours = exts.map(e => e.tvec ? cameraCenter(rodriguesToMatrix(e.rvec), e.tvec) : null);
        const theirs = info.views.map(n => { const c = ref.cameras.find(x => x.name === n); return c ? cameraCenter(rodriguesToMatrix(c.rvec), c.tvec) : null; });
        const rel = [];
        for (let i = 0; i < ours.length; i++) for (let j = i + 1; j < ours.length; j++) {
            if (!ours[i] || !ours[j] || !theirs[i] || !theirs[j]) continue;
            const a = norm3(sub3(ours[i], ours[j])), b = norm3(sub3(theirs[i], theirs[j]));
            rel.push({ i, j, a, b, d: Math.abs(a - b) });
        }
        rel.sort((x, y) => y.d - x.d);
        const meds = rel.map(r => r.d).sort((a, b) => a - b);
        step(`  ${label} vs reference calibration: camera-pair distance |Δ| median ${meds[meds.length >> 1].toFixed(1)} mm, p90 ${meds[Math.floor(meds.length * 0.9)].toFixed(1)} mm, max ${meds[meds.length - 1].toFixed(1)} mm over ${rel.length} pairs; worst: ${rel.slice(0, 3).map(r => `${info.views[r.i]}–${info.views[r.j]} ${r.a.toFixed(0)} vs ${r.b.toFixed(0)}`).join(', ')}`);
    };
    compareRef('initial', ext0.e);
    if (ref) {
        // The decisive comparison: the reference calibration evaluated on OUR detections.
        const refIntr = info.views.map(n => { const c = ref.cameras.find(x => x.name === n); return c ? { K: c.K, dist: c.dist } : null; });
        const refExtr = info.views.map(n => { const c = ref.cameras.find(x => x.name === n); return c ? { R: rodriguesToMatrix(c.rvec), tvec: c.tvec } : null; });
        const rr = await page.evaluate(async ({ refIntr, refExtr }) => {
            const s = window.__calibrat3.state;
            const r = await window.__calibrat3.controllers.calib.request('reprojection', { store: s.detections.toPlain(), intrinsics: refIntr, extrinsics: refExtr, opts: { minCorners: 4, minViews: 2 } });
            return r.summary.overall;
        }, { refIntr, refExtr });
        step(`  REFERENCE calibration on the same detections: mean ${rr.mean.toFixed(2)} px, median ${rr.median.toFixed(2)}, p95 ${rr.p95.toFixed(1)}  <- beat this`);
    }

    // ---- SBA ----------------------------------------------------------------------------
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 60000 });
    const tS = Date.now();
    await page.click('#runSbaBtn');
    await waitState(() => window.__calibrat3.state.sbaResult !== null, null, { timeout: 3600000 });
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 3600000 });
    const ext1 = await page.evaluate(() => ({ e: window.__calibrat3.state.extrinsics.map(e => ({ rvec: e.rvec, tvec: e.tvec })), s: window.__calibrat3.state.reproj.summary, sba: (({ result, meta }) => ({ iters: result.iterations, status: result.status, excluded: meta.observationsExcluded, total: meta.observationsTotal }))(window.__calibrat3.state.sbaResult) }));
    step(`SBA in ${((Date.now() - tS) / 1000).toFixed(0)} s: ${JSON.stringify(ext1.sba)}; reprojection mean ${ext1.s.overall.mean.toFixed(2)} px, median ${ext1.s.overall.median.toFixed(2)}, p95 ${ext1.s.overall.p95.toFixed(1)}`);
    step(`  per camera median: ${ext1.s.perView.map((p, i) => `${info.views[i]}=${p.median.toFixed(2)}`).join(' ')}`);
    compareRef('refined', ext1.e);

    const rounds = await page.evaluate(() => window.__calibrat3.state.sbaResult.rounds || []);
    for (const r of rounds) step(`  round ${r.round}: threshold ${r.threshold.toFixed(1)} px, fit ${r.pointsFit}/${r.pointsTotal} pts (${r.obsFit} obs), ${r.iterations} iters ${r.status}, cost ${r.initialCost.toFixed(0)}→${r.finalCost.toFixed(0)} (fit RMS ${r.fitRms.toFixed(2)}), all-points median ${r.medianAll.toFixed(2)} p95 ${r.p95All.toFixed(1)}, ${(r.ms / 1000).toFixed(0)} s`);
    if (process.env.SCREENSHOT) { await page.evaluate(() => document.getElementById('stage4').scrollIntoView()); await page.screenshot({ path: process.env.SCREENSHOT }); }
} catch (e) {
    errors.push(`test: ${e.message}`);
    const logTail = await page.evaluate(() => Array.from(document.querySelectorAll('#logBody .log-entry')).slice(-15).map(x => x.textContent).join('\n')).catch(() => '');
    console.log('--- log tail ---\n' + logTail);
} finally {
    await browser.close();
}
if (errors.length) { console.log('\nFAILED:\n' + errors.join('\n')); process.exit(1); }
console.log('\nDONE');
