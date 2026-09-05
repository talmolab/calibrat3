import { test, run, assert, approx } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { generateCalibrationToml, parseCalibrationToml, parseBoardToml, generateBoardToml, parseSimpleToml } from '../import-export/toml.js';
import { DEFAULT_BOARD } from '../calib/board.js';

const cams = [
    { name: 'back', size: [1280, 1024], K: [[1000.5, 0, 640], [0, 1001.25, 512], [0, 0, 1]], dist: [-0.1, 0.01, 0.0001, -0.0002, 0.001], rvec: [0, 0, 0], tvec: [0, 0, 0] },
    { name: 'mid', size: [1280, 1024], K: [[990, 0, 630], [0, 995, 500], [0, 0, 1]], dist: [-0.2, 0.02, 0, 0, 0], rvec: [0.1, -0.2, 0.3], tvec: [100.123456, -50, 300] },
];

test('calibration.toml has the sleap-anipose field order and values', () => {
    const toml = generateCalibrationToml(cams, { referenceName: 'back', generated: new Date(0) });
    const lines = toml.split('\n');
    assert.ok(lines.includes('# Reference camera: back'));
    const i = lines.indexOf('[cam_0]');
    assert.ok(i > 0);
    assert.equal(lines[i + 1], 'name = "back"');
    assert.equal(lines[i + 2], 'size = [1280, 1024]');
    assert.ok(lines[i + 3].startsWith('matrix = [[1000.500000, 0.000000, 640.000000], [0.000000, 1001.250000, 512.000000], [0.000000, 0.000000, 1.000000]]'));
    assert.ok(lines[i + 4].startsWith('distortions = ['));
    assert.ok(lines[i + 5].startsWith('rotation = ['));
    assert.ok(lines[i + 6].startsWith('translation = ['));
    assert.ok(toml.includes('[cam_1]\nname = "mid"'));
});

test('calibration.toml round-trips through the reader', () => {
    const toml = generateCalibrationToml(cams, { referenceName: 'back', metadata: { generator: 'calibrat3', refined_by_sba: true, n: 3 } });
    const parsed = parseCalibrationToml(toml);
    assert.equal(parsed.cameras.length, 2);
    assert.equal(parsed.cameras[1].name, 'mid');
    assert.deepEqual(parsed.cameras[0].size, [1280, 1024]);
    approx(parsed.cameras[0].K.flat(), cams[0].K.flat(), 1e-6);
    approx(parsed.cameras[1].dist, cams[1].dist, 1e-10);
    approx(parsed.cameras[1].rvec, cams[1].rvec, 1e-10);
    approx(parsed.cameras[1].tvec, cams[1].tvec, 1e-6);
    assert.equal(parsed.metadata.generator, 'calibrat3');
    assert.equal(parsed.metadata.refined_by_sba, true);
    assert.equal(parsed.metadata.n, 3);
});

test('board.toml from sample_session parses to the default board', () => {
    const text = readFileSync(new URL('../sample_session/board.toml', import.meta.url), 'utf8');
    const { board } = parseBoardToml(text);
    assert.deepEqual(board, { boardX: 8, boardY: 11, squareLength: 24, markerLength: 18.75, dictName: 'DICT_4X4_1000' });
});

test('board.toml writer round trip + comments / strings', () => {
    const text = generateBoardToml(DEFAULT_BOARD);
    assert.ok(text.includes('marker_bits = 4'));
    assert.ok(text.includes('dict_size = 1000'));
    assert.deepEqual(parseBoardToml(text).board, { ...DEFAULT_BOARD });
    const raw = parseSimpleToml('# c\nname = "a # not comment"  # trailing\nflag = true\nlist = [1, [2, 3], "x"]\n');
    assert.equal(raw.name, 'a # not comment');
    assert.equal(raw.flag, true);
    assert.deepEqual(raw.list, [1, [2, 3], 'x']);
});

run();
