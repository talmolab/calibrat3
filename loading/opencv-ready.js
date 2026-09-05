/**
 * loading/opencv-ready.js — resolve the OpenCV.js module once its WASM
 * runtime is initialized. Works in the main thread and in classic workers.
 *
 * OpenCV.js builds differ: some expose `cv` as a Promise<Module>, others as a
 * Module that fires `onRuntimeInitialized`. This handles both.
 */

/**
 * @param {any} cvGlobal the `cv` global right after the script was loaded
 * @param {number} [timeoutMs]
 * @returns {Promise<any>} the initialized cv module
 */
export function waitForOpenCV(cvGlobal, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OpenCV.js did not initialize in time')), timeoutMs);
        const done = (m) => { clearTimeout(timer); resolve(m); };
        if (!cvGlobal) { clearTimeout(timer); reject(new Error('cv global is undefined')); return; }
        if (typeof cvGlobal.then === 'function') {
            cvGlobal.then(m => (m && m.Mat) ? done(m) : waitModule(m, done));
            return;
        }
        waitModule(cvGlobal, done);
    });
}

function waitModule(m, done) {
    if (m && typeof m.Mat === 'function') { done(m); return; }
    const prev = m.onRuntimeInitialized;
    m.onRuntimeInitialized = () => { if (typeof prev === 'function') prev(); done(m); };
}
