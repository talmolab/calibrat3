/**
 * ui/events.js — tiny synchronous event bus so stage modules can react to
 * each other without importing each other.
 *
 * Events:
 *   'session-loaded'        {}                 videos are open, state.views populated
 *   'frame'                 {frame}            current frame rendered
 *   'board-changed'         {board}
 *   'detections-changed'    {}                 batch detection finished / store replaced
 *   'intrinsics-changed'    {}
 *   'extrinsics-changed'    {}                 extrinsics and/or reprojection updated
 *   'exclusions-changed'    {kind:'intrinsics'|'extrinsics'}
 *   'active-exclusion'      {kind}             which exclusion set the X key targets
 */

const handlers = new Map();

export function on(type, fn) {
    let set = handlers.get(type);
    if (!set) { set = new Set(); handlers.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
}

export function emit(type, payload = {}) {
    const set = handlers.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
        try { fn(payload); } catch (e) { console.error(`[events] handler for ${type} threw`, e); }
    }
}
