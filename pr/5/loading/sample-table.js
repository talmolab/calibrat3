/**
 * loading/sample-table.js — an MP4's sample table (every frame's byte offset, size,
 * timing and keyframe flag) through mp4box.js, reading as little of the file as it can.
 *
 * A regular MP4 lists every sample in its moov box: reading stops as soon as mp4box
 * has parsed it (onReady). A FRAGMENTED MP4 (moov with an empty sample table, then
 * moof+mdat pairs — what campy writes by default, so that a video survives a crash,
 * and what ffmpeg writes with -movflags frag_keyframe/empty_moov) lists its samples
 * in each fragment's moof. Stopping at onReady there kept only the fragments in the
 * first chunk: a 20 s, 60 fps campy video (40 fragments) loaded as 420 frames.
 * So for a fragmented file the rest of the file is walked box by box and mp4box is
 * given every moof, but only the HEADER of each mdat: it then seeks past the payload,
 * which is never kept. Reads go through a window of `chunkSize` bytes, so a file of
 * small fragments is read in chunks as before, and the payload of a fragment larger
 * than the window is skipped without being read. A file cut short (a crash) keeps
 * the samples whose bytes are all there (completeSamples): its moof can list frames
 * of an mdat that was cut off.
 *
 * Pure: no DOM, no WebCodecs. MP4Box (the vendored mp4box.js global) and
 * readBytes(offset, size) -> ArrayBuffer are passed in, so Node tests can run it.
 */

export const CHUNK_SIZE = 1024 * 1024;

/**
 * @param {object} MP4Box  mp4box.js namespace
 * @param {(offset:number, size:number) => Promise<ArrayBuffer>} readBytes
 * @param {number} fileSize
 * @returns {Promise<{mp4, info, fragmented:boolean}>} the mp4box file (all samples
 *   parsed), its getInfo() from onReady, and whether the file is fragmented
 */
export async function readSampleTable(MP4Box, readBytes, fileSize, { chunkSize = CHUNK_SIZE } = {}) {
    const mp4 = MP4Box.createFile();
    const ready = new Promise((resolve, reject) => {
        mp4.onError = (e) => reject(new Error(`mp4box: ${e}`));
        mp4.onReady = resolve;
    });
    let resolved = false;
    ready.then(() => { resolved = true; }, () => { resolved = true; });
    let offset = 0;
    let first = null;   // the first chunk: where the walk over the fragments starts
    while (offset < fileSize && !resolved) {
        const buf = await readBytes(offset, Math.min(chunkSize, fileSize - offset));
        if (offset === 0) first = new Uint8Array(buf.slice(0));
        buf.fileStart = offset;
        const next = mp4.appendBuffer(buf);
        offset = (next === undefined) ? offset + buf.byteLength : next;
        await new Promise(r => setTimeout(r, 0));
    }
    const info = await ready;
    const fragmented = !!info.isFragmented;
    if (fragmented && offset < fileSize) await appendFragments(mp4, readBytes, fileSize, offset, chunkSize, first);
    return { mp4, info, fragmented };
}

/**
 * Gives mp4box the boxes after `fed` (bytes it already has): each whole, except an
 * mdat, of which only its header.
 */
async function appendFragments(mp4, readBytes, fileSize, fed, windowSize, first) {
    let win = first, winStart = 0;   // the boxes' headers in the first chunk are not read again
    // n bytes at start (fewer at the end of the file), from the window, read anew
    // when they are not all in it
    const bytesAt = async (start, n) => {
        n = Math.min(n, fileSize - start);
        if (!win || start < winStart || start + n > winStart + win.byteLength) {
            winStart = start;
            win = new Uint8Array(await readBytes(start, Math.min(Math.max(n, windowSize), fileSize - start)));
        }
        return win.subarray(start - winStart, start - winStart + n);
    };
    let pos = 0;
    while (pos + 8 <= fileSize) {
        const h = await bytesAt(pos, 16);
        const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
        let size = view.getUint32(0), hdr = 8;
        const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
        if (size === 1) {
            if (h.byteLength < 16) break;
            size = Number(view.getBigUint64(8)); hdr = 16;
        } else if (size === 0) {
            size = fileSize - pos;   // to the end of the file
        }
        if (size < hdr) break;       // not a box: the file is damaged here
        const end = Math.min(pos + size, fileSize);
        if (end > fed) {
            const from = Math.max(pos, fed);
            const n = type === 'mdat' ? Math.max(0, Math.min(pos + hdr, end) - from) : end - from;
            if (n > 0) {
                const buf = (await bytesAt(from, n)).slice().buffer;
                buf.fileStart = from;
                mp4.appendBuffer(buf);
            }
        }
        pos += size;   // no setTimeout here: each box would wait >= 4 ms in a browser; reads yield
    }
}

/**
 * The samples whose bytes are all in the file: a decode-order prefix, so every one
 * decodes. A file cut inside an mdat (campy or ffmpeg stopped mid-fragment) has a
 * moof listing frames past its end.
 */
export function completeSamples(samples, fileSize) {
    let n = samples.length;
    while (n > 0 && samples[n - 1].offset + samples[n - 1].size > fileSize) n--;
    return n === samples.length ? samples : samples.slice(0, n);
}

/**
 * The track's duration in seconds: its header's, or for a fragmented file (whose
 * header says 0) the sum of its samples' durations.
 */
export function trackDurationSec(track, samples) {
    if (track.duration > 0 && track.timescale > 0) return track.duration / track.timescale;
    if (!samples || samples.length === 0 || !(track.timescale > 0)) return 0;
    let total = 0;
    for (const s of samples) total += s.duration;
    return total / track.timescale;
}
