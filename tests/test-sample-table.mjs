/**
 * tests/test-sample-table.mjs — loading/sample-table.js on real MP4s, with the
 * vendored mp4box.js (a classic script: evaluated in global scope, as index.html
 * loads it).
 *
 * tests/data/fragmented-60fps.mp4 and regular-60fps.mp4: the same 4 s of
 * testsrc2 at 60 fps (240 frames, a keyframe every 30, libx264 with B-frames), 64x48.
 *   ffmpeg -f lavfi -i testsrc2=size=64x48:rate=60 -t 4 -c:v libx264 -preset veryfast -g 30 -pix_fmt yuv420p \
 *     -movflags +frag_keyframe+empty_moov+delay_moov+default_base_moof -frag_duration 1000000 fragmented-60fps.mp4
 *   ... -movflags +faststart regular-60fps.mp4
 * The fragmented one is muxed as campy writes its videos: 8 fragments, an empty moov.
 */
import { test, run, assert, approx, loadText, loadBytes } from './harness.mjs';
import { readSampleTable, completeSamples, trackDurationSec } from '../loading/sample-table.js';

if (!globalThis.MP4Box) (0, eval)(await loadText('lib/mp4box/mp4box.all.min.js'));   // indirect: global scope
globalThis.Log?.setLogLevel?.(globalThis.Log.error);
const MP4Box = globalThis.MP4Box;

const clips = {};
const clip = async (name) => (clips[name] ||= await loadBytes(`tests/data/${name}`));
const u32 = (data, p) => new DataView(data.buffer, data.byteOffset + p, 4).getUint32(0);

// readBytes over a Uint8Array, counting what is read
function reader(data) {
    const r = {
        bytesRead: 0, reads: 0,
        read: async (offset, size) => {
            const end = Math.min(offset + size, data.length);
            r.bytesRead += end - offset; r.reads++;
            return data.buffer.slice(data.byteOffset + offset, data.byteOffset + end);
        },
    };
    return r;
}

async function load(data, chunkSize) {
    const r = reader(data);
    const { mp4, info, fragmented } = await readSampleTable(MP4Box, r.read, data.length, { chunkSize });
    const track = info.videoTracks[0];
    const samples = completeSamples(mp4.getTrackSamplesInfo(track.id), data.length);   // as video.js
    const duration = trackDurationSec(track, samples);
    return { r, info, fragmented, track, samples, duration, fps: samples.length / duration };
}

// Each sample's bytes are an H.264 access unit: length-prefixed NAL units that fill it exactly
function samplesAreWhole(data, samples) {
    return samples.every(s => {
        let p = s.offset;
        const end = s.offset + s.size;
        while (p < end) p += 4 + u32(data, p);
        return p === end;
    });
}

test('a fragmented MP4 gives every frame of every fragment, and its fps from the samples', async () => {
    const data = await clip('fragmented-60fps.mp4');
    // A 4 KiB first chunk holds the moov and the first fragment only, as 1 MiB
    // holds 14 of the 40 fragments of a 20 s campy video at 1280x1024
    const v = await load(data, 4096);
    assert.equal(v.fragmented, true);
    assert.equal(v.track.duration, 0);   // what the header says: why fps used to fall back to 30
    assert.equal(v.samples.length, 240);
    assert.equal(v.samples.filter(s => s.is_sync).length, 8);
    approx(v.duration, 4, 1e-9);
    approx(v.fps, 60, 0.01);
    assert.ok(samplesAreWhole(data, v.samples), 'sample offsets and sizes point at whole access units');
});

test('the same with the default 1 MiB chunk (the whole file in the first chunk)', async () => {
    const v = await load(await clip('fragmented-60fps.mp4'));
    assert.equal(v.samples.length, 240);
    approx(v.fps, 60, 0.01);
});

test('fragment payloads larger than the read window are skipped, not read', async () => {
    const data = await clip('fragmented-60fps.mp4');
    const v = await load(data, 256);   // every mdat here is larger than 256 bytes
    assert.equal(v.samples.length, 240);
    assert.ok(samplesAreWhole(data, v.samples));
    // each fragment costs a 256-byte read at its moof and one at its mdat header; the rest of each payload is skipped
    assert.ok(v.r.bytesRead < data.length * 0.6, `read ${v.r.bytesRead} of ${data.length} bytes`);
});

test('a regular MP4 stops at its moov, as before', async () => {
    const data = await clip('regular-60fps.mp4');
    const v = await load(data, 4096);
    assert.equal(v.fragmented, false);
    assert.equal(v.samples.length, 240);
    assert.ok(v.track.duration > 0);
    approx(v.fps, 60, 0.01);
    assert.equal(v.r.reads, 1);
    assert.ok(samplesAreWhole(data, v.samples));
});

test('a fragmented MP4 cut short (a crash) gives the frames whose bytes are all there', async () => {
    const full = await clip('fragmented-60fps.mp4');
    for (const share of [0.3, 0.6, 0.9]) {
        const data = full.subarray(0, Math.floor(full.length * share));
        const v = await load(data, 4096);
        assert.ok(v.samples.length > 0 && v.samples.length < 240, `${share}: ${v.samples.length} frames`);
        assert.ok(v.samples.every(s => s.offset + s.size <= data.length), `${share}: a frame past the end`);
        assert.ok(samplesAreWhole(data, v.samples), `${share}: sample bytes`);
        approx(v.fps, 60, 0.01);
    }
});

test('completeSamples keeps the decode-order prefix that is in the file', () => {
    const s = [{ offset: 0, size: 10 }, { offset: 10, size: 10 }, { offset: 20, size: 10 }];
    assert.equal(completeSamples(s, 30), s);
    assert.deepEqual(completeSamples(s, 25), s.slice(0, 2));
    assert.deepEqual(completeSamples(s, 5), []);
});

test('trackDurationSec: the header duration when there is one', () => {
    assert.equal(trackDurationSec({ duration: 6000, timescale: 1500 }, [{ duration: 1 }]), 4);
    assert.equal(trackDurationSec({ duration: 0, timescale: 15360 }, [{ duration: 256 }, { duration: 256 }]), 512 / 15360);
    assert.equal(trackDurationSec({ duration: 0, timescale: 15360 }, []), 0);
});

await run();
