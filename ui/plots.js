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
        const nGroups = this.groups.length;
        const bandGuess = (W - 78) / Math.max(1, nGroups);
        const rotate = bandGuess < 95;           // many cameras: angled, shorter labels
        const pad = { left: 58, right: 20, top: 26, bottom: rotate ? 74 : 42 };
        const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
        const all = [];
        for (const g of this.groups) for (const p of g.points) if (isFinite(p.y) && p.y > 0) all.push(p.y);
        if (all.length === 0) {
            ctx.fillStyle = '#666'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('No data', W / 2, H / 2);
            return;
        }
        let lo = Infinity, hi = -Infinity;
        for (const v of all) { if (v < lo) lo = v; if (v > hi) hi = v; }
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
                if (!rotate) {
                    ctx.fillStyle = '#ddd'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
                    ctx.fillText(med.toFixed(2), cx + band * 0.41, y + 3);
                }
            }
            ctx.fillStyle = g.color;
            if (rotate) {
                ctx.save();
                ctx.translate(cx, H - pad.bottom + 8);
                ctx.rotate(-Math.PI / 4);
                ctx.font = `${bandGuess < 40 ? 10 : 11}px system-ui, sans-serif`; ctx.textAlign = 'right';
                ctx.fillText(g.label, 0, 0);
                ctx.restore();
            } else {
                ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
                ctx.fillText(`${g.label} (n=${ys.length})`, cx, H - pad.bottom + 18);
            }
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


/**
 * Anipose-style reprojection error histogram: log-spaced bins on x, share of
 * observations on y, one stepped outline per series (e.g. per camera, or
 * initial vs refined), vertical dashed lines at each series' median.
 */
export class ErrorHistogram {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLElement} [tooltipEl]
     * @param {{height?:number, bins?:number, xLabel?:string}} [opts]
     */
    constructor(canvas, tooltipEl, opts = {}) {
        this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.tooltip = tooltipEl || null;
        this.height = opts.height ?? 250; this.bins = opts.bins ?? 48; this.xLabel = opts.xLabel || 'reprojection error (px, log scale)';
        this.series = []; this.thresholds = []; this._binsCache = null;
        new ResizeObserver(() => this.render()).observe(canvas.parentElement || canvas);
        this._bind();
    }

    /**
     * @param {Array<{label:string, color:string, values:ArrayLike<number>, fill?:boolean, width?:number}>} series
     * @param {{thresholds?:Array<{x:number,label:string}>, note?:string}} [opts]
     */
    setData(series, opts = {}) {
        this.series = series.map(sr => {
            const v = Array.from(sr.values).filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
            return { ...sr, sorted: v, median: v.length ? v[v.length >> 1] : NaN, p95: v.length ? v[Math.floor(v.length * 0.95)] : NaN, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN };
        });
        this.thresholds = opts.thresholds || []; this.note = opts.note || '';
        this.render();
    }

    render() {
        const dpr = window.devicePixelRatio || 1;
        const W = Math.max(200, this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 700), H = this.height;
        this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); this.canvas.style.height = `${H}px`;
        const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
        const all = this.series.flatMap(sr => sr.sorted.length ? [sr.sorted[0], sr.sorted[sr.sorted.length - 1]] : []);
        if (!all.length) { ctx.fillStyle = '#666'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No data', W / 2, H / 2); this._binsCache = null; return; }
        // Legend rows go BELOW the x-axis label so they never overlap the bars.
        ctx.font = '11px system-ui, sans-serif';
        const legendRows = this._legendRows(ctx, W - 68);
        const pad = { left: 52, right: 16, top: 14, bottom: 40 + legendRows * 15 };
        const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
        const lo = Math.max(0.01, Math.min(...all) * 0.8), hi = Math.max(...all) * 1.2;
        const llo = Math.log10(lo), lhi = Math.log10(hi);
        const x = (v) => pad.left + (Math.log10(Math.max(lo, v)) - llo) / (lhi - llo) * pw;
        const edges = Array.from({ length: this.bins + 1 }, (_, i) => 10 ** (llo + (lhi - llo) * i / this.bins));
        const hists = this.series.map(sr => {
            const h = new Float32Array(this.bins);
            for (const v of sr.sorted) { const b = Math.min(this.bins - 1, Math.max(0, Math.floor((Math.log10(v) - llo) / (lhi - llo) * this.bins))); h[b]++; }
            const n = sr.sorted.length || 1;
            for (let i = 0; i < this.bins; i++) h[i] /= n;
            return h;
        });
        const ymax = Math.max(1e-6, ...hists.map(h => Math.max(...h))) * 1.08;
        const y = (f) => pad.top + ph - (f / ymax) * ph;
        this._binsCache = { edges, hists, pad, pw, ph, x, llo, lhi };
        // grid / axes
        ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1; ctx.fillStyle = '#888'; ctx.font = '11px monospace'; ctx.textAlign = 'right';
        for (const f of [0.25, 0.5, 0.75, 1].map(k => k * ymax / 1.08)) { const yy = y(f); ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(W - pad.right, yy); ctx.stroke(); ctx.fillText(`${(f * 100).toFixed(0)}%`, pad.left - 6, yy + 4); }
        ctx.textAlign = 'center';
        for (let e = Math.floor(llo); e <= Math.ceil(lhi); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v < lo || v > hi) continue; const xx = x(v); ctx.strokeStyle = m === 1 ? '#3a3a3a' : '#262626'; ctx.beginPath(); ctx.moveTo(xx, pad.top); ctx.lineTo(xx, pad.top + ph); ctx.stroke(); ctx.fillStyle = '#888'; ctx.fillText(v < 1 ? v.toFixed(v < 0.1 ? 2 : 1) : String(v), xx, H - pad.bottom + 16); }
        ctx.fillStyle = '#aaa'; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(this.xLabel, pad.left + pw / 2, pad.top + ph + 32);
        // series
        this.series.forEach((sr, si) => {
            const h = hists[si];
            ctx.beginPath();
            for (let i = 0; i < this.bins; i++) { const x0 = x(edges[i]), x1 = x(edges[i + 1]), yy = y(h[i]); if (i === 0) ctx.moveTo(x0, y(0)); ctx.lineTo(x0, yy); ctx.lineTo(x1, yy); }
            ctx.lineTo(x(edges[this.bins]), y(0));
            if (sr.fill) { ctx.fillStyle = sr.color + '33'; ctx.fill(); }
            ctx.strokeStyle = sr.color; ctx.lineWidth = sr.width ?? 1.6; ctx.stroke();
            if (Number.isFinite(sr.median)) { ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x(sr.median), pad.top); ctx.lineTo(x(sr.median), pad.top + ph); ctx.stroke(); ctx.setLineDash([]); }
        });
        for (const t of this.thresholds) { const xx = x(t.x); ctx.strokeStyle = 'rgba(255,107,107,0.8)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(xx, pad.top); ctx.lineTo(xx, pad.top + ph); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#ff9b9b'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillText(t.label, xx + 3, pad.top + ph - 4); }
        // legend (below the axis label)
        ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
        let lx = pad.left + 8, ly = pad.top + ph + 40;
        for (const sr of this.series) {
            const txt = this._legendText(sr);
            const w = ctx.measureText(txt).width + 22;
            if (lx + w > W - pad.right && lx > pad.left + 8) { lx = pad.left + 8; ly += 15; }
            ctx.fillStyle = sr.color; ctx.fillRect(lx, ly + 2, 12, 8); ctx.fillStyle = '#ddd'; ctx.fillText(txt, lx + 16, ly + 10);
            lx += w + 10;
        }
        if (this.note) { ctx.fillStyle = '#aaa'; ctx.font = '11px monospace'; ctx.textAlign = 'right'; ctx.fillText(this.note, W - pad.right, pad.top - 8); }
    }

    _legendText(sr) { return `${sr.label}: median ${sr.median.toFixed(2)}, p95 ${sr.p95.toFixed(1)} px (n=${sr.sorted.length})`; }

    /** Number of legend rows needed at the given usable width (font must already be set). */
    _legendRows(ctx, usable) {
        let rows = 1, x = 0;
        for (const sr of this.series) {
            const w = ctx.measureText(this._legendText(sr)).width + 32;
            if (x + w > usable && x > 0) { rows++; x = 0; }
            x += w;
        }
        return rows;
    }

    _bind() {
        this.canvas.addEventListener('mousemove', (ev) => {
            if (!this.tooltip || !this._binsCache) return;
            const rect = this.canvas.getBoundingClientRect();
            const { edges, hists, pad, pw, llo, lhi } = this._binsCache;
            const xr = ev.clientX - rect.left;
            if (xr < pad.left || xr > pad.left + pw) { this.tooltip.style.display = 'none'; return; }
            const b = Math.min(this.bins - 1, Math.max(0, Math.floor((xr - pad.left) / pw * this.bins)));
            const pr = this.canvas.parentElement.getBoundingClientRect();
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = `${Math.min(pr.width - 200, ev.clientX - pr.left + 12)}px`;
            this.tooltip.style.top = `${ev.clientY - pr.top - 10}px`;
            this.tooltip.textContent = `${edges[b].toFixed(2)} – ${edges[b + 1].toFixed(2)} px\n` + this.series.map((sr, i) => `${sr.label}: ${(hists[i][b] * 100).toFixed(1)}% (${Math.round(hists[i][b] * sr.sorted.length)})`).join('\n');
            void llo; void lhi;
        });
        this.canvas.addEventListener('mouseleave', () => { if (this.tooltip) this.tooltip.style.display = 'none'; });
    }
}
