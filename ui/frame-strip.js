/**
 * ui/frame-strip.js — a canvas "frame strip": one column per sampled frame,
 * colored by a metric, with exclusion hatching and a current-frame marker.
 *
 * The strip is the O(1)-per-frame replacement for the old thumbnail grids
 * and long tables: 1000 frames are 1000 rects on one canvas. The base
 * rendering is cached on an offscreen canvas so moving the current-frame
 * marker (every seek) is a single blit + line.
 */

export class FrameStrip {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{height?:number, onClick?:(frame:number, ev:MouseEvent)=>void, tooltip?:(frame:number)=>string, tooltipEl?:HTMLElement}} [opts]
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.height = opts.height ?? 44;
        this.onClick = opts.onClick || null;
        this.tooltipFn = opts.tooltip || null;
        this.tooltipEl = opts.tooltipEl || null;
        this.frames = [];
        this.colorFn = () => '#444';
        this.excluded = new Set();
        this.marked = null;      // Set of frames to draw a "used" tick for
        this.current = -1;
        this.base = document.createElement('canvas');
        this.hoverIdx = -1;
        this._bindEvents();
        this._ro = new ResizeObserver(() => this.render());
        this._ro.observe(canvas.parentElement || canvas);
    }

    /**
     * @param {{frames:number[], colorFn:(frame:number)=>string|null, excluded?:Set<number>, marked?:Set<number>|null}} d
     */
    setData(d) {
        this.frames = d.frames.slice().sort((a, b) => a - b);
        this.colorFn = d.colorFn || this.colorFn;
        this.excluded = d.excluded || new Set();
        this.marked = d.marked || null;
        this._index = new Map(this.frames.map((f, i) => [f, i]));
        this.render();
    }

    setExcluded(set) { this.excluded = set; this.render(); }

    setCurrent(frame) {
        if (frame === this.current) return;
        this.current = frame;
        this._composite();
    }

    render() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(50, this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 600);
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(this.height * dpr);
        this.canvas.style.height = `${this.height}px`;
        this.base.width = this.canvas.width;
        this.base.height = this.canvas.height;
        const ctx = this.base.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, this.height);
        ctx.fillStyle = '#141414';
        ctx.fillRect(0, 0, w, this.height);
        const n = this.frames.length;
        if (n === 0) {
            ctx.fillStyle = '#666'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('No frames', w / 2, this.height / 2 + 4);
            this._composite();
            return;
        }
        const colW = w / n;
        const barTop = 2, barH = this.height - 12;
        for (let i = 0; i < n; i++) {
            const f = this.frames[i];
            const c = this.colorFn(f);
            const x = i * colW;
            ctx.fillStyle = c || '#333';
            ctx.fillRect(x, barTop, Math.max(1, colW - (colW > 3 ? 1 : 0)), barH);
            if (this.excluded.has(f)) {
                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(x, barTop, Math.max(1, colW), barH);
                ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x, barTop); ctx.lineTo(x + Math.max(1, colW), barTop + barH); ctx.stroke();
            }
            if (this.marked && this.marked.has(f)) {
                ctx.fillStyle = '#fff';
                ctx.fillRect(x, this.height - 8, Math.max(1, colW - 1), 3);
            }
        }
        ctx.fillStyle = '#555'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
        ctx.fillText(String(this.frames[0]), 2, this.height - 0.5);
        ctx.textAlign = 'right';
        ctx.fillText(String(this.frames[n - 1]), w - 2, this.height - 0.5);
        this._composite();
    }

    _composite() {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(this.base, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const w = this.canvas.width / dpr;
        const n = this.frames.length;
        if (n === 0) return;
        const colW = w / n;
        const drawMarker = (idx, color, width) => {
            const x = idx * colW + colW / 2;
            ctx.strokeStyle = color; ctx.lineWidth = width;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.height - 10); ctx.stroke();
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 5); ctx.closePath(); ctx.fill();
        };
        if (this.hoverIdx >= 0) drawMarker(this.hoverIdx, 'rgba(255,255,255,0.5)', 1);
        // Current: exact frame, else nearest sampled frame in a dimmer color.
        const idx = this._index?.get(this.current);
        if (idx !== undefined) drawMarker(idx, '#fff', 2);
        else if (this.current >= 0) {
            const near = this._nearestIdx(this.current);
            if (near >= 0) drawMarker(near, 'rgba(255,255,255,0.35)', 1);
        }
    }

    _nearestIdx(frame) {
        const fr = this.frames;
        let lo = 0, hi = fr.length - 1;
        if (hi < 0) return -1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (fr[mid] < frame) lo = mid + 1; else hi = mid; }
        if (lo > 0 && Math.abs(fr[lo - 1] - frame) < Math.abs(fr[lo] - frame)) return lo - 1;
        return lo;
    }

    _idxAt(ev) {
        const rect = this.canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const n = this.frames.length;
        if (n === 0) return -1;
        return Math.max(0, Math.min(n - 1, Math.floor(x / rect.width * n)));
    }

    _bindEvents() {
        this.canvas.style.cursor = 'pointer';
        this.canvas.addEventListener('mousemove', (ev) => {
            const idx = this._idxAt(ev);
            if (idx !== this.hoverIdx) { this.hoverIdx = idx; this._composite(); }
            if (this.tooltipEl && idx >= 0) {
                const f = this.frames[idx];
                this.tooltipEl.style.display = 'block';
                const parentRect = this.canvas.parentElement.getBoundingClientRect();
                this.tooltipEl.style.left = `${Math.min(parentRect.width - 160, ev.clientX - parentRect.left + 10)}px`;
                this.tooltipEl.style.top = `${ev.clientY - parentRect.top - 34}px`;
                this.tooltipEl.textContent = this.tooltipFn ? this.tooltipFn(f) : `Frame ${f}`;
            }
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.hoverIdx = -1; this._composite();
            if (this.tooltipEl) this.tooltipEl.style.display = 'none';
        });
        this.canvas.addEventListener('click', (ev) => {
            const idx = this._idxAt(ev);
            if (idx >= 0 && this.onClick) this.onClick(this.frames[idx], ev);
        });
    }
}

/** Sequential colormap helpers for strips (value in [0,1]). */
export function viridisLike(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
    const i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const f = t * (stops.length - 1) - i;
    const a = stops[i], b = stops[i + 1];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** Green (good) -> yellow -> red (bad) for errors in px, saturating at `bad`. */
export function errorColormap(err, good = 0.5, bad = 3) {
    if (!isFinite(err)) return '#333';
    const t = Math.max(0, Math.min(1, (Math.log(err / good)) / Math.log(bad / good)));
    const r = Math.round(t < 0.5 ? 74 + (251 - 74) * (t * 2) : 251 + (255 - 251) * ((t - 0.5) * 2));
    const g = Math.round(t < 0.5 ? 222 + (191 - 222) * (t * 2) : 191 + (107 - 191) * ((t - 0.5) * 2));
    const b = Math.round(t < 0.5 ? 128 + (36 - 128) * (t * 2) : 36 + (107 - 36) * ((t - 0.5) * 2));
    return `rgb(${r},${g},${b})`;
}
