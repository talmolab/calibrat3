/**
 * tests/e2e/save-to-folder.mjs — exports are saved into the session folder.
 *
 * The real folder picker and save dialog are native and can't be driven headless, so
 * both are stubbed: "Open session folder…" gets a folder in the origin-private file
 * system holding the sample session, and the save dialog records the options it was
 * opened with and returns a file in the folder it was asked to start in. Checks: the
 * dialog starts in the session folder with the right name, the file written there is
 * the export, cancel / "saved elsewhere" are logged, and a browser without the API
 * (Brave by default, Firefox, Safari) still gets a download plus a hint in the log.
 *
 * Run:  python3 server.py 8080 &  node tests/e2e/save-to-folder.mjs
 * Env:  BASE=http://localhost:8080  HEADFUL=1  VERBOSE=1
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';

const browser = await chromium.launch({ headless: !process.env.HEADFUL, args: ['--enable-features=SharedArrayBuffer'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    if (process.env.VERBOSE) console.log(`[${m.type()}] ${m.text()}`);
});

await page.addInitScript(() => {
    // window.__save.next: 'cancel' | 'elsewhere' | undefined (save in the folder it starts in)
    window.__save = { picks: [], next: undefined };
    window.showDirectoryPicker = async () => {
        const opfs = await navigator.storage.getDirectory();
        await opfs.removeEntry('calib_session', { recursive: true }).catch(() => {});
        const dir = await opfs.getDirectoryHandle('calib_session', { create: true });
        for (const name of ['back.mp4', 'mid.mp4', 'side.mp4', 'top.mp4', 'board.toml']) {
            const blob = await (await fetch(`sample_session/${name}`)).blob();
            const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
            await w.write(blob); await w.close();
        }
        window.__save.sessionDir = dir;
        return dir;
    };
    window.showSaveFilePicker = async (opts) => {
        const next = window.__save.next; window.__save.next = undefined;
        window.__save.picks.push({
            suggestedName: opts.suggestedName,
            startsInSession: !!opts.startIn && await opts.startIn.isSameEntry(window.__save.sessionDir),
            accept: opts.types?.[0]?.accept,
        });
        if (next === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError');
        const target = next === 'elsewhere'
            ? await (await navigator.storage.getDirectory()).getDirectoryHandle('elsewhere', { create: true })
            : opts.startIn;
        return target.getFileHandle(opts.suggestedName, { create: true });
    };
});

const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
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
const logText = () => page.evaluate(async () => (await import('./ui/log-panel.js')).dumpLog());
// (polled from here: waitForFunction does not await an async predicate)
const waitLog = async (needle, timeout = 30000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(100)) {
        if ((await logText()).includes(needle)) return;
    }
    throw new Error(`log never said "${needle}"; log tail:\n${(await logText()).split('\n').slice(-8).join('\n')}`);
};
const readSessionFile = (name, dir = 'calib_session') => page.evaluate(async ([d, n]) => {
    const h = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(d)).getFileHandle(n);
    return (await h.getFile()).text();
}, [dir, name]);
const lastPick = () => page.evaluate(() => window.__save.picks.at(-1));
const pickCount = () => page.evaluate(() => window.__save.picks.length);

try {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await waitState(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 120000 });
    step('workers ready');

    // --- open the session folder through the (stubbed) directory picker
    await page.click('#loadFolderBtn');
    await waitState(() => window.__calibrat3.state.views.length === 4 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 60000 });
    const held = await page.evaluate(() => window.__calibrat3.state.sessionDirHandle?.name);
    if (held !== 'calib_session') throw new Error(`state.sessionDirHandle not kept (got ${held})`);
    step('folder opened; its handle is kept in state');
    if (await page.evaluate(() => document.getElementById('stage5').classList.contains('collapsed'))) await page.click('#stage5 .stage-header');

    // --- board.toml: dialog starts in the session folder, file lands there
    await page.click('#exportBoardBtn');
    await waitLog('Saved calib_session/board.toml');
    let pick = await lastPick();
    if (pick.suggestedName !== 'board.toml' || !pick.startsInSession) throw new Error(`board.toml dialog: ${JSON.stringify(pick)}`);
    if (!pick.accept?.['text/plain']?.includes('.toml')) throw new Error(`board.toml file type: ${JSON.stringify(pick.accept)}`);
    if (!/board_x\s*=/.test(await readSessionFile('board.toml'))) throw new Error('board.toml written to the folder is not a board.toml');
    step('board.toml saved into the session folder');

    // --- calibrate (enough for the calibration.toml export)
    await page.fill('#targetSamples', '100');
    await page.dispatchEvent('#targetSamples', 'input');
    await page.click('#runDetectionBtn');
    await waitState(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections?.size > 0, null, { timeout: 300000 });
    await page.click('#computeIntrinsicsBtn');
    await waitState(() => window.__calibrat3.state.intrinsics.filter(Boolean).length === 4, null, { timeout: 300000 });
    await page.click('#computeExtrinsicsBtn');
    await waitState(() => window.__calibrat3.state.reproj !== null, null, { timeout: 300000 });
    await page.waitForSelector('#exportTomlBtn:not([disabled])', { timeout: 60000 });
    step('calibrated');

    // --- cancel: nothing written, logged, stage not marked exported
    await page.evaluate(() => { window.__save.next = 'cancel'; });
    await page.click('#exportTomlBtn');
    await waitLog('Saving calibration.toml cancelled');
    if ((await page.textContent('#stage5Status')) === 'Exported') throw new Error('cancelled export marked the stage Exported');
    const existsAfterCancel = await page.evaluate(async () => {
        try { await window.__save.sessionDir.getFileHandle('calibration.toml'); return true; } catch (_) { return false; }
    });
    if (existsAfterCancel) throw new Error('cancelled export still wrote calibration.toml');
    step('cancel ok');

    // --- calibration.toml into the session folder, same text as the preview
    await page.click('#exportTomlBtn');
    await waitLog('Saved calib_session/calibration.toml');
    pick = await lastPick();
    if (pick.suggestedName !== 'calibration.toml' || !pick.startsInSession) throw new Error(`calibration.toml dialog: ${JSON.stringify(pick)}`);
    const written = await readSessionFile('calibration.toml');
    const preview = await page.textContent('#tomlPreview');
    const body = (t) => t.split('\n').filter(l => !l.startsWith('# Generated:')).join('\n');   // the preview is older by a few ms
    if (body(written) !== body(preview) || !written.includes('[cam_3]')) {
        const a = written.split('\n'), b = preview.split('\n');
        const i = a.findIndex((l, k) => l !== b[k]);
        throw new Error(`calibration.toml in the folder differs from the preview at line ${i + 1}:\n  saved:   ${a[i]}\n  preview: ${b[i]}`);
    }
    if ((await page.textContent('#stage5Status')) !== 'Exported') throw new Error('stage 5 not marked Exported');
    step(`calibration.toml saved into the session folder (${written.length} bytes, identical to the preview)`);

    // --- the user picks another folder in the dialog: saved there, logged as outside
    await page.evaluate(() => { window.__save.next = 'elsewhere'; });
    await page.click('#exportSbaJsonBtn');
    await waitLog('Saved calibration_data.json (outside the session folder)');
    if (!JSON.parse(await readSessionFile('calibration_data.json', 'elsewhere')).observations) throw new Error('calibration_data.json is not the calibration data');
    step('saved outside the session folder: logged as such');

    // --- session save: serialized after the dialog, into the folder
    await page.click('#saveSessionBtn');
    await waitLog('Saved calib_session/calib_session.calibrat3.json');
    const saved = JSON.parse(await readSessionFile('calib_session.calibrat3.json'));
    if (saved.app !== 'calibrat3' || saved.session.views.length !== 4) throw new Error('session file is not a calibrat3 session');
    step('session saved into the session folder');

    // --- a browser without the File System Access API: plain download + a one-time hint
    await page.evaluate(() => { window.showSaveFilePicker = undefined; });
    const picksBefore = await pickCount();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exportTomlBtn')]);
    if (download.suggestedFilename() !== 'calibration.toml') throw new Error(`download named ${download.suggestedFilename()}`);
    await waitLog('This browser cannot open a save dialog in the session folder');
    const [download2] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exportBoardBtn')]);
    await waitLog('Downloaded board.toml');
    const hints = (await logText()).split('\n').filter(l => l.includes('This browser cannot open a save dialog')).length;
    if (hints !== 1) throw new Error(`hint logged ${hints} times, expected once`);
    if ((await pickCount()) !== picksBefore) throw new Error('save dialog used although the API is gone');
    step(`no API: downloaded ${download.suggestedFilename()} and ${download2.suggestedFilename()}, hint logged once`);

    if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
    console.log('PASS');
    await browser.close();
    process.exit(0);
} catch (e) {
    console.error(`FAIL: ${e.message}`);
    if (errors.length) console.error(errors.join('\n'));
    await browser.close();
    process.exit(1);
}
