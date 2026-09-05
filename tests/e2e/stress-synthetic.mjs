/**
 * tests/e2e/stress-synthetic.mjs — the "~1000 frames" regression test.
 *
 * Opens a long synthetic session (scripts/make_synthetic_session.py) through
 * the real folder-loader fallback (<input webkitdirectory>), detects on EVERY
 * frame, runs intrinsics / extrinsics / bundle adjustment, compares the result
 * with the generator's ground truth, and reports wall-clock timings. Fails on
 * page errors, on the UI going unresponsive (a heartbeat rAF must keep firing
 * during detection), and on results far from ground truth.
 *
 *   SESSION=/path/to/synthetic_session node tests/e2e/stress-synthetic.mjs
 *   Optional: BASE, TARGET (default: every frame), SCREENSHOT, VERBOSE
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCalibrationToml } from '../../import-export/toml.js';
import { rodriguesToMatrix, rotationAngle, norm3, sub3 } from '../../calib/geometry.js';

const BASE = process.env.BASE || 'http://localhost:8080';
const SESSION = process.env.SESSION;
if (!SESSION) { console.error('SESSION=/path/to/synthetic_session is required'); process.exit(2); }
const gt = parseCalibrationToml(readFileSync(path.join(SESSION, 'calibration_gt.toml'), 'utf8'));

const browser = await chromium.launch({ headless: !process.env.HEADFUL });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`); });
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 180000 });
    step(await page.textContent('#workerStatus'));

    // Real fallback path: directory upload into the hidden <input webkitdirectory>.
    await page.setInputFiles('#folderInput', SESSION);
    await page.waitForFunction(() => window.__calibrat3.state.views.length >= 2 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 180000 });
    const info = await page.evaluate(() => ({ layout: window.__calibrat3.state.sessionLayout, views: window.__calibrat3.state.views.map(v => v.name), frames: window.__calibrat3.state.totalFrames, board: window.__calibrat3.state.board }));
    step(`session: ${JSON.stringify(info)}`);
    if (info.layout !== 'nested') throw new Error(`expected nested layout, got ${info.layout}`);

    // Heartbeat: count rAF ticks during detection to prove the main thread stays responsive.
    await page.evaluate(() => { window.__hb = { ticks: 0, maxGap: 0, last: performance.now() }; const f = () => { const n = performance.now(); window.__hb.maxGap = Math.max(window.__hb.maxGap, n - window.__hb.last); window.__hb.last = n; window.__hb.ticks++; requestAnimationFrame(f); }; requestAnimationFrame(f); });

    if (process.env.TARGET) { await page.fill('#targetSamples', process.env.TARGET); await page.dispatchEvent('#targetSamples', 'input'); }
    else await page.check('#allFramesCheck');
    const tDet = Date.now();
    await page.click('#runDetectionBtn');
    await page.waitForFunction(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections && window.__calibrat3.state.detections.size > 0, null, { timeout: 1800000 });
    const detMs = Date.now() - tDet;
    const summary = await page.evaluate(() => window.__calibrat3.state.detections.summary(6));
    const hb = await page.evaluate(() => window.__hb);
    const decoded = await page.evaluate(() => window.__calibrat3.state.views.map(v => v.decoder.stats.decoded));
    step(`detection: ${summary.frames} frames x ${info.views.length} views in ${(detMs / 1000).toFixed(1)} s = ${(summary.frames * info.views.length / (detMs / 1000)).toFixed(1)} det/s; ` +
        `good in all views ${summary.framesAllViewsGood}; per view ${JSON.stringify(summary.perView)}; decoded frames per view ${JSON.stringify(decoded)}`);
    step(`main-thread heartbeat during detection: ${hb.ticks} rAF ticks, max gap ${hb.maxGap.toFixed(0)} ms`);
    if (hb.maxGap > 2000) errors.push(`UI froze for ${hb.maxGap.toFixed(0)} ms during detection`);
    if (summary.framesAllViewsGood < 50) throw new Error('too few usable frames');
    const thumbs = await page.evaluate(() => window.__calibrat3.state.thumbnails.size);
    step(`thumbnails captured: ${thumbs}`);

    const tIntr = Date.now();
    await page.click('#computeIntrinsicsBtn');
    await page.waitForFunction((n) => window.__calibrat3.state.intrinsics.filter(Boolean).length === n, info.views.length, { timeout: 1800000 });
    const intr = await page.evaluate(() => window.__calibrat3.state.intrinsics.map(r => ({ rms: r.rmsError, used: r.framesUsed, valid: r.framesValid, K: r.K, dist: r.dist, ms: r.timings.totalMs })));
    step(`intrinsics in ${((Date.now() - tIntr) / 1000).toFixed(1)} s: ${intr.map((r, i) => `${info.views[i]} rms=${r.rms.toFixed(3)} used=${r.used}/${r.valid} (${(r.ms / 1000).toFixed(1)} s)`).join('; ')}`);
    intr.forEach((r, i) => {
        const g = gt.cameras[i];
        const dfx = Math.abs(r.K[0][0] - g.K[0][0]) / g.K[0][0], dcx = Math.abs(r.K[0][2] - g.K[0][2]);
        step(`  ${info.views[i]}: fx ${r.K[0][0].toFixed(1)} vs gt ${g.K[0][0].toFixed(1)} (${(dfx * 100).toFixed(2)}%), cx ${r.K[0][2].toFixed(1)} vs ${g.K[0][2].toFixed(1)} (Δ${dcx.toFixed(1)} px), k1 ${r.dist[0].toFixed(4)} vs ${g.dist[0].toFixed(4)}`);
        if (dfx > 0.02) errors.push(`${info.views[i]}: focal length off by ${(dfx * 100).toFixed(1)}%`);
        if (dcx > 15) errors.push(`${info.views[i]}: principal point off by ${dcx.toFixed(1)} px`);
    });

    const tExt = Date.now();
    await page.click('#computeExtrinsicsBtn');
    await page.waitForFunction(() => window.__calibrat3.state.reproj !== null, null, { timeout: 1800000 });
    let ext = await page.evaluate(() => ({ e: window.__calibrat3.state.extrinsics.map(e => e.error ? { error: e.error } : { rvec: e.rvec, tvec: e.tvec }), s: window.__calibrat3.state.reproj.summary }));
    step(`extrinsics + reprojection in ${((Date.now() - tExt) / 1000).toFixed(1)} s: ${ext.s.frames} frames, ${ext.s.points} points, mean ${ext.s.overall.mean.toFixed(3)} px, median ${ext.s.overall.median.toFixed(3)}, p95 ${ext.s.overall.p95.toFixed(2)}`);
    const compare = (label) => ext.e.forEach((e, i) => {
        const g = gt.cameras[i];
        if (e.error) { errors.push(`${info.views[i]}: ${e.error}`); return; }
        const dt = norm3(sub3(e.tvec, g.tvec)), dr = rotationAngle(rodriguesToMatrix(e.rvec), rodriguesToMatrix(g.rvec)) * 180 / Math.PI;
        step(`  ${label} ${info.views[i]}: |Δt| = ${dt.toFixed(2)} mm, Δrot = ${dr.toFixed(3)}°  (t = [${e.tvec.map(v => v.toFixed(1))}] vs gt [${g.tvec.map(v => v.toFixed(1))}])`);
        if (dt > 25) errors.push(`${label} ${info.views[i]}: translation off by ${dt.toFixed(1)} mm`);
        if (dr > 1.0) errors.push(`${label} ${info.views[i]}: rotation off by ${dr.toFixed(2)}°`);
    });
    compare('initial');

    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 60000 });
    const tSba = Date.now();
    await page.click('#runSbaBtn');
    await page.waitForFunction(() => window.__calibrat3.state.sbaResult !== null, null, { timeout: 1800000 });
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 1800000 });
    const sba = await page.evaluate(() => { const r = window.__calibrat3.state.sbaResult; return { iters: r.result.iterations, initial: r.result.initial_cost, final: r.result.final_cost, filtered: r.result.num_observations_filtered, points: r.meta.numPoints, obs: r.meta.numObservations, ms: r.result.ms }; });
    ext = await page.evaluate(() => ({ e: window.__calibrat3.state.extrinsics.map(e => ({ rvec: e.rvec, tvec: e.tvec })), s: window.__calibrat3.state.reproj.summary }));
    step(`SBA in ${((Date.now() - tSba) / 1000).toFixed(1)} s (solver ${(sba.ms / 1000).toFixed(1)} s): ${sba.points} points / ${sba.obs} obs, ${sba.iters} iters, cost ${sba.initial.toFixed(0)} → ${sba.final.toFixed(0)}, ${sba.filtered} filtered; reproj mean ${ext.s.overall.mean.toFixed(3)} px, median ${ext.s.overall.median.toFixed(3)}`);
    compare('refined');

    const toml = await page.textContent('#tomlPreview');
    if (!toml.includes(`[cam_${info.views.length - 1}]`)) throw new Error('TOML preview incomplete');
    const dom = await page.evaluate(() => ({ rows: document.querySelectorAll('.vtable-row').length, cards: document.querySelectorAll('.gallery-card').length, logEntries: document.querySelectorAll('#logBody .log-entry').length }));
    step(`DOM footprint: ${dom.rows} table rows rendered, ${dom.cards} gallery cards, ${dom.logEntries} log entries`);
    if (dom.rows > 80) errors.push(`virtual table rendered ${dom.rows} rows`);
    const mem = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
    if (mem !== null) step(`JS heap: ${mem} MB`);
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
} catch (e) {
    errors.push(`test: ${e.message}`);
    const logTail = await page.evaluate(() => Array.from(document.querySelectorAll('#logBody .log-entry')).slice(-15).map(x => x.textContent).join('\n')).catch(() => '');
    console.log('--- log tail ---\n' + logTail);
} finally {
    await browser.close();
}
if (errors.length) { console.log('\nFAILED:\n' + errors.join('\n')); process.exit(1); }
console.log('\nPASS');
