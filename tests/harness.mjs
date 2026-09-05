/**
 * tests/harness.mjs — minimal test harness for the native-ESM Node tests.
 * Each test file imports { test, run } and calls run() at the end; the
 * process exit code is 0 only if every test passed.
 */
import assert from 'node:assert/strict';

const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export { assert };

export function approx(actual, expected, tol = 1e-9, msg = '') {
    if (Array.isArray(expected)) {
        assert.equal(actual.length, expected.length, `${msg} length`);
        expected.forEach((e, i) => approx(actual[i], e, tol, `${msg}[${i}]`));
        return;
    }
    if (!(Math.abs(actual - expected) <= tol)) {
        throw new assert.AssertionError({ message: `${msg} expected ${expected} ± ${tol}, got ${actual}`, actual, expected });
    }
}

export async function run() {
    let passed = 0, failed = 0;
    for (const t of tests) {
        try { await t.fn(); passed++; console.log(`  ok   ${t.name}`); }
        catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${(e && e.message || e).toString().split('\n').join('\n       ')}`); }
    }
    console.log(`${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
}
