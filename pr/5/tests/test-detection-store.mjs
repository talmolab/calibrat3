import { test, run, assert } from './harness.mjs';
import { DetectionStore, b64FromTyped, typedFromB64 } from '../calib/detection-store.js';

function det(ids, xy) { return { ids: Int32Array.from(ids), corners: Float32Array.from(xy), numMarkers: ids.length, ms: 1 }; }

function sample() {
    const s = new DetectionStore(['a', 'b', 'c']);
    s.set(10, 0, det([1, 2, 3, 4], [1, 1, 2, 2, 3, 3, 4, 4]));
    s.set(10, 1, det([3, 4, 5], [30, 30, 40, 40, 50, 50]));
    s.set(10, 2, null);
    s.set(0, 0, det([7], [7, 7]));
    s.touch(20);
    return s;
}

test('basic set/get/count and sorted frames', () => {
    const s = sample();
    assert.deepEqual(s.frames(), [0, 10, 20]);
    assert.equal(s.count(10, 0), 4);
    assert.equal(s.count(10, 2), 0);
    assert.equal(s.count(99, 0), 0);
    assert.equal(s.get(20, 0), null);
    assert.equal(s.size, 3);
    assert.deepEqual(s.framesForView(0, 2), [10]);
});

test('commonIds is a real intersection (not min count)', () => {
    const s = sample();
    assert.deepEqual(Array.from(s.commonIds(10, [0, 1])), [3, 4]);
    assert.deepEqual(Array.from(s.commonIds(10, [0, 1, 2])), []);
    assert.equal(s.commonCount(10), 2);
    assert.equal(s.commonCount(0), 0);
    assert.deepEqual(s.viewsWithMin(10, 3), [0, 1]);
    assert.deepEqual(s.viewsWithMin(10, 4), [0]);
});

test('cornerForId', () => {
    const s = sample();
    assert.deepEqual(s.cornerForId(10, 1, 4), [40, 40]);
    assert.equal(s.cornerForId(10, 1, 99), null);
    assert.equal(s.cornerForId(20, 1, 4), null);
});

test('summary', () => {
    const s = sample();
    const sum = s.summary(3);
    assert.equal(sum.frames, 3);
    assert.equal(sum.framesWithAnyDetection, 2);
    assert.equal(sum.framesAllViewsGood, 0);
    assert.deepEqual(sum.perView, [2, 1, 0]);
});

test('JSON round trip preserves typed arrays', () => {
    const s = sample();
    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const back = DetectionStore.fromJSON(json);
    assert.deepEqual(back.viewNames, ['a', 'b', 'c']);
    assert.deepEqual(back.frames(), [0, 10, 20]);
    assert.ok(back.get(10, 0).ids instanceof Int32Array);
    assert.deepEqual(Array.from(back.get(10, 1).corners), [30, 30, 40, 40, 50, 50]);
    assert.equal(back.count(10, 2), 0);
    assert.equal(back.commonCount(10), 2);
});

test('plain (structured-clone) round trip', () => {
    const s = sample();
    const back = DetectionStore.fromPlain(structuredClone(s.toPlain()));
    assert.deepEqual(back.frames(), [0, 10, 20]);
    assert.equal(back.count(10, 0), 4);
});

test('base64 helpers', () => {
    const f = Float32Array.from([1.5, -2.25, 1e-3]);
    const back = typedFromB64(b64FromTyped(f), Float32Array);
    assert.deepEqual(Array.from(back), Array.from(f));
    const sub = new Int32Array(Int32Array.from([9, 8, 7, 6]).buffer, 4, 2);   // byteOffset != 0
    assert.deepEqual(Array.from(typedFromB64(b64FromTyped(sub), Int32Array)), [8, 7]);
});

run();
