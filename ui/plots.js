/**
 * ui/plots.js — swarm plot of per-frame errors per camera on a canvas.
 *
 * Aggregation is the caller's job (one point per frame per camera, never per
 * corner); the plot itself handles up to ~20k points with a grid-bucketed
 * hit index for hover. Hover only shows a tooltip; click seeks. Points can be
 * flagged `excluded` (dimmed) or `unused` (hollow).
 */

export class SwarmPlot {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLElement} tooltipEl
     * @param {{yLabel?:string, log?:boolean, height?:number, onClick?:(pt:object)=>void, onHover?:(pt:object|null)=>void, formatTooltip?:(pt:object)=>string}} [opts]
     */
    constructor(canvas, tooltipEl, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.tooltip = tooltipEl;
        this.yLabel = opts.yLabel || 'Error (px)';
        this.log = opts.log ?? true;
        this.height = opts.height ?? 260;
        this.onClick = opts.onClick || null;
        this.onHover = opts.onHover || null;
        this.formatTooltip = opts.formatTooltip || ((p) => `${p.group}\nframe ${p.frame}\n${p.y.toFixed(3)} px`);
        this.groups = [];
        this.pts = [];
        this.grid = null;
        this.thresholds = [];
        this._bind();
        new ResizeObserver(() => this.render()).observe(canvas.parentElement || canvas);
    }

    /**
     * @param {Array<{label:string, color:string, points:Array<{y:number, frame:number, excluded?:boolean, unused?:boolean, meta?:any}>}>} groups
     * @param {{thresholds?:number[], note?:string}} [opts]
     */
    setData(groups, opts = {}) {
        this.groups = groups;
        this.thresholds = opts.thresholds || [];
        this.note = opts.note || '';
        this.render();
    }

    render() {
        const dpr = window.devicePixelRatio || 1;
        const W = Math.max(200, this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 700);
        const H = this.height;
        this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
        this.canvas.style.height = `${H}px`;
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        this.pts = [];
        this.grid = null;   // no stale hit-testing if we bail out below
        const pad = { left: 58, right: 20, top: 26, bottom: 42 };
        const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
        const all = [];
        for (const g of this.groups) for (const p of g.points) if (isFinite(p.y) && p.y > 0) all.push(p.y);
        if (all.length === 0) {
            ctx.fillStyle = '#666'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('No data', W / 2, H / 2);
            return;
        }
        let lo = Math.min(...all), hi = Math.max(...all);
        for (const t of this.thresholds) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
        let yScale, ticks;
        if (this.log) {
            const lmin = Math.log10(Math.max(1e-3, lo) * 0.8), lmax = Math.log10(hi * 1.25 + 1e-9);
            yScale = (v) => pad.top + ph - ((Math.log10(Math.max(1e-3, v)) - lmin) / (lmax - lmin)) * ph;
            ticks = [];
            for (let e = Math.floor(lmin); e <= Math.ceil(lmax); e++) for (const m of [1, 2, 5]) {
                const v = m * 10 ** e;
                if (Math.log10(v) >= lmin && Math.log10(v) <= lmax) ticks.push(v);
            }
        } else {
            const vmax = hi * 1.1 || 1;
            yScale = (v) => pad.top + ph - (v / vmax) * ph;
            const step = niceStep(vmax / 5);
            ticks = []; for (let v = 0; v <= vmax; v += step) ticks.push(v);
        }
        // grid + ticks
        ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1; ctx.fillStyle = '#888'; ctx.font = '11px monospace'; ctx.textAlign = 'right';
        for (const v of ticks) {
            const y = yScale(v);
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            ctx.fillText(v < 1 ? v.toFixed(v < 0.1 ? 3 : 2) : (v < 10 ? v.toFixed(1) : String(Math.round(v))), pad.left - 6, y + 4);
        }
        for (const t of this.thresholds) {
            const y = yScale(t);
            ctx.strokeStyle = 'rgba(255,107,107,0.6)'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.save(); ctx.translate(14, pad.top + ph / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.fillStyle = '#aaa'; ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(this.yLabel, 0, 0); ctx.restore();

        const nG = this.groups.length;
        const band = pw / Math.max(1, nG);
        const cell = 10;
        const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
        this.grid = { cell, cols, rows, buckets: new Map() };
        const put = (p) => {
            const k = Math.floor(p.py / cell) * cols + Math.floor(p.px / cell);
            let b = this.grid.buckets.get(k); if (!b) { b = []; this.grid.buckets.set(k, b); } b.push(p);
        };
        this.groups.forEach((g, gi) => {
            const cx = pad.left + band * (gi + 0.5);
            const jitterW = band * 0.7;
            const r = g.points.length > 2000 ? 2 : (g.points.length > 500 ? 3 : 4);
            const ys = g.points.map(p => p.y).filter(v => isFinite(v) && v > 0);
            for (let i = 0; i < g.points.length; i++) {
                const p = g.points[i];
                if (!isFinite(p.y) || p.y <= 0) continue;
                const j = hash01(p.frame * 31 + gi * 7 + i) - 0.5;
                const px = cx + j * jitterW, py = yScale(p.y);
                const rec = { ...p, group: g.label, color: g.color, px, py, r };
                this.pts.push(rec); put(rec);
                ctx.beginPath(); ctx.arc(px, py, p.excluded ? r - 0.5 : r, 0, Math.PI * 2);
                if (p.excluded) { ctx.fillStyle = 'rgba(120,120,120,0.35)'; ctx.fill(); ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 1; ctx.stroke(); }
                else if (p.unused) { ctx.strokeStyle = g.color; ctx.lineWidth = 1.2; ctx.stroke(); }
                else { ctx.fillStyle = g.color; ctx.fill(); }
            }
            // median line
            if (ys.length) {
                const med = ys.slice().sort((a, b) => a - b)[ys.length >> 1];
                const y = yScale(med);
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(cx - band * 0.4, y); ctx.lineTo(cx + band * 0.4, y); ctx.stroke();
                ctx.fillStyle = '#ddd'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
                ctx.fillText(med.toFixed(2), cx + band * 0.41, y + 3);
            }
            ctx.fillStyle = g.color; ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(`${g.label} (n=${ys.length})`, cx, H - pad.bottom + 18);
        });
        // axes
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + ph); ctx.lineTo(W - pad.right, pad.top + ph); ctx.stroke();
        if (this.note) { ctx.fillStyle = '#aaa'; ctx.font = '11px monospace'; ctx.textAlign = 'right'; ctx.fillText(this.note, W - pad.right, pad.top - 10); }
    }

    _hit(ev) {
        if (!this.grid) return null;
        const rect = this.canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
        const { cell, cols, buckets } = this.grid;
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        let best = null, bestD = Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const b = buckets.get((cy + dy) * cols + (cx + dx));
            if (!b) continue;
            for (const p of b) {
                const d = Math.hypot(p.px - x, p.py - y);
                if (d <= p.r + 3 && d < bestD) { bestD = d; best = p; }
            }
        }
        return best;
    }

    _bind() {
        this.canvas.addEventListener('mousemove', (ev) => {
            const p = this._hit(ev);
            this.canvas.style.cursor = p ? 'pointer' : 'default';
            if (p && this.tooltip) {
                const pr = this.canvas.parentElement.getBoundingClientRect();
                this.tooltip.style.display = 'block';
                this.tooltip.style.left = `${Math.min(pr.width - 170, ev.clientX - pr.left + 12)}px`;
                this.tooltip.style.top = `${ev.clientY - pr.top - 10}px`;
                this.tooltip.textContent = this.formatTooltip(p);
            } else if (this.tooltip) this.tooltip.style.display = 'none';
            this.onHover && this.onHover(p);
        });
        this.canvas.addEventListener('mouseleave', () => { if (this.tooltip) this.tooltip.style.display = 'none'; this.onHover && this.onHover(null); });
        this.canvas.addEventListener('click', (ev) => { const p = this._hit(ev); if (p && this.onClick) this.onClick(p); });
    }
}

function hash01(n) {
    let x = (n | 0) * 2654435761;
    x = ((x >>> 13) ^ x) * 1274126177;
    return ((x >>> 16) & 0xffff) / 0x10000;
}

function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * Small convergence line chart (SBA cost history).
 */
export function drawLineChart(canvas, values, { color = '#667eea', log = true, label = '' } = {}) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(150, canvas.clientWidth || 300), H = canvas.clientHeight || 120;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!values || values.length < 2) return;
    const pad = { l: 46, r: 8, t: 8, b: 20 };
    const vs = values.map(v => log ? Math.log10(Math.max(1e-9, v)) : v);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const x = (i) => pad.l + (i / (values.length - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / ((hi - lo) || 1)) * (H - pad.t - pad.b);
    ctx.strokeStyle = '#333'; ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    vs.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
    ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText(fmt(values[0]), pad.l - 4, y(vs[0]) + 3);
    ctx.fillText(fmt(values[values.length - 1]), pad.l - 4, y(vs[vs.length - 1]) + 3);
    ctx.textAlign = 'center'; ctx.fillText(`${label} (${values.length} iters)`, (pad.l + W) / 2, H - 6);
    function fmt(v) { return v >= 1000 ? v.toExponential(1) : v.toFixed(v < 10 ? 2 : 0); }
}
