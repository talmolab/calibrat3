/**
 * loading/video.js — frame-accurate MP4 decoding with WebCodecs + mp4box.js.
 *
 * Two consumers:
 *   - Interactive display: `getFrame(i)` returns an ImageBitmap from an LRU
 *     cache, decoding from the preceding keyframe on a miss (only the frames
 *     in [i, i+lookahead] are bitmapped; every other VideoFrame is closed).
 *   - Batch detection: `iterateFrames(frames)` walks the wanted frames in ONE
 *     sequential pass over the file, GOP by GOP, with a single VideoDecoder
 *     that is never reconfigured, yielding raw VideoFrames for wanted frames
 *     and closing the rest immediately. Feeding is back-pressured on the
 *     consumer so memory stays bounded no matter how many frames are wanted.
 *
 * Frame indices are PRESENTATION order (cts-sorted). mp4box hands us samples
 * in decode order; for B-frame streams the two differ and we map between them.
 *
 * Globals: MP4Box, DataStream (lib/mp4box/mp4box.all.min.js).
 */

const CHUNK_SIZE = 1024 * 1024;
const MAX_STREAM_GAP = 64;      // continue an open stream if the target is at most this many chunks ahead
const STREAM_WAIT_MS = 250;     // how long to wait for a target frame before feeding more / flushing
const REORDER_FEED = 6;         // chunks fed past the target so B-frame decoders emit it without a flush
const GOP_CACHE_MAX_BYTES = 96 * 1024 * 1024;   // per decoder: bytes of the current GOP kept in memory

export class OnDemandVideoDecoder {
    constructor(options = {}) {
        this.name = options.name || 'video';
        this.cacheSize = options.cacheSize || 30;
        this.lookahead = options.lookahead || 5;
        this.log = options.log || (() => {});
        this.cache = new Map();          // frameIdx -> ImageBitmap (LRU: insertion order)
        this.samples = [];               // decode order
        this.presentation = null;        // Int32Array frameIdx -> decodeIdx
        this.frameOfDecode = null;       // Int32Array decodeIdx -> frameIdx
        this.keyframes = [];             // decode indices of sync samples (ascending)
        this.hasBFrames = false;
        this.tsToFrame = new Map();      // rounded cts(us) -> frameIdx
        this.decoder = null;
        this.config = null;
        this.info = null;
        this._queue = Promise.resolve(); // serializes decode operations
        this._stream = null;             // open display stream: {nextDecode: next chunk to feed, nextOut: next presentation frame the decoder will emit}
        this._waiters = new Map();       // frameIdx -> resolve(bool) for display requests
        this._keepLo = -1; this._keepHi = -1;   // presentation frames to bitmap when their output arrives
        this.bitmapScale = options.bitmapScale || 1;   // <1: cache display bitmaps at reduced resolution (many-camera sessions)
        this._closed = false;
        this.stats = { decoded: 0, bitmapped: 0, gops: 0, bytesRead: 0, restarts: 0, timeouts: 0, waitMs: 0, readMs: 0, bitmapMs: 0 };
    }

    // ------------------------------------------------------------------ init

    /** @param {string|File|Blob} source URL or File/Blob */
    async init(source) {
        if (typeof source === 'string') {
            this.url = source;
            const head = await fetch(source, { method: 'HEAD' });
            if (!head.ok) throw new Error(`HTTP ${head.status} for ${source}`);
            this.fileSize = parseInt(head.headers.get('Content-Length')) || 0;
            this.supportsRange = head.headers.get('Accept-Ranges') === 'bytes' && this.fileSize > 0;
            if (!this.supportsRange) {
                const resp = await fetch(source);
                this.file = await resp.blob();
                this.fileSize = this.file.size;
                this.url = null;
            }
        } else {
            this.file = source;
            this.fileSize = source.size;
        }

        const mp4 = MP4Box.createFile();
        const ready = new Promise((resolve, reject) => {
            mp4.onError = (e) => reject(new Error(`mp4box: ${e}`));
            mp4.onReady = resolve;
        });
        let resolved = false;
        ready.then(() => { resolved = true; }, () => { resolved = true; });
        let offset = 0;
        while (offset < this.fileSize && !resolved) {
            const buf = await this.readBytes(offset, Math.min(CHUNK_SIZE, this.fileSize - offset));
            buf.fileStart = offset;
            const next = mp4.appendBuffer(buf);
            offset = (next === undefined) ? offset + buf.byteLength : next;
            await new Promise(r => setTimeout(r, 0));
        }
        const info = await ready;
        if (!info.videoTracks || info.videoTracks.length === 0) throw new Error('No video track');
        const track = info.videoTracks[0];
        const trak = mp4.getTrackById(track.id);
        const description = getCodecDescription(trak);
        const codec = track.codec.startsWith('vp08') ? 'vp8' : track.codec;
        this.config = { codec, codedWidth: track.video.width, codedHeight: track.video.height };
        if (description) this.config.description = description;
        // Prefer hardware but don't require it.
        this.config.hardwareAcceleration = 'no-preference';
        const support = await VideoDecoder.isConfigSupported(this.config);
        if (!support.supported) throw new Error(`Codec ${codec} not supported by this browser`);

        this._extractSamples(mp4, track);
        const duration = track.duration / track.timescale;
        const fps = duration > 0 ? this.samples.length / duration : 30;
        this.info = {
            codec, width: track.video.width, height: track.video.height,
            totalFrames: this.samples.length, keyframes: this.keyframes.length,
            duration, fps, hasBFrames: this.hasBFrames,
            avgGop: this.samples.length / Math.max(1, this.keyframes.length),
        };
        mp4.flush();
        return this.info;
    }

    _extractSamples(mp4, track) {
        const infos = mp4.getTrackSamplesInfo(track.id);
        if (!infos || infos.length === 0) throw new Error('No samples in video track');
        const ts = track.timescale;
        this.samples = new Array(infos.length);
        for (let i = 0; i < infos.length; i++) {
            const s = infos[i];
            this.samples[i] = {
                offset: s.offset, size: s.size,
                cts: s.cts * 1e6 / ts, dts: s.dts * 1e6 / ts,
                duration: s.duration * 1e6 / ts,
                isKeyframe: !!s.is_sync,
            };
            if (s.is_sync) this.keyframes.push(i);
        }
        if (this.keyframes.length === 0 || this.keyframes[0] !== 0) {
            // Treat the first sample as a keyframe anyway; decoding will surface errors if not.
            this.keyframes.unshift(0);
            this.samples[0].isKeyframe = true;
        }
        const order = this.samples.map((_, i) => i).sort((a, b) => this.samples[a].cts - this.samples[b].cts || a - b);
        this.presentation = Int32Array.from(order);
        this.frameOfDecode = new Int32Array(order.length);
        for (let f = 0; f < order.length; f++) {
            this.frameOfDecode[order[f]] = f;
            if (order[f] !== f) this.hasBFrames = true;
            this.tsToFrame.set(Math.round(this.samples[order[f]].cts), f);
        }
    }

    get totalFrames() { return this.samples.length; }

    // -------------------------------------------------------------- byte I/O

    async readBytes(offset, size) {
        const end = Math.min(offset + size, this.fileSize);
        this.stats.bytesRead += end - offset;
        if (this.url) {
            const resp = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end - 1}` } });
            if (!resp.ok && resp.status !== 206) throw new Error(`Range request failed: HTTP ${resp.status}`);
            return await resp.arrayBuffer();
        }
        return await this.file.slice(offset, end).arrayBuffer();
    }

    /**
     * Read sample payloads for decode indices [start, end]. Ranges inside one GOP are
     * served from a per-decoder byte cache of the whole GOP (one file read per GOP
     * instead of one per step — File.slice() round-trips cost tens of ms each when
     * 18 views step together).
     */
    async readSampleRange(start, end) {
        const g = this._gopIndexOfDecode(start);
        const [gs, ge] = this._gopRange(g);
        if (end <= ge) {
            const first = this.samples[gs], lastS = this.samples[ge];
            const spanStart = Math.min(first.offset, lastS.offset);
            let spanEnd = 0;
            for (let i = gs; i <= ge; i++) spanEnd = Math.max(spanEnd, this.samples[i].offset + this.samples[i].size);
            if (spanEnd - spanStart <= GOP_CACHE_MAX_BYTES) {
                if (!this._gopBuf || this._gopBuf.gop !== g) {
                    this._gopBuf = { gop: g, base: spanStart, bytes: new Uint8Array(await this.readBytes(spanStart, spanEnd - spanStart)) };
                }
                const out = new Array(end - start + 1);
                for (let i = start; i <= end; i++) {
                    const smp = this.samples[i];
                    const o = smp.offset - this._gopBuf.base;
                    out[i - start] = this._gopBuf.bytes.subarray(o, o + smp.size);
                }
                return out;
            }
        }
        return this._readSampleRangeDirect(start, end);
    }

    async _readSampleRangeDirect(start, end) {
        const out = new Array(end - start + 1);
        let regionStart = start;
        while (regionStart <= end) {
            let regionEnd = regionStart;
            let bytes = this.samples[regionStart].size;
            while (regionEnd < end) {
                const cur = this.samples[regionEnd], nxt = this.samples[regionEnd + 1];
                if (nxt.offset === cur.offset + cur.size) { regionEnd++; bytes += nxt.size; }
                else break;
            }
            const buf = new Uint8Array(await this.readBytes(this.samples[regionStart].offset, bytes));
            let p = 0;
            for (let i = regionStart; i <= regionEnd; i++) {
                out[i - start] = buf.subarray(p, p + this.samples[i].size);
                p += this.samples[i].size;
            }
            regionStart = regionEnd + 1;
        }
        return out;
    }

    // ----------------------------------------------------------- GOP helpers

    /** Index into this.keyframes of the GOP containing decode index d. */
    _gopIndexOfDecode(d) {
        let lo = 0, hi = this.keyframes.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.keyframes[mid] <= d) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    _gopRange(gopIdx) {
        const start = this.keyframes[gopIdx];
        const end = gopIdx + 1 < this.keyframes.length ? this.keyframes[gopIdx + 1] - 1 : this.samples.length - 1;
        return [start, end];
    }

    _frameOfTimestamp(ts) {
        const f = this.tsToFrame.get(Math.round(ts));
        if (f !== undefined) return f;
        // Fallback: nearest cts (should be rare — timestamps round-trip exactly in practice).
        let best = -1, bestDiff = Infinity;
        for (const [k, v] of this.tsToFrame) {
            const d = Math.abs(k - ts);
            if (d < bestDiff) { bestDiff = d; best = v; }
        }
        return best;
    }

    _ensureDecoder(onOutput, onError) {
        if (this.decoder && this.decoder.state !== 'closed') {
            this._onOutput = onOutput; this._onError = onError;
            return;
        }
        this._onOutput = onOutput; this._onError = onError;
        this.decoder = new VideoDecoder({
            output: (frame) => { this.stats.decoded++; this._onOutput && this._onOutput(frame); },
            error: (e) => { this._onError && this._onError(e); },
        });
        this.decoder.configure(this.config);
    }

    _resetDecoder() {
        if (this.decoder) { try { this.decoder.close(); } catch (e) { /* ignore */ } }
        this.decoder = null;
        this._stream = null;
    }

    _run(fn) {
        const p = this._queue.then(fn, fn);
        this._queue = p.catch(() => {});
        return p;
    }

    // ------------------------------------------------------ interactive path

    /**
     * Get frame `frameIdx` as an ImageBitmap (cached). Returns null if out of range.
     * @returns {Promise<{bitmap: ImageBitmap, fromCache: boolean}|null>}
     */
    async getFrame(frameIdx) {
        if (this._closed || frameIdx < 0 || frameIdx >= this.samples.length) return null;
        this._pinned = frameIdx;   // never evict the frame the caller is about to draw
        const hit = this._cacheGet(frameIdx);
        if (hit) return { bitmap: hit, fromCache: true };
        return this._run(async () => {
            const again = this._cacheGet(frameIdx);
            if (again) return { bitmap: again, fromCache: true };
            await this._decodeForDisplay(frameIdx);
            const bmp = this._cacheGet(frameIdx);
            return bmp ? { bitmap: bmp, fromCache: false } : null;
        });
    }

    /**
     * Streaming display decode. The decoder is kept OPEN between calls: when the
     * requested frame is ahead of the last chunk we fed (playback, stepping), only
     * the missing chunks are fed — one decode per frame instead of a decode from
     * the keyframe. A backward or far seek restarts at the preceding keyframe.
     * We never flush() (that would force a keyframe restart); if the target output
     * has not arrived after `STREAM_WAIT_MS` we flush once and restart next time.
     */
    async _decodeForDisplay(frameIdx) {
        const d = this.presentation[frameIdx];
        const gop = this._gopIndexOfDecode(d);
        const [gopStart] = this._gopRange(gop);
        const last = this.samples.length - 1;
        // Continue the open stream when the wanted PRESENTATION frame has not been emitted yet
        // (outputs arrive in presentation order regardless of B-frame decode order).
        const st = this._stream;
        const canContinue = st && this.decoder && this.decoder.state === 'configured' &&
            frameIdx >= st.nextOut && frameIdx - st.nextOut <= MAX_STREAM_GAP && st.nextDecode <= last;
        if (!canContinue) {
            this._stream = { nextDecode: gopStart, nextOut: this.frameOfDecode[gopStart] };
            this.stats.restarts++;
        }
        if (this._reorderFeed === undefined) this._reorderFeed = this.hasBFrames ? REORDER_FEED : 1;
        const reorder = this._reorderFeed;   // learned: grows when the decoder holds frames longer than expected
        // Keep everything the decoder will emit from the target onwards (lookahead + reorder
        // depth): those are the frames playback asks for next, and discarding them would
        // force a restart from the keyframe.
        const keepLo = frameIdx, keepHi = Math.min(last, frameIdx + this.lookahead);
        this._keepLo = keepLo; this._keepHi = Math.min(last, keepHi + reorder + 2);
        this._installDisplayHandler();
        let waiter;
        const arrived = new Promise((resolve) => { waiter = resolve; });
        this._waiters.set(frameIdx, waiter);
        try {
            // Feed at least up to the target's chunk (+ reorder depth); if the decoder still holds
            // the frame, feed a few more chunks; only flush when the stream has no chunks left.
            let feedTo = Math.min(last, Math.max(this.presentation[frameIdx], this.presentation[keepHi]) + reorder);
            let done = false;
            const tStart = performance.now();
            while (!done) {
                if (this._stream.nextDecode <= feedTo) {
                    const from = this._stream.nextDecode;
                    const tr = performance.now();
                    const data = await this.readSampleRange(from, feedTo);
                    this.stats.readMs += performance.now() - tr;
                    for (let i = from; i <= feedTo; i++) {
                        const smp = this.samples[i];
                        this.decoder.decode(new EncodedVideoChunk({
                            type: smp.isKeyframe ? 'key' : 'delta', timestamp: smp.cts, duration: smp.duration, data: data[i - from],
                        }));
                    }
                    this._stream.nextDecode = feedTo + 1;
                }
                const tw = performance.now();
                const got = await Promise.race([arrived, new Promise(r => setTimeout(() => r('timeout'), STREAM_WAIT_MS))]);
                this.stats.waitMs += performance.now() - tw;
                if (got !== 'timeout') { done = true; break; }
                // Still chewing through queued chunks (big restart under load): keep waiting, don't feed more.
                if (this.decoder && this.decoder.decodeQueueSize > 0) { if (performance.now() - tStart > 60000) throw new Error('decoder stalled'); continue; }
                this.stats.timeouts++;
                if (this._stream.nextDecode <= last) {
                    // Decoder output delay is deeper than assumed: feed more now and remember for next time.
                    this._reorderFeed = Math.min(16, this._reorderFeed + 4);
                    this._keepHi = Math.min(last, keepHi + this._reorderFeed + 2);
                    feedTo = Math.min(last, this._stream.nextDecode + 4);
                } else {
                    try { await this.decoder.flush(); } catch (_) { /* handled by error cb */ }
                    this._stream = null;
                    await Promise.race([arrived, new Promise(r => setTimeout(r, 200))]);
                    done = true;
                }
            }
        } catch (e) {
            this._waiters.delete(frameIdx);
            this._resetDecoder();
            throw e;
        }
        this._waiters.delete(frameIdx);
    }

    /** Route decoder outputs for the display path: bitmap wanted frames, close the rest. */
    _installDisplayHandler() {
        this._ensureDecoder((frame) => {
            const f = this._frameOfTimestamp(frame.timestamp);
            if (this._stream) this._stream.nextOut = f + 1;
            const w = this._waiters.get(f);
            if (f >= this._keepLo && f <= this._keepHi && !this.cache.has(f)) {
                const opts = this.bitmapScale < 1
                    ? { resizeWidth: Math.round(frame.displayWidth * this.bitmapScale), resizeHeight: Math.round(frame.displayHeight * this.bitmapScale), resizeQuality: 'low' }
                    : undefined;
                const tb = performance.now();
                createImageBitmap(frame, opts).then((bmp) => {
                    this.stats.bitmapMs += performance.now() - tb;
                    this._cachePut(f, bmp);
                    this.stats.bitmapped++;
                    if (w) w(true);
                }).catch(() => { if (w) w(false); }).finally(() => frame.close());
            } else {
                frame.close();
                if (w) w(false);
            }
        }, (e) => {
            this.log(`${this.name}: decoder error: ${e.message || e}`, 'warn');
            this._resetDecoder();
            for (const w of this._waiters.values()) w(false);
            this._waiters.clear();
        });
    }

    /** Invalidate the open display stream (batch decode or errors). */
    _closeStream() {
        this._stream = null;
        this._keepLo = -1; this._keepHi = -1;
        for (const w of this._waiters.values()) w(false);
        this._waiters.clear();
    }

    _cacheGet(f) {
        const b = this.cache.get(f);
        if (!b) return null;
        this.cache.delete(f); this.cache.set(f, b);   // refresh LRU position
        return b;
    }

    _cachePut(f, bmp) {
        if (this.cache.has(f)) { this.cache.get(f).close(); this.cache.delete(f); }
        while (this.cache.size >= this.cacheSize) {
            let victim = null;
            for (const k of this.cache.keys()) { if (k !== this._pinned) { victim = k; break; } }
            if (victim === null) break;
            this.cache.get(victim).close();
            this.cache.delete(victim);
        }
        this.cache.set(f, bmp);
    }

    // ------------------------------------------------------------ batch path

    /**
     * Sequentially decode exactly the frames in `frames` (any order; deduped)
     * in one pass. Yields {frame, videoFrame} in ascending frame order; the
     * CONSUMER MUST call videoFrame.close(). Feeding is paused while more than
     * `maxPending` wanted frames are waiting to be consumed.
     *
     * @param {Iterable<number>} frames
     * @param {{maxPending?:number, signal?:AbortSignal}} [opts]
     */
    async *iterateFrames(frames, opts = {}) {
        const maxPending = opts.maxPending ?? 3;
        const signal = opts.signal;
        const wanted = Array.from(new Set(frames)).filter(f => f >= 0 && f < this.samples.length).sort((a, b) => a - b);
        if (wanted.length === 0) return;

        // Group wanted frames by GOP (in decode order of their keyframes).
        const byGop = new Map();
        for (const f of wanted) {
            const d = this.presentation[f];
            const g = this._gopIndexOfDecode(d);
            let entry = byGop.get(g);
            if (!entry) { entry = { maxDecode: d, frames: new Set() }; byGop.set(g, entry); }
            entry.frames.add(f);
            if (d > entry.maxDecode) entry.maxDecode = d;
        }
        const gops = Array.from(byGop.keys()).sort((a, b) => a - b);

        for (const g of gops) {
            if (signal?.aborted) return;
            const entry = byGop.get(g);
            const [gopStart, gopEnd] = this._gopRange(g);
            const end = this.hasBFrames ? gopEnd : Math.min(gopEnd, entry.maxDecode);
            // Serialize with interactive decodes: acquire the queue for this GOP.
            let release;
            const held = new Promise(r => { release = r; });
            const acquired = new Promise(r => { this._queue = this._queue.then(() => { r(); return held; }, () => { r(); return held; }); });
            await acquired;
            try {
                yield* this._iterateGop(gopStart, end, entry.frames, maxPending, signal);
            } finally {
                release();
            }
            this.stats.gops++;
        }
    }

    async *_iterateGop(gopStart, end, wantedSet, maxPending, signal) {
        this._closeStream();
        const data = await this.readSampleRange(gopStart, end);
        const pending = [];     // {frame, videoFrame} awaiting yield
        const outOfOrder = [];  // wanted frames that arrived early (B-frames): sort before yield
        let flushDone = false, error = null, notify = null;
        const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
        const waitEvent = () => new Promise(r => { notify = r; });

        this._ensureDecoder((frame) => {
            const f = this._frameOfTimestamp(frame.timestamp);
            if (wantedSet.has(f)) {
                wantedSet.delete(f);
                pending.push({ frame: f, videoFrame: frame });
            } else {
                frame.close();
            }
            wake();
        }, (e) => { error = e; this._resetDecoder(); wake(); });
        this.decoder.ondequeue = wake;

        let i = gopStart;
        let flushStarted = false;
        try {
            while (true) {
                if (error) throw error;
                if (signal?.aborted) break;
                if (pending.length) {
                    // Yield in ascending presentation order for what we have.
                    pending.sort((a, b) => a.frame - b.frame);
                    const item = pending.shift();
                    yield item;
                    continue;
                }
                if (i <= end) {
                    if (this.decoder.decodeQueueSize < 6 && pending.length < maxPending) {
                        const s = this.samples[i];
                        this.decoder.decode(new EncodedVideoChunk({
                            type: s.isKeyframe ? 'key' : 'delta', timestamp: s.cts, duration: s.duration, data: data[i - gopStart],
                        }));
                        i++;
                        continue;
                    }
                    await waitEvent();
                    continue;
                }
                if (!flushStarted) {
                    flushStarted = true;
                    this.decoder.flush().then(() => { flushDone = true; wake(); }, (e) => { error = e; wake(); });
                }
                if (flushDone) break;
                await waitEvent();
            }
        } finally {
            for (const p of pending) p.videoFrame.close();
            if (this.decoder) this.decoder.ondequeue = null;
            if (signal?.aborted) this._resetDecoder();
        }
        void outOfOrder;
    }

    // ----------------------------------------------------------------- misc

    close() {
        this._closed = true;
        this._gopBuf = null;
        this._resetDecoder();
        for (const b of this.cache.values()) b.close();
        this.cache.clear();
    }
}

function getCodecDescription(trak) {
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (box) {
            const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
            box.write(stream);
            return new Uint8Array(stream.buffer, 8);
        }
    }
    return null;
}

// ==========================================================================
// VideoController — synchronized multi-view display, playback, zoom/pan.
// ==========================================================================

export class VideoController {
    /**
     * @param {object} state app state: views[], currentFrame, totalFrames, fps, isPlaying
     * @param {object} callbacks {onFrameRendered(frame, seekMs), drawOverlays(frame), onPlaybackStateChange(bool), onKey(e)->bool, log}
     */
    constructor(state, callbacks = {}) {
        this.state = state;
        this.callbacks = callbacks;
        this.zoomState = {};
        this._seekChain = Promise.resolve();
        this._pendingSeek = null;
        this._seeking = false;
        this._playTimer = null;
        this._seekSeq = 0;
    }

    /** Seek all views to `frameIdx`, render, draw overlays. Coalesces rapid calls. */
    seekToFrame(frameIdx) {
        if (!this.state.views.length) return Promise.resolve();
        frameIdx = Math.max(0, Math.min(frameIdx | 0, this.state.totalFrames - 1));
        this.state.currentFrame = frameIdx;
        this._pendingSeek = frameIdx;
        if (this._seeking) return this._seekChain;
        this._seekChain = this._drain();
        return this._seekChain;
    }

    async _drain() {
        this._seeking = true;
        try {
            while (this._pendingSeek !== null) {
                const target = this._pendingSeek;
                this._pendingSeek = null;
                const t0 = performance.now();
                const results = await Promise.all(this.state.views.map(v => v.decoder.getFrame(target)));
                // If a newer seek arrived, skip rendering this one.
                if (this._pendingSeek !== null && this._pendingSeek !== target) continue;
                for (let i = 0; i < this.state.views.length; i++) {
                    const view = this.state.views[i];
                    const r = results[i];
                    if (r && r.bitmap) {
                        try {
                            view.ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
                            view.ctx.drawImage(r.bitmap, 0, 0, view.canvas.width, view.canvas.height);
                            view.lastBitmap = r.bitmap;
                        } catch (e) { /* bitmap evicted between fetch and draw: keep the previous image */ }
                    }
                }
                this.state.currentFrame = target;
                this.callbacks.drawOverlays && this.callbacks.drawOverlays(target);
                this.callbacks.onFrameRendered && this.callbacks.onFrameRendered(target, performance.now() - t0);
            }
        } finally {
            this._seeking = false;
        }
    }

    /** Redraw the current frame's cached bitmaps + overlays without decoding (e.g. overlay toggles). */
    redraw() {
        for (const view of this.state.views) {
            if (view.lastBitmap) {
                view.ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
                try { view.ctx.drawImage(view.lastBitmap, 0, 0, view.canvas.width, view.canvas.height); } catch (e) { /* bitmap may be closed */ }
            }
        }
        this.callbacks.drawOverlays && this.callbacks.drawOverlays(this.state.currentFrame);
    }

    // ---- playback
    togglePlayback() { this.state.isPlaying ? this.stopPlayback() : this.startPlayback(); }

    startPlayback() {
        if (!this.state.views.length || this.state.isPlaying) return;
        this.state.isPlaying = true;
        this.callbacks.onPlaybackStateChange && this.callbacks.onPlaybackStateChange(true);
        const interval = 1000 / (this.state.fps || 30);
        let busy = false;
        this._playTimer = setInterval(async () => {
            if (busy) return;
            busy = true;
            let next = this.state.currentFrame + 1;
            if (next >= this.state.totalFrames) next = 0;
            await this.seekToFrame(next);
            busy = false;
        }, interval);
    }

    stopPlayback() {
        this.state.isPlaying = false;
        if (this._playTimer) { clearInterval(this._playTimer); this._playTimer = null; }
        this.callbacks.onPlaybackStateChange && this.callbacks.onPlaybackStateChange(false);
    }

    // ---- seekbar
    setupSeekbar(seekbar, updateVisual) {
        let scrubbing = false;
        const frameAt = (e) => {
            const rect = seekbar.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            return Math.round((x / rect.width) * Math.max(0, this.state.totalFrames - 1));
        };
        seekbar.addEventListener('mousedown', (e) => {
            e.preventDefault();
            scrubbing = true;
            document.body.style.userSelect = 'none';
            const f = frameAt(e);
            updateVisual && updateVisual(f);
            this.seekToFrame(f);
        });
        document.addEventListener('mousemove', (e) => {
            if (!scrubbing) return;
            const f = frameAt(e);
            updateVisual && updateVisual(f);
            this.seekToFrame(f);
        });
        document.addEventListener('mouseup', () => {
            if (scrubbing) document.body.style.userSelect = '';
            scrubbing = false;
        });
    }

    // ---- keyboard
    setupKeyboardHandlers() {
        document.addEventListener('keydown', (e) => {
            if (!this.state.views.length) return;
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            if (this.callbacks.onKey && this.callbacks.onKey(e)) { e.preventDefault(); return; }
            let delta = 0;
            switch (e.key) {
                case 'ArrowLeft': delta = -1; break;
                case 'ArrowRight': delta = 1; break;
                case 'ArrowUp': delta = 10; break;
                case 'ArrowDown': delta = -10; break;
                case ' ': this.togglePlayback(); e.preventDefault(); return;
                case 'Home': this.seekToFrame(0); e.preventDefault(); return;
                case 'End': this.seekToFrame(this.state.totalFrames - 1); e.preventDefault(); return;
                case '+': case '=': this.zoomAll(1.2); e.preventDefault(); return;
                case '-': case '_': this.zoomAll(1 / 1.2); e.preventDefault(); return;
                case '0': this.resetAllZoom(); e.preventDefault(); return;
                default: break;
            }
            if (delta !== 0) { this.seekToFrame(this.state.currentFrame + delta); e.preventDefault(); }
        });
    }

    // ---- zoom / pan (CSS transform on the canvas)
    _zs(name) {
        if (!this.zoomState[name]) this.zoomState[name] = { scale: 1, panX: 0, panY: 0 };
        return this.zoomState[name];
    }

    applyZoom(name) {
        const view = this.state.views.find(v => v.name === name);
        if (!view) return;
        const zs = this._zs(name);
        const cell = view.canvas.closest('.video-cell');
        if (cell) cell.classList.toggle('zoomed', zs.scale > 1);
        view.canvas.style.transform = `scale(${zs.scale}) translate(${zs.panX}px, ${zs.panY}px)`;
    }

    zoomView(name, factor) {
        const zs = this._zs(name);
        zs.scale = Math.max(1, Math.min(10, zs.scale * factor));
        if (zs.scale === 1) { zs.panX = 0; zs.panY = 0; }
        this.applyZoom(name);
    }

    zoomAll(factor) { for (const v of this.state.views) this.zoomView(v.name, factor); }

    resetAllZoom() {
        for (const v of this.state.views) { this.zoomState[v.name] = { scale: 1, panX: 0, panY: 0 }; this.applyZoom(v.name); }
    }

    setupZoomHandlers(name, canvas) {
        const cell = canvas.closest('.video-cell');
        this._zs(name);
        cell.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.zoomView(name, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        }, { passive: false });
        let panning = false, sx = 0, sy = 0, px0 = 0, py0 = 0;
        cell.addEventListener('mousedown', (e) => {
            const zs = this._zs(name);
            if (zs.scale > 1) {
                panning = true; cell.classList.add('panning');
                sx = e.clientX; sy = e.clientY; px0 = zs.panX; py0 = zs.panY;
                e.preventDefault();
            }
        });
        document.addEventListener('mousemove', (e) => {
            if (!panning) return;
            const zs = this._zs(name);
            const view = this.state.views.find(v => v.name === name);
            const rect = canvas.getBoundingClientRect();
            const cssScale = rect.width / (view.canvas.width * zs.scale);
            const dx = (e.clientX - sx) / zs.scale / cssScale;
            const dy = (e.clientY - sy) / zs.scale / cssScale;
            const maxX = view.canvas.width * (1 - 1 / zs.scale) / 2;
            const maxY = view.canvas.height * (1 - 1 / zs.scale) / 2;
            zs.panX = Math.max(-maxX, Math.min(maxX, px0 + dx));
            zs.panY = Math.max(-maxY, Math.min(maxY, py0 + dy));
            this.applyZoom(name);
        });
        document.addEventListener('mouseup', () => { if (panning) { panning = false; cell.classList.remove('panning'); } });
        cell.addEventListener('dblclick', (e) => {
            this.zoomState[name] = { scale: 1, panX: 0, panY: 0 };
            this.applyZoom(name);
            e.preventDefault();
        });
    }
}
