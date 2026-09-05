import { test, run, assert } from './harness.mjs';
import { DetectionStore } from '../calib/detection-store.js';
import { buildCovisibilityGraph, findPoseChain, pairFrames, pathToRoot } from '../calib/covisibility.js';

function det(ids) { return { ids: Int32Array.from(ids), corners: new Float32Array(ids.length * 2), numMarkers: 0, ms: 0 }; }
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

function build() {
    // 4 cameras. A-B share lots, B-C share some, C-D share some, A-D share nothing.
    const s = new DetectionStore(['A', 'B', 'C', 'D']);
    for (let f = 0; f < 30; f++) {
        s.set(f, 0, det(range(0, 30)));
        s.set(f, 1, det(range(10, 40)));                 // 20 common with A
        if (f % 3 === 0) s.set(f, 2, det(range(25, 50)));  // 15 common with B, 5 with A
        if (f % 5 === 0) s.set(f, 3, det(range(40, 60)));  // 10 common with C
    }
    return s;
}

test('graph counts pairs with >= minCovisible common ids', () => {
    const g = buildCovisibilityGraph(build(), 10);
    assert.equal(g.pairCounts[0][1], 30);
    assert.equal(g.pairCounts[1][2], 10);
    assert.equal(g.pairCounts[0][2], 0);   // only 5 common < 10
    assert.equal(g.pairCounts[2][3], 2);   // f = 0, 15
    assert.equal(g.pairCounts[0][3], 0);
    assert.equal(g.pairCounts[1][0], 30);  // symmetric
    assert.equal(pairFrames(g, 2, 1).length, 10);
    assert.deepEqual(Array.from(pairFrames(g, 1, 2)[0].commonIds).slice(0, 3), [25, 26, 27]);
});

test('excluded frames are skipped', () => {
    const g = buildCovisibilityGraph(build(), 10, new Set([0, 15]));
    assert.equal(g.pairCounts[2][3], 0);
    assert.equal(g.pairCounts[0][1], 28);
});

test('pose chain via BFS from reference, unreachable reported', () => {
    const g = buildCovisibilityGraph(build(), 10);
    const chain = findPoseChain(g, 0);
    assert.equal(chain.parent[0], null);
    assert.equal(chain.parent[1], 0);
    assert.equal(chain.parent[2], 1);
    assert.equal(chain.parent[3], 2);
    assert.deepEqual(chain.unreachable, []);
    assert.deepEqual(pathToRoot(chain.parent, 3), [0, 1, 2, 3]);
    const g2 = buildCovisibilityGraph(build(), 12);   // C-D drops (10 common < 12)
    const c2 = findPoseChain(g2, 0);
    assert.deepEqual(c2.unreachable, [3]);
    assert.equal(c2.parent[3], -1);
});

run();
