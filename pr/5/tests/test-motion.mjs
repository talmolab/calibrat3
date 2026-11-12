import { test, run, assert, approx } from './harness.mjs';
import { DetectionStore } from '../calib/detection-store.js';
import { boardMotionScores, framesAboveMotion, motionSummary } from '../calib/motion.js';

// Two cameras; the board translates by `dx` px per frame in camera 0 and 2*dx in camera 1.
function store(frames, dxPerFrame) {
    const s = new DetectionStore(['a', 'b']);
    for (const f of frames) {
        for (const v of [0, 1]) {
            const ids = [0, 1, 2, 3, 4, 5, 6, 7];
            const xy = [];
            for (const id of ids) xy.push(100 + id * 10 + f * dxPerFrame * (v + 1), 50 + id * 5);
            s.set(f, v, { ids: Int32Array.from(ids), corners: Float32Array.from(xy), numMarkers: 4, ms: 0 });
        }
    }
    return s;
}

test('motion score = mean corner displacement per frame step, max over cameras', () => {
    const s = store([0, 3, 6, 9], 2);   // stride 3, 2 px/frame in cam a, 4 px/frame in cam b
    const m = boardMotionScores(s);
    approx(m.get(3), 4, 1e-6);
    approx(m.get(0), 4, 1e-6);    // only one neighbour, still defined
    assert.equal(m.size, 4);
});

test('frames with too few corners or missing neighbours get NaN and are kept by the filter', () => {
    const s = store([0, 1, 2], 1);
    s.set(1, 0, { ids: Int32Array.from([0, 1]), corners: Float32Array.from([0, 0, 1, 1]) });   // cam a: too few corners
    const m = boardMotionScores(s);
    approx(m.get(1), 2, 1e-6);    // cam b still gives 2 px/frame
    const lone = new DetectionStore(['a', 'b']);
    lone.set(5, 0, { ids: Int32Array.from([0, 1, 2, 3, 4, 5]), corners: new Float32Array(12) });
    assert.ok(Number.isNaN(boardMotionScores(lone).get(5)));
    assert.equal(framesAboveMotion(boardMotionScores(lone), 1).size, 0);
});

test('framesAboveMotion / motionSummary', () => {
    const s = store([0, 1, 2, 3, 4], 3);   // 3 and 6 px/frame -> max 6 everywhere
    const m = boardMotionScores(s);
    assert.equal(framesAboveMotion(m, 5).size, 5);
    assert.equal(framesAboveMotion(m, 7).size, 0);
    assert.equal(framesAboveMotion(m, 0).size, 0);   // 0 = off
    const sum = motionSummary(m);
    assert.equal(sum.n, 5);
    approx(sum.median, 6, 1e-6);
    assert.equal(motionSummary(new Map()), null);
});

run();
