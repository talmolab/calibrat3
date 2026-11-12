import { test, run, assert, approx } from './harness.mjs';
import { DEFAULT_BOARD, normalizeBoard, boardKey, numCorners, numMarkers, cornerObjectPoint, objectPointsForIds, dictNameFromToml, tomlFromDictName, allCornerObjectPoints, detectorLayout, legacyPatternDiffers } from '../calib/board.js';

test('defaults match sample_session/board.toml', () => {
    assert.equal(DEFAULT_BOARD.boardX, 8);
    assert.equal(DEFAULT_BOARD.boardY, 11);
    assert.equal(DEFAULT_BOARD.squareLength, 24);
    assert.equal(DEFAULT_BOARD.markerLength, 18.75);
    assert.equal(DEFAULT_BOARD.dictName, 'DICT_4X4_1000');
});

test('corner counts', () => {
    assert.equal(numCorners(DEFAULT_BOARD), 7 * 10);
    assert.equal(numMarkers(DEFAULT_BOARD), 44);
});

test('object points follow OpenCV CharucoBoard convention ((col+1)*s, (row+1)*s)', () => {
    approx(cornerObjectPoint(0, DEFAULT_BOARD), [24, 24, 0]);
    approx(cornerObjectPoint(6, DEFAULT_BOARD), [7 * 24, 24, 0]);
    approx(cornerObjectPoint(7, DEFAULT_BOARD), [24, 48, 0]);
    approx(cornerObjectPoint(69, DEFAULT_BOARD), [7 * 24, 10 * 24, 0]);
    const flat = objectPointsForIds(Int32Array.from([0, 7, 69]), DEFAULT_BOARD);
    assert.equal(flat.length, 9);
    approx(Array.from(flat), [24, 24, 0, 24, 48, 0, 168, 240, 0]);
    // export/board table uses the SAME convention as calibration
    approx(allCornerObjectPoints(DEFAULT_BOARD)[7], cornerObjectPoint(7, DEFAULT_BOARD));
});

test('normalizeBoard validates', () => {
    assert.throws(() => normalizeBoard({ boardX: 2 }));
    assert.throws(() => normalizeBoard({ markerLength: 30, squareLength: 24 }));
    assert.throws(() => normalizeBoard({ dictName: 'DICT_7X7_50' }));
    const b = normalizeBoard({ boardX: '5', boardY: '7', squareLength: '10', markerLength: '7.5', dictName: 'DICT_5X5_100' });
    assert.equal(b.boardX, 5);
    assert.equal(typeof b.squareLength, 'number');
    assert.equal(boardKey(b), '5x7|10|7.5|DICT_5X5_100');
});

test('dictionary name <-> toml fields', () => {
    assert.equal(dictNameFromToml(4, 1000), 'DICT_4X4_1000');
    assert.equal(dictNameFromToml(7, 50), null);
    assert.deepEqual(tomlFromDictName('DICT_6X6_250'), { markerBits: 6, dictSize: 250 });
});

test('legacy pattern: only even-row boards differ; layout is a one-row-taller current board', () => {
    const odd = normalizeBoard({ boardX: 8, boardY: 11, legacyPattern: true });
    assert.equal(legacyPatternDiffers(odd), false);
    assert.deepEqual(detectorLayout(odd), { sizeX: 8, sizeY: 11, ids: null, cornerIdOffset: 0 });
    const even = normalizeBoard({ boardX: 8, boardY: 8, squareLength: 0.125, markerLength: 0.0985, legacyPattern: true });
    assert.equal(legacyPatternDiffers(even), true);
    const L = detectorLayout(even);
    assert.equal(L.sizeX, 8); assert.equal(L.sizeY, 9); assert.equal(L.cornerIdOffset, 7);
    // 8x9 current-pattern board has 36 markers: 4 phantoms (row 0, odd columns) from the top of the dictionary, then the real 32 as 0..31
    assert.equal(L.ids.length, 36);
    assert.deepEqual(L.ids.slice(0, 4), [999, 998, 997, 996]);
    assert.deepEqual(L.ids.slice(4, 8), [0, 1, 2, 3]);
    assert.equal(L.ids[35], 31);
    assert.equal(numMarkers(even), 32);
    // the same board without the flag is detected as-is
    assert.deepEqual(detectorLayout({ ...even, legacyPattern: false }), { sizeX: 8, sizeY: 8, ids: null, cornerIdOffset: 0 });
    assert.ok(boardKey(even).endsWith('|legacy') && !boardKey({ ...even, legacyPattern: false }).endsWith('|legacy'));
});

test('legacy layout corner remap keeps the board.js object-point convention', () => {
    // augmented corner (col, row+1) -> physical id row*(X-1)+col with object point ((col+1)s, (row+1)s)
    const even = normalizeBoard({ boardX: 8, boardY: 8, legacyPattern: true });
    const L = detectorLayout(even);
    for (const [col, row] of [[0, 0], [3, 2], [6, 6]]) {
        const augmentedId = (row + 1) * (L.sizeX - 1) + col;
        const physicalId = augmentedId - L.cornerIdOffset;
        assert.equal(physicalId, row * 7 + col);
        approx(cornerObjectPoint(physicalId, even), [(col + 1) * 24, (row + 1) * 24, 0], 1e-9);
    }
});

run();
