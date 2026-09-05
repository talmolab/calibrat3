import { test, run, assert, approx } from './harness.mjs';
import { DEFAULT_BOARD, normalizeBoard, boardKey, numCorners, numMarkers, cornerObjectPoint, objectPointsForIds, dictNameFromToml, tomlFromDictName, allCornerObjectPoints } from '../calib/board.js';

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

run();
