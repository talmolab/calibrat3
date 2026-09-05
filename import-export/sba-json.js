/**
 * import-export/sba-json.js — full calibration data dump (JSON): cameras,
 * board, every 2D observation, triangulated points with per-camera errors,
 * and SBA metadata. Arrays are flat (not one object per corner) so a
 * 1000-frame session stays a few MB.
 */

import { allCornerObjectPoints } from '../calib/board.js';

/**
 * @param {object} state app state
 * @returns {object|null}
 */
export function generateCalibrationJson(state) {
    const names = state.views.map(v => v.name);
    if (!state.intrinsics.some(Boolean)) return null;
    const round = (v, d = 6) => Number.isFinite(v) ? Number(v.toFixed(d)) : null;

    const cameras = {};
    names.forEach((name, i) => {
        const intr = state.intrinsics[i], extr = state.extrinsics[i];
        if (!intr) return;
        cameras[name] = {
            index: i,
            image_size: [intr.imageSize.width, intr.imageSize.height],
            K: intr.K, dist_coeffs: intr.dist,
            intrinsics_rms_error: intr.rmsError,
            intrinsics_frames_used: intr.selectedFrames,
            intrinsics_per_frame: intr.perFrame ? {
                frames: Array.from(intr.perFrame.frames),
                rms_errors: Array.from(intr.perFrame.errors, v => round(v, 4)),
                used_in_fit: Array.from(intr.perFrame.used, v => !!v),
                rvecs: chunk(intr.perFrame.rvecs, 3), tvecs: chunk(intr.perFrame.tvecs, 3),
            } : null,
            refined_by_sba: !!intr.refinedBySba,
            ...(extr && !extr.error ? { R: extr.R, rvec: extr.rvec, tvec: extr.tvec, pose_chain: extr.chain ? extr.chain.map(k => names[k]) : null } : { R: null, rvec: null, tvec: null }),
        };
    });

    const observations = [];
    if (state.detections) {
        for (const f of state.detections.frames()) {
            const views = {};
            names.forEach((name, i) => {
                const d = state.detections.get(f, i);
                if (d && d.ids.length) views[name] = { corner_ids: Array.from(d.ids), corners_2d: chunk(d.corners, 2, 3), num_markers: d.numMarkers };
            });
            if (Object.keys(views).length) observations.push({ frame: f, views });
        }
    }

    const triangulated = [];
    if (state.reproj) {
        for (const rec of state.reproj.frames) {
            const per = {};
            names.forEach((name, i) => {
                const vr = rec.views[i];
                if (!vr) return;
                per[name] = { mask: Array.from(vr.mask, v => !!v), errors: Array.from(vr.err, v => round(v, 4)), projected: chunk(vr.proj, 2, 3) };
            });
            triangulated.push({ frame: rec.frame, corner_ids: Array.from(rec.ids), points_3d: chunk(rec.xyz, 3, 4), mean_error: round(rec.meanErr, 4), per_camera: per });
        }
    }

    return {
        metadata: {
            generator: 'calibrat3', generated: new Date().toISOString(),
            session: state.sessionName, layout: state.sessionLayout,
            reference_camera: names[state.referenceView] ?? names[0],
            camera_names: names, num_frames: state.totalFrames, fps: state.fps,
            sampled_frames: state.sampledFrames.length,
            exclusions: { intrinsics: Array.from(state.exclusions.intrinsics).sort((a, b) => a - b), extrinsics: Array.from(state.exclusions.extrinsics).sort((a, b) => a - b) },
            sba: state.sbaResult ? { config: state.sbaResult.config, iterations: state.sbaResult.result.iterations, initial_cost: state.sbaResult.result.initial_cost, final_cost: state.sbaResult.result.final_cost, converged: state.sbaResult.result.converged, status: state.sbaResult.result.status, num_observations_used: state.sbaResult.result.num_observations_used, num_observations_filtered: state.sbaResult.result.num_observations_filtered } : null,
            reprojection_summary: state.reproj ? state.reproj.summary : null,
        },
        board: { type: 'charuco', ...state.board, corners_3d: allCornerObjectPoints(state.board) },
        cameras, observations, triangulated_points: triangulated,
    };
}

function chunk(arr, n, digits = null) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) {
        const row = [];
        for (let k = 0; k < n; k++) { const v = arr[i + k]; row.push(Number.isFinite(v) ? (digits === null ? v : Number(v.toFixed(digits))) : null); }
        out.push(row);
    }
    return out;
}
