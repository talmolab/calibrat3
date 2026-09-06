import { test, run, assert } from './harness.mjs';
import { buildSession, VIDEO_EXT, shortenNames } from '../loading/folder-loader.js';

const fakeFile = (text = '', size = 1000) => ({ size, text: async () => text });
const BOARD = 'board_x = 5\nboard_y = 7\nsquare_length = 30\nmarker_length = 22.5\nmarker_bits = 5\ndict_size = 100\n';

test('flat layout: {root}/{view}.mp4, sorted by name, board.toml at root', async () => {
    const s = await buildSession([
        { path: 'top.mp4', file: fakeFile() },
        { path: 'back.MP4', file: fakeFile() },
        { path: 'notes.txt', file: fakeFile() },
        { path: 'board.toml', file: fakeFile(BOARD) },
    ]);
    assert.equal(s.layout, 'flat');
    assert.deepEqual(s.views.map(v => v.name), ['back', 'top']);
    assert.equal(s.views[0].path, 'back.MP4');
    assert.deepEqual(s.board, { boardX: 5, boardY: 7, squareLength: 30, markerLength: 22.5, dictName: 'DICT_5X5_100' });
    assert.equal(s.boardPath, 'board.toml');
});

test('nested anipose layout: {root}/{view}/calibration_images/*.mp4', async () => {
    const s = await buildSession([
        { path: 'cam2/calibration_images/calib_000.mp4', file: fakeFile() },
        { path: 'cam1/calibration_images/calib.mp4', file: fakeFile() },
        { path: 'cam1/recordings/session1.mp4', file: fakeFile() },      // ignored: not a calibration dir
        { path: 'cam10/calibration/calib.mov', file: fakeFile() },
        { path: 'cam1/calibration_images/board.toml', file: fakeFile(BOARD) },
    ]);
    assert.equal(s.layout, 'nested');
    assert.deepEqual(s.views.map(v => v.name), ['cam1', 'cam2', 'cam10']);   // numeric-aware sort
    assert.equal(s.views[0].path, 'cam1/calibration_images/calib.mp4');
    assert.equal(s.views[2].path, 'cam10/calibration/calib.mov');
    assert.equal(s.board.boardX, 5);
    assert.equal(s.boardPath, 'cam1/calibration_images/board.toml');
});

test('nested: multiple videos per camera picks the first alphabetically and notes it', async () => {
    const s = await buildSession([
        { path: 'A/calibration_images/b.mp4', file: fakeFile() },
        { path: 'A/calibration_images/a.mp4', file: fakeFile() },
        { path: 'B/direct.mp4', file: fakeFile() },
    ]);
    assert.equal(s.views.length, 2);
    assert.equal(s.views[0].path, 'A/calibration_images/a.mp4');
    assert.deepEqual(s.views[0].alternates, ['A/calibration_images/b.mp4']);
    assert.equal(s.views[1].path, 'B/direct.mp4');
    assert.ok(s.notes.some(n => n.startsWith('A:')));
});

test('flat wins over nested when both exist; empty folder -> none', async () => {
    const s = await buildSession([
        { path: 'x.mp4', file: fakeFile() },
        { path: 'cam/calibration_images/y.mp4', file: fakeFile() },
    ]);
    assert.equal(s.layout, 'flat');
    assert.deepEqual(s.views.map(v => v.name), ['x']);
    const e = await buildSession([{ path: 'readme.md', file: fakeFile() }]);
    assert.equal(e.layout, 'none');
    assert.equal(e.views.length, 0);
    assert.equal(e.board, null);
});

test('board.toml preference: root > calibration/ > deeper; parse errors become notes', async () => {
    const s = await buildSession([
        { path: 'v.mp4', file: fakeFile() },
        { path: 'calibration/board.toml', file: fakeFile(BOARD) },
        { path: 'board.toml', file: fakeFile('board_x = 9\nboard_y = 9\nsquare_length = 1\nmarker_length = 0.5\nmarker_bits = 4\ndict_size = 50\n') },
    ]);
    assert.equal(s.boardPath, 'board.toml');
    assert.equal(s.board.boardX, 9);
    const bad = await buildSession([{ path: 'v.mp4', file: fakeFile() }, { path: 'board.toml', file: { size: 1, text: async () => { throw new Error('boom'); } } }]);
    assert.equal(bad.board, null);
    assert.ok(bad.notes.some(n => n.includes('boom')));
});

test('VIDEO_EXT', () => {
    for (const ok of ['a.mp4', 'a.MOV', 'a.m4v', 'a.webm']) assert.ok(VIDEO_EXT.test(ok), ok);
    for (const no of ['a.avi', 'a.mp4.txt', 'mp4']) assert.ok(!VIDEO_EXT.test(no), no);
});

test('shortenNames strips common prefix/suffix at token boundaries', () => {
    assert.deepEqual(shortenNames(['10072022145420-back-calibration', '10072022145420-backL-calibration', '10072022145420-top-calibration']), ['back', 'backL', 'top']);
    assert.deepEqual(shortenNames(['cam1', 'cam2']), ['cam1', 'cam2']);            // no shared token
    assert.deepEqual(shortenNames(['a_left', 'a_right']), ['left', 'right']);
    assert.deepEqual(shortenNames(['same', 'same']), ['same', 'same']);            // not unique -> unchanged
    assert.deepEqual(shortenNames(['only']), ['only']);
});

test('flat layout uses shortened view names and notes it', async () => {
    const s = await buildSession([{ path: '1007-back-calibration.mp4', file: fakeFile() }, { path: '1007-top-calibration.mp4', file: fakeFile() }]);
    assert.deepEqual(s.views.map(v => v.name), ['back', 'top']);
    assert.ok(s.notes.some(n => n.includes('shortened')));
});

run();
