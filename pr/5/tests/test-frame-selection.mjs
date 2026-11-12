import { test, run, assert } from './harness.mjs';
import { selectFramesForCoverage, coverageFraction, stridedFrames } from '../calib/frame-selection.js';

const size = { width: 800, height: 600 };
// A board detection as a 5x5 cluster of corners around (cx, cy)
function sample(frame, cx, cy, spread = 40) {
    const pts = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push(cx + (i - 2) * spread / 2, cy + (j - 2) * spread / 2);
    return { frame, ids: Int32Array.from(pts.map((_, k) => k)), corners: Float32Array.from(pts) };
}

test('stridedFrames', () => {
    assert.deepEqual(stridedFrames(10, 5), { frames: [0, 2, 4, 6, 8], stride: 2 });
    assert.deepEqual(stridedFrames(10, 100).frames.length, 10);
    assert.equal(stridedFrames(1000, 50).stride, 20);
});

test('returns all frames when under the cap', () => {
    const s = [sample(3, 100, 100), sample(1, 200, 200)];
    assert.deepEqual(selectFramesForCoverage(s, size, { maxFrames: 10 }), [1, 3]);
});

test('greedy selection prefers spatially spread frames', () => {
    const samples = [];
    // 50 near-identical frames in one corner
    for (let f = 0; f < 50; f++) samples.push(sample(f, 120 + (f % 3), 110 + (f % 2)));
    // 4 frames in other regions
    samples.push(sample(100, 700, 100), sample(101, 700, 500), sample(102, 100, 500), sample(103, 400, 300));
    const sel = selectFramesForCoverage(samples, size, { maxFrames: 8, grid: 8 });
    assert.equal(sel.length, 8);
    for (const f of [100, 101, 102, 103]) assert.ok(sel.includes(f), `frame ${f} should be selected`);
    const selSet = new Set(sel);
    const cov = coverageFraction(samples.filter(s => selSet.has(s.frame)), size);
    const covFirst8 = coverageFraction(samples.slice(0, 8), size);
    assert.ok(cov > covFirst8, `coverage ${cov} should beat naive first-8 ${covFirst8}`);
});

test('output is sorted and unique', () => {
    const samples = Array.from({ length: 40 }, (_, f) => sample(f, 50 + f * 15, 50 + (f * 37) % 500));
    const sel = selectFramesForCoverage(samples, size, { maxFrames: 15 });
    assert.equal(sel.length, 15);
    assert.deepEqual(sel, Array.from(new Set(sel)).sort((a, b) => a - b));
});

run();
