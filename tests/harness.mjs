/**
 * tests/harness.mjs — minimal test harness shared by the Node runner
 * (tests/run-mjs-tests.mjs) and the browser runner (tests/test-runner.html).
 *
 * Each test file imports { test, run, assert, approx } and calls run() at the
 * end. In Node, run() prints results and sets the exit code. In the browser,
 * test-runner.html installs `globalThis.__calibrat3TestReporter` and run()
 * reports to it instead.
 *
 * No `node:` imports so the same file loads in both environments.
 */

const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }

class AssertionError extends Error {
    constructor(message, actual, expected) { super(message); this.name = 'AssertionError'; this.actual = actual; this.expected = expected; }
}

function fmt(v) {
    try {
        if (v instanceof Error) return v.message;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
        if (ArrayBuffer.isView(v)) return `${v.constructor.name}[${Array.from(v).join(',')}]`;
        const s = JSON.stringify(v);
        return s.length > 200 ? s.slice(0, 200) + '…' : s;
    } catch (_) { return String(v); }
}

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
        if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length || a.constructor !== b.constructor) return false;
        for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
        return true;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every(x => b.has(x));
    if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEqual(v, b.get(k)));
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

export const assert = {
    ok(v, msg = '') { if (!v) throw new AssertionError(`${msg} expected truthy, got ${fmt(v)}`.trim(), v, true); },
    equal(a, b, msg = '') { if (!Object.is(a, b) && a !== b) throw new AssertionError(`${msg} expected ${fmt(b)}, got ${fmt(a)}`.trim(), a, b); },
    notEqual(a, b, msg = '') { if (a === b) throw new AssertionError(`${msg} expected not ${fmt(b)}`.trim(), a, b); },
    deepEqual(a, b, msg = '') { if (!deepEqual(a, b)) throw new AssertionError(`${msg} expected ${fmt(b)}, got ${fmt(a)}`.trim(), a, b); },
    throws(fn, msg = '') {
        let threw = false;
        try { fn(); } catch (_) { threw = true; }
        if (!threw) throw new AssertionError(`${msg} expected function to throw`.trim());
    },
    async rejects(p, msg = '') {
        let threw = false;
        try { await (typeof p === 'function' ? p() : p); } catch (_) { threw = true; }
        if (!threw) throw new AssertionError(`${msg} expected promise to reject`.trim());
    },
    fail(msg = 'failed') { throw new AssertionError(msg); },
};

export function approx(actual, expected, tol = 1e-9, msg = '') {
    if (Array.isArray(expected)) {
        assert.equal(actual.length, expected.length, `${msg} length`);
        expected.forEach((e, i) => approx(actual[i], e, tol, `${msg}[${i}]`));
        return;
    }
    if (!(Math.abs(actual - expected) <= tol)) {
        throw new AssertionError(`${msg} expected ${expected} ± ${tol}, got ${actual}`.trim(), actual, expected);
    }
}

export const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/** Load a text fixture relative to the repo root (Node: fs, browser: fetch). */
export async function loadText(relPath) {
    if (isNode) {
        const fs = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        const root = new URL('../', import.meta.url);
        return fs.readFile(fileURLToPath(new URL(relPath, root)), 'utf8');
    }
    const resp = await fetch(new URL(`../${relPath}`, import.meta.url));
    if (!resp.ok) throw new Error(`fetch ${relPath}: HTTP ${resp.status}`);
    return resp.text();
}

export async function run() {
    const reporter = globalThis.__calibrat3TestReporter || null;
    const suite = tests.splice(0, tests.length);
    let passed = 0, failed = 0;
    for (const t of suite) {
        const t0 = (globalThis.performance || Date).now();
        try {
            await t.fn();
            passed++;
            reporter ? reporter.pass(t.name, (globalThis.performance || Date).now() - t0) : console.log(`  ok   ${t.name}`);
        } catch (e) {
            failed++;
            const msg = (e && e.stack) ? e.stack : String(e);
            reporter ? reporter.fail(t.name, msg) : console.log(`  FAIL ${t.name}\n       ${msg.split('\n').join('\n       ')}`);
        }
    }
    if (reporter) reporter.done(passed, failed);
    else {
        console.log(`${passed} passed, ${failed} failed`);
        if (isNode) process.exitCode = (process.exitCode || 0) || (failed ? 1 : 0);
    }
    return { passed, failed };
}
