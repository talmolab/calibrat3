/**
 * tests/e2e/smoke-pipeline.mjs — drive the real app in headless Chromium:
 * load the sample session, run batch detection, intrinsics, extrinsics and
 * bundle adjustment, then assert on window.__calibrat3.state and fail on any
 * page error / console error.
 *
 * Setup (once):  cd tests/e2e && npm install       (playwright + Chromium)
 * Run:           python3 server.py 8080 &  node tests/e2e/smoke-pipeline.mjs
 * Env:           BASE=http://localhost:8080  TARGET=100  HEADFUL=1  SCREENSHOT=out.png
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const TARGET = parseInt(process.env.TARGET || '100', 10);
const SCREENSHOT = process.env.SCREENSHOT || '';

const browser = await chromium.launch({ headless: !process.env.HEADFUL, args: ['--enable-features=SharedArrayBuffer'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`);
});

const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
// Fail fast when the app shows its error banner instead of waiting for a state that will never come.
const waitState = (pred, arg, opts) => Promise.race([
    page.waitForFunction(pred, arg, opts),
    (async () => {
        while (true) {
            await page.waitForTimeout(500);
            const banner = await page.evaluate(() => { const e = document.getElementById('errorMsg'); return e && e.style.display === 'block' ? e.textContent : null; }).catch(() => null);
            if (banner) throw new Error(`app error banner: ${banner}`);
        }
    })(),
]);
const state = () => page.evaluate(() => {
    const s = window.__calibrat3.state;
    return {
        views: s.views.length, totalFrames: s.totalFrames,
        detections: s.detections ? s.detections.size : 0,
        intrinsics: s.intrinsics.map(r => r ? { rms: r.rmsError, used: r.framesUsed, valid: r.framesValid } : null),
        extrinsics: s.extrinsics.map(e => e ? (e.error || e.tvec.map(v => +v.toFixed(1))) : null),
        reproj: s.reproj ? s.reproj.summary.overall : null,
        sba: s.sbaResult ? { iters: s.sbaResult.result.iterations, initial: s.sbaResult.result.initial_cost, final: s.sbaResult.result.final_cost } : null,
    };
});

try {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    step('page loaded; waiting for workers');
    await waitState(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 120000 });
    step(await page.textContent('#workerStatus'));

    await page.click('#loadSampleBtn');
    await waitState(() => window.__calibrat3.state.views.length === 4 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 60000 });
    const s1 = await state();
    step(`session: ${s1.views} views, ${s1.totalFrames} frames`);

    await page.fill('#targetSamples', String(TARGET));
    await page.dispatchEvent('#targetSamples', 'input');
    await page.click('#runDetectionBtn');
    await waitState(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections && window.__calibrat3.state.detections.size > 0, null, { timeout: 300000 });
    const s2 = await state();
    step(`detections stored for ${s2.detections} frames`);
    const summary = await page.evaluate(() => window.__calibrat3.state.detections.summary(6));
    step(`summary: ${JSON.stringify(summary)}`);
    if (summary.framesAllViewsGood < 3) throw new Error('too few frames detected in all views');

    await page.click('#computeIntrinsicsBtn');
    await waitState(() => window.__calibrat3.state.intrinsics.filter(Boolean).length === 4, null, { timeout: 300000 });
    const s3 = await state();
    step(`intrinsics: ${JSON.stringify(s3.intrinsics)}`);
    for (const r of s3.intrinsics) if (!r || !(r.rms < 5)) throw new Error(`bad intrinsics ${JSON.stringify(r)}`);

    await page.click('#computeExtrinsicsBtn');
    await waitState(() => window.__calibrat3.state.reproj !== null, null, { timeout: 300000 });
    const s4 = await state();
    step(`extrinsics: ${JSON.stringify(s4.extrinsics)}  reproj: ${JSON.stringify(s4.reproj)}`);
    if (!(s4.reproj.median < 10)) throw new Error('cross-view reprojection too large');

    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 60000 });
    await page.click('#runSbaBtn');
    await waitState(() => window.__calibrat3.state.sbaResult !== null, null, { timeout: 300000 });
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 300000 });
    const s5 = await state();
    step(`sba: ${JSON.stringify(s5.sba)}  reproj after: ${JSON.stringify(s5.reproj)}`);
    if (!(s5.sba.final <= s5.sba.initial)) { const cc = await page.evaluate(() => JSON.stringify(window.__calibrat3.state.sbaResult.result.chunkCosts)); throw new Error(`SBA did not reduce cost: chunks ${cc}`); }

    const toml = await page.textContent('#tomlPreview');
    if (!toml.includes('[cam_3]') || !toml.includes('rotation = [')) throw new Error('TOML preview incomplete');
    step('TOML preview ok');

    // --- revert SBA restores the initial reprojection
    await page.click('#revertSbaBtn');
    await waitState(() => window.__calibrat3.state.sbaResult === null && window.__calibrat3.state.reproj !== null, null, { timeout: 60000 });
    await waitState(() => document.getElementById('extrinsicsProgress').classList.contains('active') === false, null, { timeout: 60000 });
    const s6 = await state();
    if (Math.abs(s6.reproj.mean - s4.reproj.mean) > 1e-6) throw new Error(`revert did not restore reprojection (${s6.reproj.mean} vs ${s4.reproj.mean})`);
    step('revert SBA ok');

    // --- navigation + exclusion hotkeys; exclusion applies to the active stage (extrinsics)
    await page.keyboard.press(']');
    await page.keyboard.press('x');
    await page.waitForTimeout(200);
    const excl = await page.evaluate(() => ({ ext: Array.from(window.__calibrat3.state.exclusions.extrinsics), cur: window.__calibrat3.state.currentFrame }));
    if (excl.ext.length !== 1 || excl.ext[0] !== excl.cur) throw new Error(`exclusion hotkey: ${JSON.stringify(excl)}`);
    step(`exclusion toggled on frame ${excl.cur}`);
    // recompute extrinsics with the exclusion: the excluded frame must leave the covisibility graph but stay in the reprojection set
    await page.click('#computeExtrinsicsBtn');
    await waitState(() => document.getElementById('computeExtrinsicsBtn').disabled === false && window.__calibrat3.state.reproj !== null, null, { timeout: 120000 });
    await page.waitForTimeout(300);
    const framesInReproj = await page.evaluate(() => window.__calibrat3.state.reproj.frames.length);
    if (framesInReproj !== s2.detections) throw new Error(`reproj frames ${framesInReproj} != detections ${s2.detections}`);
    step('extrinsics recomputed with an exclusion');

    // --- intrinsics exclusion via the gallery ✕ button, then recompute intrinsics
    await page.evaluate(() => document.getElementById('stage3').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await page.click('#intrinsicsGallery .gallery-card .gallery-x');
    await page.waitForTimeout(200);
    const exIntr = await page.evaluate(() => window.__calibrat3.state.exclusions.intrinsics.size);
    if (exIntr !== 1) throw new Error(`intrinsics exclusion via gallery: ${exIntr}`);
    await page.click('#computeIntrinsicsBtn');
    await waitState(() => window.__calibrat3.state.intrinsics.filter(Boolean).length === 4 && document.getElementById('computeIntrinsicsBtn').disabled === false, null, { timeout: 120000 });
    const s7 = await state();
    if (s7.intrinsics.some(r => r.used !== r.valid - 1)) throw new Error(`excluded frame not dropped from fit: ${JSON.stringify(s7.intrinsics)}`);
    if (s7.reproj !== null) throw new Error('recomputing intrinsics must invalidate extrinsics/reprojection');
    step(`intrinsics recomputed with exclusion: ${JSON.stringify(s7.intrinsics.map(r => `${r.used}/${r.valid}`))}`);

    // --- single-frame detection hotkey
    await page.evaluate(() => window.__calibrat3.controllers.video.seekToFrame(5));
    await waitState(() => window.__calibrat3.state.currentFrame === 5, null, { timeout: 10000 });
    await page.keyboard.press('d');
    await waitState(() => window.__calibrat3.state.liveDetection && window.__calibrat3.state.liveDetection.frame === 5, null, { timeout: 60000 });
    const live = await page.evaluate(() => window.__calibrat3.state.liveDetection.perView.map(d => d ? d.ids.length : -1));
    if (live.some(n => n < 6)) throw new Error(`live detection: ${JSON.stringify(live)}`);
    step(`detect-current-frame: ${JSON.stringify(live)} corners`);

    // --- session save/restore round trip (in-page, through the real modules)
    const rt = await page.evaluate(async () => {
        const { serializeSession, validateSession, restoreSession } = await import('./import-export/session-save.js');
        const s = window.__calibrat3.state;
        const json = JSON.parse(JSON.stringify(serializeSession(s)));
        const before = { det: s.detections.size, frame7: Array.from(s.detections.get(7, 2).ids), fx: s.intrinsics[1].fx, excl: Array.from(s.exclusions.intrinsics) };
        s.detections = null; s.intrinsics = []; s.exclusions.intrinsics = new Set();
        const v = validateSession(json, s);
        if (!v.ok) return { error: v.problems.join('; ') };
        restoreSession(json, s);
        const after = { det: s.detections.size, frame7: Array.from(s.detections.get(7, 2).ids), fx: s.intrinsics[1].fx, excl: Array.from(s.exclusions.intrinsics) };
        return { before, after, bytes: JSON.stringify(json).length };
    });
    if (rt.error || JSON.stringify(rt.before) !== JSON.stringify(rt.after)) throw new Error(`session round trip: ${JSON.stringify(rt)}`);
    step(`session save/restore round trip ok (${(rt.bytes / 1024).toFixed(0)} KB)`);

    // --- re-detect with "every frame" on top of an existing session (state reset path)
    await page.check('#allFramesCheck');
    await page.click('#runDetectionBtn');
    await waitState(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections && window.__calibrat3.state.detections.size === window.__calibrat3.state.totalFrames, null, { timeout: 300000 });
    const s8 = await state();
    if (s8.intrinsics.length !== 0 || s8.reproj !== null) throw new Error('re-detection must reset downstream results');
    step(`re-detected every frame: ${s8.detections} frames, downstream reset`);
    const dom = await page.evaluate(() => ({ rows: document.querySelectorAll('.vtable-row').length, logEntries: document.querySelectorAll('#logBody .log-entry').length }));
    step(`DOM: ${dom.rows} table rows rendered, ${dom.logEntries} log entries`);

    if (SCREENSHOT) { await page.screenshot({ path: SCREENSHOT, fullPage: false }); step(`screenshot -> ${SCREENSHOT}`); }
    const logTail = await page.evaluate(() => Array.from(document.querySelectorAll('#logBody .log-entry')).slice(-12).map(e => e.textContent).join('\n'));
    console.log('--- log tail ---\n' + logTail);
} catch (e) {
    errors.push(`test: ${e.message}`);
    if (SCREENSHOT) await page.screenshot({ path: SCREENSHOT.replace(/\.png$/, '-failed.png') }).catch(() => {});
    const logTail = await page.evaluate(() => Array.from(document.querySelectorAll('#logBody .log-entry')).slice(-20).map(e => e.textContent).join('\n')).catch(() => '');
    console.log('--- log tail ---\n' + logTail);
} finally {
    await browser.close();
}

if (errors.length) { console.log('\nFAILED:\n' + errors.join('\n')); process.exit(1); }
console.log('\nPASS');
