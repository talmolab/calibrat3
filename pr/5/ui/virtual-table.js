/**
 * ui/virtual-table.js — a fixed-row-height virtualized table.
 *
 * Only the rows inside the scroll viewport (plus a small overscan) exist in
 * the DOM, so 10,000 rows cost the same as 20. The container has a bounded
 * height and scrolls internally — the page never grows with the data.
 */

export class VirtualTable {
    /**
     * @param {HTMLElement} container
     * @param {{
     *   columns: Array<{key:string, label:string, width?:string, align?:'left'|'right'|'center', render?:(row:object)=>string, color?:(row:object)=>string|null, title?:string}>,
     *   rowHeight?: number, height?: number, overscan?: number,
     *   onRowClick?: (row:object, ev:MouseEvent)=>void,
     *   rowClass?: (row:object)=>string,
     *   rowKey?: (row:object)=>any,
     *   emptyText?: string,
     * }} opts
     */
    constructor(container, opts) {
        this.container = container;
        this.columns = opts.columns;
        this.rowHeight = opts.rowHeight ?? 26;
        this.height = opts.height ?? 320;
        this.overscan = opts.overscan ?? 6;
        this.onRowClick = opts.onRowClick || null;
        this.rowClass = opts.rowClass || (() => '');
        this.rowKey = opts.rowKey || ((r) => r.frame);
        this.emptyText = opts.emptyText || 'No rows';
        this.rows = [];
        this.selectedKey = null;
        this._raf = 0;
        this._build();
    }

    _build() {
        const c = this.container;
        c.classList.add('vtable');
        c.innerHTML = '';
        const template = this.columns.map(col => col.width || '1fr').join(' ');
        this.header = document.createElement('div');
        this.header.className = 'vtable-header';
        this.header.style.gridTemplateColumns = template;
        for (const col of this.columns) {
            const h = document.createElement('div');
            h.className = `vtable-cell ${col.align || 'left'}`;
            h.textContent = col.label;
            if (col.title) h.title = col.title;
            this.header.appendChild(h);
        }
        this.scroller = document.createElement('div');
        this.scroller.className = 'vtable-scroller';
        this.scroller.style.height = `${this.height}px`;
        this.spacer = document.createElement('div');
        this.spacer.className = 'vtable-spacer';
        this.body = document.createElement('div');
        this.body.className = 'vtable-body';
        this.body.style.gridTemplateColumns = template;
        this.spacer.appendChild(this.body);
        this.scroller.appendChild(this.spacer);
        this.empty = document.createElement('div');
        this.empty.className = 'vtable-empty';
        this.empty.textContent = this.emptyText;
        c.append(this.header, this.scroller, this.empty);
        this._template = template;
        this.scroller.addEventListener('scroll', () => this._schedule());
        this.body.addEventListener('click', (ev) => {
            const rowEl = ev.target.closest('.vtable-row');
            if (!rowEl) return;
            const idx = parseInt(rowEl.dataset.idx, 10);
            const row = this.rows[idx];
            if (!row) return;
            this.setSelected(this.rowKey(row));
            this.onRowClick && this.onRowClick(row, ev);
        });
        new ResizeObserver(() => this._schedule()).observe(this.scroller);
    }

    setRows(rows) {
        this.rows = rows;
        this.spacer.style.height = `${rows.length * this.rowHeight}px`;
        this.empty.style.display = rows.length ? 'none' : 'block';
        this.scroller.style.display = rows.length ? 'block' : 'none';
        this._schedule();
    }

    setSelected(key, { scroll = false } = {}) {
        this.selectedKey = key;
        if (scroll) {
            const idx = this.rows.findIndex(r => this.rowKey(r) === key);
            if (idx >= 0) this.scrollToRow(idx);
        }
        this._schedule();
    }

    scrollToRow(idx) {
        const top = idx * this.rowHeight;
        const viewTop = this.scroller.scrollTop, viewH = this.scroller.clientHeight;
        if (top < viewTop || top + this.rowHeight > viewTop + viewH) {
            this.scroller.scrollTop = Math.max(0, top - viewH / 2 + this.rowHeight / 2);
        }
    }

    _schedule() {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
    }

    _render() {
        const n = this.rows.length;
        const viewH = this.scroller.clientHeight || this.height;
        const first = Math.max(0, Math.floor(this.scroller.scrollTop / this.rowHeight) - this.overscan);
        const last = Math.min(n, Math.ceil((this.scroller.scrollTop + viewH) / this.rowHeight) + this.overscan);
        this.body.style.transform = `translateY(${first * this.rowHeight}px)`;
        const frag = document.createDocumentFragment();
        for (let i = first; i < last; i++) {
            const row = this.rows[i];
            const div = document.createElement('div');
            div.className = `vtable-row ${this.rowClass(row)} ${this.rowKey(row) === this.selectedKey ? 'selected' : ''}`.trim();
            div.style.gridTemplateColumns = this._template;
            div.style.height = `${this.rowHeight}px`;
            div.dataset.idx = String(i);
            for (const col of this.columns) {
                const cell = document.createElement('div');
                cell.className = `vtable-cell ${col.align || 'left'}`;
                const val = col.render ? col.render(row) : row[col.key];
                cell.textContent = (val === null || val === undefined) ? '' : String(val);
                const color = col.color ? col.color(row) : null;
                if (color) cell.style.color = color;
                div.appendChild(cell);
            }
            frag.appendChild(div);
        }
        this.body.replaceChildren(frag);
    }
}
