/**
 * loading/opencv-ready.js — resolve the OpenCV.js module once its WASM
 * runtime is initialized. Works in the main thread and in classic workers.
 *
 * GOTCHA: Emscripten's MODULARIZE build of opencv.js exposes `cv.then(cb)`,
 * but that `then` returns the module object itself (a thenable). `await cv`
 * or `resolve(cv)` therefore recurses forever with no error. Never await the
 * module directly — this helper hands it back wrapped in a plain object.
 * (loading/detect-worker.js and loading/calib-worker.js inline the same logic
 * because classic workers can't import ES modules statically.)
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
        if (typeof cvGlobal.Mat === 'function') { done(cvGlobal); return; }
        if (typeof cvGlobal.then === 'function') {
            cvGlobal.then((m) => done(m && typeof m.Mat === 'function' ? m : cvGlobal));
            return;
        }
        const prev = cvGlobal.onRuntimeInitialized;
        cvGlobal.onRuntimeInitialized = () => { if (typeof prev === 'function') prev(); done(cvGlobal); };
    });
}
