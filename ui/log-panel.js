/**
 * ui/log-panel.js — cheap diagnostic log.
 *
 * Entries go into an in-memory ring buffer; the DOM is updated at most once
 * per animation frame with a single fragment append and one trim. `debug`
 * level entries are kept in the ring but only rendered when verbose is on.
 * console.* is used only for warn/error.
 */

const RING_SIZE = 2000;
const DOM_MAX = 300;

const ring = [];
let ringStart = 0;          // number of entries dropped from the front
const pendingDom = [];
let flushScheduled = false;
let verbose = false;
let body = null, countEl = null;
const listeners = new Set();

export function initLogPanel({ bodyEl, copyBtn, clearBtn, verboseToggle, countEl: cEl }) {
    body = bodyEl;
    countEl = cEl || null;
    copyBtn && copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(dumpLog()).then(() => log('Log copied to clipboard', 'success'), (e) => log(`Copy failed: ${e.message}`, 'error'));
    });
    clearBtn && clearBtn.addEventListener('click', () => { clearLog(); log('Log cleared'); });
    if (verboseToggle) {
        verbose = !!verboseToggle.checked;
        verboseToggle.addEventListener('change', () => { verbose = verboseToggle.checked; rerender(); });
    }
    // Flush anything logged before init.
    for (const e of ring) queueDom(e);
    scheduleFlush();
}

export function setVerbose(v) { verbose = !!v; rerender(); }
export function isVerbose() { return verbose; }

/**
 * @param {string} msg
 * @param {'debug'|'info'|'success'|'warn'|'error'} [level]
 */
export function log(msg, level = 'info') {
    const entry = { t: Date.now(), level, msg: String(msg) };
    ring.push(entry);
    if (ring.length > RING_SIZE) { ring.shift(); ringStart++; }
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    for (const fn of listeners) { try { fn(entry); } catch (_) { /* */ } }
    if (level !== 'debug' || verbose) queueDom(entry);
    scheduleFlush();
    return entry;
}

export const debug = (msg) => log(msg, 'debug');

export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function dumpLog() {
    return ring.map(e => `${fmtTime(e.t)} [${e.level}] ${e.msg}`).join('\n');
}

export function clearLog() {
    ring.length = 0;
    pendingDom.length = 0;
    if (body) body.textContent = '';
    updateCount();
}

function queueDom(entry) { if (body) pendingDom.push(entry); }

function scheduleFlush() {
    if (flushScheduled || !body) return;
    flushScheduled = true;
    requestAnimationFrame(flush);
}

function flush() {
    flushScheduled = false;
    if (!body || pendingDom.length === 0) return;
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const frag = document.createDocumentFragment();
    const start = Math.max(0, pendingDom.length - DOM_MAX);
    for (let i = start; i < pendingDom.length; i++) frag.appendChild(renderEntry(pendingDom[i]));
    pendingDom.length = 0;
    body.appendChild(frag);
    while (body.childElementCount > DOM_MAX) body.removeChild(body.firstElementChild);
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
    updateCount();
}

function rerender() {
    if (!body) return;
    body.textContent = '';
    pendingDom.length = 0;
    const shown = ring.filter(e => e.level !== 'debug' || verbose);
    for (const e of shown.slice(-DOM_MAX)) pendingDom.push(e);
    scheduleFlush();
}

function renderEntry(e) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = fmtTime(e.t);
    const msg = document.createElement('span');
    msg.className = `log-msg ${e.level}`;
    msg.textContent = e.msg;
    div.append(time, msg);
    return div;
}

function updateCount() {
    if (countEl) countEl.textContent = `${ring.length}${ringStart ? ` (+${ringStart} dropped)` : ''}`;
}

function fmtTime(t) {
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Format milliseconds for log lines. */
export function fmtMs(ms) {
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}
