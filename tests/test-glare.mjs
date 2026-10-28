import { test, run, assert } from './harness.mjs';
import { GLARE_OFF, GLARE_LEVELS, normalizeGlare, glareLevel, matchGlareLevel, glareKey, glareActive, describeGlare } from '../calib/glare.js';

test('off reproduces the plain OpenCV detector defaults', () => {
    assert.equal(GLARE_OFF.cellMargin, 0.13);     // DetectorParameters.perspectiveRemoveIgnoredMarginPerCell default
    assert.equal(GLARE_OFF.minMarkers, 2);        // CharucoParameters.minMarkers default
    assert.equal(GLARE_OFF.boardRefine, false);
    assert.equal(GLARE_OFF.gamma, 1);
    assert.equal(GLARE_LEVELS[0].id, 'off');
    assert.equal(glareActive(GLARE_OFF), false);
    assert.equal(glareActive(normalizeGlare()), false);
    assert.equal(glareActive(normalizeGlare(null ?? undefined)), false);
    assert.equal(describeGlare({}), 'off');
});

test('levels are cumulative and each one is active', () => {
    const ids = GLARE_LEVELS.map((l) => l.id);
    assert.deepEqual(ids, ['off', 'light', 'medium', 'strong', 'max']);
    for (const l of GLARE_LEVELS.slice(1)) assert.equal(glareActive(l.settings), true, l.id);
    assert.equal(glareLevel('light').cellMargin, 0.3);
    assert.equal(glareLevel('medium').boardRefine, true);
    assert.equal(glareLevel('strong').gamma, 2);
    assert.equal(glareLevel('max').minMarkers, 1);
    assert.deepEqual(glareLevel('nonsense'), { ...GLARE_OFF });
});

test('matchGlareLevel round-trips levels and recognises custom settings', () => {
    for (const l of GLARE_LEVELS) assert.equal(matchGlareLevel(l.settings), l.id);
    assert.equal(matchGlareLevel({ cellMargin: 0.3, gamma: 3 }), 'custom');
    assert.equal(matchGlareLevel({}), 'off');
});

test('normalizeGlare fills defaults and clamps', () => {
    const g = normalizeGlare({ cellMargin: 0.9, gamma: 0, minMarkers: 7, boardRefine: 1 });
    assert.equal(g.cellMargin, 0.49);
    assert.equal(g.gamma, 0.2);
    assert.equal(g.minMarkers, 2);
    assert.equal(g.boardRefine, true);
    assert.equal(normalizeGlare({ cellMargin: 'abc' }).cellMargin, 0.13);
    assert.equal(normalizeGlare({ cellMargin: '' }).cellMargin, 0.13);
    assert.equal(normalizeGlare({ minMarkers: 0 }).minMarkers, 1);
});

test('glareKey distinguishes settings', () => {
    const keys = new Set(GLARE_LEVELS.map((l) => glareKey(l.settings)));
    assert.equal(keys.size, GLARE_LEVELS.length);
    assert.equal(glareKey({}), glareKey(GLARE_OFF));
    assert.equal(describeGlare(glareLevel('max')), 'cell margin 0.3, board refine, gamma 2, min markers/corner 1');
});

run();
