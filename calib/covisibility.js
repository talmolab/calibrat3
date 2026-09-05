/**
 * calib/covisibility.js — covisibility graph and pose chain over cameras.
 *
 * Pure JS over a DetectionStore. Views are referenced by index.
 */

/**
 * Build the covisibility graph.
 * @param {import('./detection-store.js').DetectionStore} store
 * @param {number} minCovisible minimum corners per view AND minimum common ids per pair
 * @param {Set<number>} [excluded] video frames to skip
 * @returns {{ numViews:number, edges: Map<string, Array<{frame:number, commonIds:Int32Array}>>, pairCounts:number[][] }}
 *   edges keyed by "a,b" with a < b.
 */
export function buildCovisibilityGraph(store, minCovisible, excluded = new Set()) {
    const n = store.numViews;
    const edges = new Map();
    const pairCounts = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const frame of store.frames()) {
        if (excluded.has(frame)) continue;
        const views = store.viewsWithMin(frame, minCovisible);
        for (let i = 0; i < views.length; i++) {
            for (let j = i + 1; j < views.length; j++) {
                const a = views[i], b = views[j];
                const common = store.commonIds(frame, [a, b]);
                if (common.length < minCovisible) continue;
                const key = `${a},${b}`;
                let list = edges.get(key);
                if (!list) { list = []; edges.set(key, list); }
                list.push({ frame, commonIds: common });
                pairCounts[a][b]++; pairCounts[b][a]++;
            }
        }
    }
    return { numViews: n, edges, pairCounts };
}

export function edgeKey(a, b) { return a < b ? `${a},${b}` : `${b},${a}`; }

/** Covisible frames for a pair (either order). */
export function pairFrames(graph, a, b) {
    return graph.edges.get(edgeKey(a, b)) || [];
}

/**
 * BFS from the reference view over the covisibility graph, preferring the
 * neighbour with the most covisible frames at each expansion.
 * @returns {{ parent: Array<number|null>, order: number[], unreachable: number[] }}
 *   parent[ref] = null; parent[v] = -1 for unreachable.
 */
export function findPoseChain(graph, refIdx) {
    const n = graph.numViews;
    const parent = new Array(n).fill(-1);
    parent[refIdx] = null;
    const order = [refIdx];
    const queue = [refIdx];
    while (queue.length) {
        const cur = queue.shift();
        const neighbours = [];
        for (let v = 0; v < n; v++) {
            if (v === cur || parent[v] !== -1) continue;
            const c = graph.pairCounts[cur][v];
            if (c > 0) neighbours.push([v, c]);
        }
        neighbours.sort((x, y) => y[1] - x[1]);
        for (const [v] of neighbours) {
            if (parent[v] !== -1) continue;
            parent[v] = cur;
            order.push(v);
            queue.push(v);
        }
    }
    const unreachable = [];
    for (let v = 0; v < n; v++) if (parent[v] === -1) unreachable.push(v);
    return { parent, order, unreachable };
}

/** Path of view indices from ref to `v` (inclusive of both). */
export function pathToRoot(parent, v) {
    const path = [];
    let cur = v;
    while (cur !== null && cur !== undefined && cur !== -1) {
        path.unshift(cur);
        cur = parent[cur];
    }
    return path;
}
