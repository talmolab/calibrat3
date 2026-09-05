/**
 * ui/gallery.js — "worst frames" gallery with lazy thumbnails.
 *
 * Shows at most `limit` cards (sorted by a metric), so the DOM never grows
 * with the number of frames. Thumbnails are JPEG Blobs captured during the
 * batch detection pass; object URLs are created only when a card scrolls
 * into view (IntersectionObserver) and revoked when the gallery re-renders.
 */

export class FrameGallery {
    /**
     * @param {HTMLElement} container
     * @param {{
     *   getThumb: (frame:number)=>Blob|null,
     *   onSeek?: (frame:number)=>void,
     *   onToggleExclude?: (frame:number)=>void,
     *   limit?: number,
     *   valueLabel?: string,
     * }} opts
     */
    constructor(container, opts) {
        this.container = container;
        this.getThumb = opts.getThumb;
        this.onSeek = opts.onSeek || null;
        this.onToggleExclude = opts.onToggleExclude || null;
        this.limit = opts.limit ?? 48;
        this.valueLabel = opts.valueLabel || 'err';
        this.items = [];
        this.urls = new Map();     // frame -> object URL
        this.cards = new Map();    // frame -> element
        this.current = -1;
        this.container.classList.add('gallery-grid');
        this.io = new IntersectionObserver((entries) => {
            for (const e of entries) if (e.isIntersecting) this._loadThumb(e.target);
        }, { root: null, rootMargin: '200px' });
    }

    /**
     * @param {Array<{frame:number, value:number, excluded:boolean, used?:boolean, sub?:string}>} items
     * @param {{sort?:'desc'|'asc'|'none', limit?:number}} [opts]
     */
    setItems(items, opts = {}) {
        const sort = opts.sort || 'desc';
        const limit = opts.limit ?? this.limit;
        let list = items.filter(i => isFinite(i.value) || i.excluded);
        if (sort === 'desc') list.sort((a, b) => (b.value || 0) - (a.value || 0));
        else if (sort === 'asc') list.sort((a, b) => (a.value || 0) - (b.value || 0));
        this.items = list.slice(0, limit);
        this._render();
    }

    updateExclusions(excludedSet) {
        for (const it of this.items) {
            it.excluded = excludedSet.has(it.frame);
            const card = this.cards.get(it.frame);
            if (card) card.classList.toggle('excluded', it.excluded);
        }
    }

    setCurrent(frame) {
        if (this.current >= 0) this.cards.get(this.current)?.classList.remove('current');
        this.current = frame;
        this.cards.get(frame)?.classList.add('current');
    }

    _render() {
        for (const u of this.urls.values()) URL.revokeObjectURL(u);
        this.urls.clear();
        this.cards.clear();
        this.io.disconnect();
        const frag = document.createDocumentFragment();
        for (const it of this.items) {
            const card = document.createElement('div');
            card.className = `gallery-card${it.excluded ? ' excluded' : ''}${it.used === false ? ' unused' : ''}${it.frame === this.current ? ' current' : ''}`;
            card.dataset.frame = String(it.frame);
            const img = document.createElement('div');
            img.className = 'gallery-thumb';
            const cap = document.createElement('div');
            cap.className = 'gallery-caption';
            const val = isFinite(it.value) ? `${it.value.toFixed(2)} px` : '—';
            cap.innerHTML = `<span class="gc-frame">f${it.frame}</span><span class="gc-value">${val}</span>`;
            if (it.sub) { const s = document.createElement('div'); s.className = 'gallery-sub'; s.textContent = it.sub; cap.appendChild(s); }
            const btn = document.createElement('button');
            btn.className = 'gallery-x';
            btn.title = it.excluded ? 'Include frame' : 'Exclude frame';
            btn.textContent = it.excluded ? '↺' : '✕';
            btn.addEventListener('click', (ev) => { ev.stopPropagation(); this.onToggleExclude && this.onToggleExclude(it.frame); });
            card.append(img, cap, btn);
            card.addEventListener('click', () => this.onSeek && this.onSeek(it.frame));
            this.cards.set(it.frame, card);
            frag.appendChild(card);
            this.io.observe(card);
        }
        this.container.replaceChildren(frag);
        if (this.items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'gallery-empty';
            empty.textContent = 'No frames';
            this.container.appendChild(empty);
        }
    }

    _loadThumb(card) {
        const frame = parseInt(card.dataset.frame, 10);
        if (this.urls.has(frame)) return;
        const blob = this.getThumb(frame);
        const div = card.querySelector('.gallery-thumb');
        if (!blob) { div.classList.add('missing'); div.textContent = 'no thumb'; return; }
        const url = URL.createObjectURL(blob);
        this.urls.set(frame, url);
        div.style.backgroundImage = `url(${url})`;
        this.io.unobserve(card);
    }

    destroy() {
        this.io.disconnect();
        for (const u of this.urls.values()) URL.revokeObjectURL(u);
        this.urls.clear();
    }
}
