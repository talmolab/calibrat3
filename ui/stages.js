/**
 * ui/stages.js — collapsible pipeline stages, status badges, progress bars,
 * error banner. Small DOM helpers shared by every stage module.
 */

export function toggleStage(stageId, force) {
    const el = document.getElementById(stageId);
    if (!el) return;
    if (force === undefined) el.classList.toggle('collapsed');
    else el.classList.toggle('collapsed', !force);
}

export function expandStage(stageId) { toggleStage(stageId, true); }
export function collapseStage(stageId) { toggleStage(stageId, false); }

/**
 * @param {string} stageId
 * @param {string} text
 * @param {''|'active'|'complete'|'error'|'warn'} [cls]
 */
export function setStageStatus(stageId, text, cls = '') {
    const el = document.getElementById(`${stageId}Status`);
    if (!el) return;
    el.textContent = text;
    el.className = `stage-status ${cls}`.trim();
}

export function setupStageHeaders() {
    document.querySelectorAll('.stage-header').forEach(h => {
        h.addEventListener('click', (e) => {
            if (e.target.closest('button, input, select, a')) return;
            const stage = h.closest('.stage');
            if (stage) stage.classList.toggle('collapsed');
        });
    });
}

// ---- progress bars ---------------------------------------------------------

/**
 * Progress controller for a `.progress-container` element. Updates are
 * coalesced to one DOM write per animation frame so hot loops can call
 * `set()` freely.
 */
export class Progress {
    constructor(containerId) {
        this.el = document.getElementById(containerId);
        this.bar = this.el?.querySelector('.progress-bar');
        this.text = this.el?.querySelector('.progress-text');
        this._pending = null;
        this._raf = 0;
        this.startedAt = 0;
    }
    show(text = 'Starting…') {
        if (!this.el) return this;
        this.el.classList.add('active');
        this.startedAt = performance.now();
        this.set(0, text);
        return this;
    }
    /** @param {number} fraction 0..1 */
    set(fraction, text) {
        this._pending = { fraction, text };
        if (!this._raf) this._raf = requestAnimationFrame(() => this._flush());
    }
    _flush() {
        this._raf = 0;
        if (!this._pending || !this.el) return;
        const { fraction, text } = this._pending;
        this._pending = null;
        const pct = Math.max(0, Math.min(100, fraction * 100));
        if (this.bar) this.bar.style.width = `${pct}%`;
        if (this.text) this.text.textContent = text ?? `${Math.round(pct)}%`;
    }
    hide() {
        if (!this.el) return;
        this.set(1, 'Done');
        setTimeout(() => this.el.classList.remove('active'), 300);
    }
    fail(text = 'Failed') {
        if (!this.el) return;
        this.set(1, text);
        this.el.classList.add('failed');
        setTimeout(() => { this.el.classList.remove('active', 'failed'); }, 2500);
    }
    elapsed() { return performance.now() - this.startedAt; }
}

// ---- error banner ----------------------------------------------------------

export function showError(msg) {
    const el = document.getElementById('errorMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(showError._t);
    showError._t = setTimeout(hideError, 12000);
}

export function hideError() {
    const el = document.getElementById('errorMsg');
    if (el) el.style.display = 'none';
}

// ---- small DOM helpers -----------------------------------------------------

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'text') e.textContent = v;
        else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined) continue;
        e.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
}

export function numInput(id, fallback) {
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) ? v : fallback;
}

export function intInput(id, fallback) {
    const v = parseInt(document.getElementById(id)?.value, 10);
    return Number.isFinite(v) ? v : fallback;
}

export function setEnabled(id, enabled) {
    const e = document.getElementById(id);
    if (e) e.disabled = !enabled;
}

export function errorColor(err, good = 1, ok = 2) {
    if (!isFinite(err)) return '#666';
    return err < good ? '#4ade80' : (err < ok ? '#fbbf24' : '#ff6b6b');
}

/** Yield to the event loop (lets the UI paint inside long async loops). */
export const nextTick = () => new Promise(r => setTimeout(r, 0));
