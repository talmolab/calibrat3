/** Top-bar worker counts: empty/0 = Auto, positive integers = manual. */
import { controllers } from './app-state.js';
import { $, showError } from './stages.js';
import { log, fmtMs } from './log-panel.js';
import { DetectorPool } from '../loading/detect-pool.js';
import { CalibWorker } from '../loading/calib-client.js';

const detection = { id: 'detectionWorkers', name: 'Detection', ready: false, locked: false, update: null };
const calibration = { id: 'calibrationWorkers', name: 'Calibration', ready: false, locked: false, update: null };
const entries = [detection, calibration];

function render() {
    for (const entry of entries) {
        if (!entry.pool) continue;
        const input = $(entry.id);
        input.placeholder = `Auto (${entry.pool.autoSize})`;
        input.disabled = !!entry.update || entry.locked || entry.pool.pending.size > 0;
    }
    const failed = entries.some(e => e.failed), ready = entries.every(e => e.ready);
    $('workerStatus').textContent = failed ? 'Workers: failed' : ready ? 'Workers:' : 'Workers: loading…';
    $('workerStatus').className = `worker-status${failed ? ' err' : ready ? ' ok' : ''}`;
}

function update(entry, count) {
    entry.ready = false;
    entry.failed = false;
    entry.update = (count === undefined ? entry.pool.init() : entry.pool.resize(count)).then(() => {
        entry.ready = true;
    }).catch(e => {
        entry.failed = true;
        showError(`${entry.name} workers failed: ${e.message}`);
        throw e;
    }).finally(() => { entry.update = null; render(); });
    render();
    return entry.update;
}

export function startWorkers() {
    detection.pool = controllers.pool = new DetectorPool({ log });
    calibration.pool = controllers.calib = new CalibWorker({ log, onBusyChange: render });
    for (const entry of entries) {
        $(entry.id).addEventListener('change', () => {
            if (entry.update || entry.locked || entry.pool.pending.size) return;
            const input = $(entry.id), count = input.value === '' ? 0 : input.valueAsNumber;
            if (!Number.isSafeInteger(count) || count < 0) {
                showError('Worker count must be a nonnegative integer, or empty for Auto.');
                return;
            }
            input.value = count ? String(count) : '';
            update(entry, count).catch(() => {});
        });
    }
    const t0 = performance.now();
    Promise.all(entries.map(entry => update(entry))).then(() => {
        log(`All workers ready in ${fmtMs(performance.now() - t0)}`, 'success');
    }).catch(() => {});
}

export function setDetectionWorkersBusy(busy) { detection.locked = busy; render(); }
export function waitForDetectionWorkers() { return detection.update || detection.pool.init(); }
