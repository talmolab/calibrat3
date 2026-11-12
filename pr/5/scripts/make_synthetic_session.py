#!/usr/bin/env python3
"""
make_synthetic_session.py — render a long synthetic multi-camera ChArUco
calibration session with known ground truth, for stress/regression testing.

Output (anipose-style layout, so it also exercises the nested folder loader):

    {out}/
        board.toml
        calibration_gt.toml          ground-truth intrinsics/extrinsics (sleap-anipose format)
        {cam}/calibration_images/calib.mp4   one H.264 video per camera

The board moves smoothly (random-walk pose in front of the rig) so a subset of
frames is out of view / partially visible for some cameras, like real data.

Usage (with uv):
    uv run --with numpy --with opencv-contrib-python-headless --with imageio-ffmpeg \
        scripts/make_synthetic_session.py --out /tmp/synthetic_session --frames 1200 --cams 4
Or with pip-installed numpy, opencv-contrib-python-headless, imageio-ffmpeg:
    python3 scripts/make_synthetic_session.py --out /tmp/synthetic_session
"""
import argparse
import math
import os
import sys

import numpy as np
import cv2
import imageio_ffmpeg

BOARD_X, BOARD_Y = 8, 11
SQUARE, MARKER = 24.0, 18.75
DICT = cv2.aruco.DICT_4X4_1000


def rodrigues(r):
    R, _ = cv2.Rodrigues(np.asarray(r, dtype=np.float64).reshape(3, 1))
    return R


def look_at(cam_pos, target, up=(0, -1, 0)):
    """World->camera rotation for a camera at cam_pos looking at target (OpenCV: +z forward, +y down)."""
    z = np.asarray(target, float) - np.asarray(cam_pos, float)
    z /= np.linalg.norm(z)
    x = np.cross(np.asarray(up, float), z)
    if np.linalg.norm(x) < 1e-6:
        x = np.cross((1, 0, 0), z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z])          # rows = camera axes in world coords
    t = -R @ np.asarray(cam_pos, float)
    return R, t


def toml_list(v):
    return "[" + ", ".join(f"{float(x):.10g}" for x in v) + "]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", type=int, default=1200)
    ap.add_argument("--cams", type=int, default=4)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--gop", type=int, default=30)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--noise", type=float, default=4.0, help="pixel noise sigma")
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    W, H = args.width, args.height
    os.makedirs(args.out, exist_ok=True)

    # --- board image (high-res, warped per frame)
    dictionary = cv2.aruco.getPredefinedDictionary(DICT)
    board = cv2.aruco.CharucoBoard((BOARD_X, BOARD_Y), SQUARE, MARKER, dictionary)
    px_per_mm = 8
    bw, bh = int(BOARD_X * SQUARE * px_per_mm), int(BOARD_Y * SQUARE * px_per_mm)
    board_img = board.generateImage((bw, bh), marginSize=0, borderBits=1)
    # Add a white margin so the outer squares have a border (like a printed board)
    margin_mm = SQUARE
    canvas = np.full((bh + 2 * int(margin_mm * px_per_mm), bw + 2 * int(margin_mm * px_per_mm)), 255, np.uint8)
    m = int(margin_mm * px_per_mm)
    canvas[m:m + bh, m:m + bw] = board_img
    board_img = canvas
    # Board-plane coordinates (mm) of the image corners: board spans [0, BOARD_X*SQUARE] x [0, BOARD_Y*SQUARE]
    plane_corners = np.array([[-margin_mm, -margin_mm, 0], [BOARD_X * SQUARE + margin_mm, -margin_mm, 0],
                              [BOARD_X * SQUARE + margin_mm, BOARD_Y * SQUARE + margin_mm, 0], [-margin_mm, BOARD_Y * SQUARE + margin_mm, 0]], np.float64)
    img_corners = np.array([[0, 0], [board_img.shape[1], 0], [board_img.shape[1], board_img.shape[0]], [0, board_img.shape[0]]], np.float32)

    # --- cameras on an arc around the working volume, looking at the origin
    names = ["back", "mid", "side", "top", "cam5", "cam6", "cam7", "cam8"][: args.cams]
    cams = []
    for i, name in enumerate(names):
        ang = -0.7 + 1.4 * i / max(1, args.cams - 1)
        dist = 520 + 60 * (i % 2)
        pos = np.array([dist * math.sin(ang), -120 - 80 * (i % 3), -dist * math.cos(ang)])
        R, t = look_at(pos, (0, 0, 0))
        f = 900 + 60 * i
        K = np.array([[f, 0, W / 2 + rng.uniform(-20, 20)], [0, f * (1 + 0.01 * i), H / 2 + rng.uniform(-20, 20)], [0, 0, 1]])
        dist_coeffs = np.array([-0.20 + 0.03 * i, 0.05, 0.0005 * i, -0.0004, 0.0])
        cams.append(dict(name=name, K=K, dist=dist_coeffs, R=R, t=t))

    # --- board trajectory: smooth random walk in pose space, board roughly at the origin
    n = args.frames
    def smooth_walk(scale, sigma, dims):
        steps = rng.normal(0, 1, (n, dims)) * sigma
        walk = np.cumsum(steps, axis=0)
        # low-pass + bound with tanh to keep in a box
        k = 15
        kernel = np.ones(k) / k
        walk = np.stack([np.convolve(walk[:, d], kernel, mode="same") for d in range(dims)], axis=1)
        return scale * np.tanh(walk / (scale * 2))
    trans = smooth_walk(np.array([140, 110, 120]), 12.0, 3)
    rots = smooth_walk(np.array([0.55, 0.7, 0.5]), 0.05, 3)
    # board center offset so the board rotates about its middle
    center = np.array([BOARD_X * SQUARE / 2, BOARD_Y * SQUARE / 2, 0])

    # --- write board.toml + ground-truth calibration.toml
    with open(os.path.join(args.out, "board.toml"), "w") as fh:
        fh.write(f"board_x = {BOARD_X}\nboard_y = {BOARD_Y}\nsquare_length = {SQUARE}\nmarker_length = {MARKER}\nmarker_bits = 4\ndict_size = 1000\n")
    # Express ground truth relative to camera 0 (world = cam 0), matching the app's convention.
    R0, t0 = cams[0]["R"], cams[0]["t"]
    with open(os.path.join(args.out, "calibration_gt.toml"), "w") as fh:
        fh.write("# Ground truth for the synthetic session (world = first camera)\n\n")
        for i, c in enumerate(cams):
            Rrel = c["R"] @ R0.T
            trel = c["t"] - Rrel @ t0
            rvec, _ = cv2.Rodrigues(Rrel)
            K = c["K"]
            fh.write(f"[cam_{i}]\nname = \"{c['name']}\"\nsize = [{W}, {H}]\n")
            fh.write(f"matrix = [{toml_list(K[0])}, {toml_list(K[1])}, {toml_list(K[2])}]\n")
            fh.write(f"distortions = {toml_list(c['dist'])}\nrotation = {toml_list(rvec.ravel())}\ntranslation = {toml_list(trel)}\n\n")

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    writers = []
    for c in cams:
        d = os.path.join(args.out, c["name"], "calibration_images")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "calib.mp4")
        w = imageio_ffmpeg.write_frames(path, (W, H), pix_fmt_in="gray", pix_fmt_out="yuv420p", fps=args.fps, codec="libx264",
                                        output_params=["-g", str(args.gop), "-bf", "2", "-crf", "20", "-preset", "veryfast", "-movflags", "+faststart"],
                                        ffmpeg_log_level="error")
        w.send(None)
        writers.append(w)

    visible = np.zeros((n, len(cams)), bool)
    chess = board.getChessboardCorners().astype(np.float64)   # (numCorners, 3) board-frame mm
    bg = (rng.normal(110, 12, (H, W))).clip(0, 255).astype(np.uint8)

    # Exact lens model: for every output pixel, precompute its UNDISTORTED normalized
    # coordinate once per camera (cv2.undistortPoints); per frame, map normalized coords
    # to board-image pixels through the pinhole homography and cv2.remap. Unlike warping
    # through four distorted corners, this makes every interior corner obey K/dist exactly.
    grid = np.stack(np.meshgrid(np.arange(W, dtype=np.float64), np.arange(H, dtype=np.float64)), axis=-1).reshape(-1, 1, 2)
    for c in cams:
        und = cv2.undistortPoints(grid, c["K"], c["dist"]).reshape(-1, 2)
        c["norm_h"] = np.concatenate([und, np.ones((und.shape[0], 1))], axis=1).T   # 3 x N homogeneous normalized coords

    for fi in range(n):
        Rb = rodrigues(rots[fi])
        tb = trans[fi] - Rb @ center             # board frame -> world
        for ci, c in enumerate(cams):
            # board plane -> camera: x_cam = R_c (R_b X + t_b) + t_c
            Rc = c["R"] @ Rb
            tc = c["R"] @ tb + c["t"]
            rvec, _ = cv2.Rodrigues(Rc)
            # pinhole (undistorted, normalized) projection of the board image corners
            Xc = (Rc @ plane_corners.T + tc.reshape(3, 1))
            normc = (Xc[:2] / Xc[2]).T.astype(np.float32)
            Hm = cv2.getPerspectiveTransform(normc, img_corners)     # normalized -> board image px
            bp = Hm @ c["norm_h"]
            w_ = bp[2]
            with np.errstate(divide="ignore", invalid="ignore"):
                mapx = (bp[0] / w_).reshape(H, W).astype(np.float32)
                mapy = (bp[1] / w_).reshape(H, W).astype(np.float32)
            behind = (w_ <= 0).reshape(H, W)
            mapx[behind] = -1; mapy[behind] = -1
            frame = bg.copy()
            cv2.remap(board_img, mapx, mapy, cv2.INTER_LINEAR, dst=frame, borderMode=cv2.BORDER_TRANSPARENT)
            frame = cv2.GaussianBlur(frame, (0, 0), 0.8)
            if args.noise > 0:
                frame = (frame.astype(np.float32) + rng.normal(0, args.noise, frame.shape)).clip(0, 255).astype(np.uint8)
            cp, _ = cv2.projectPoints(chess, rvec, tc.reshape(3, 1), c["K"], c["dist"])
            cp = cp.reshape(-1, 2)
            inside = ((cp[:, 0] > 0) & (cp[:, 0] < W) & (cp[:, 1] > 0) & (cp[:, 1] < H)).sum()
            visible[fi, ci] = inside >= 6
            writers[ci].send(np.ascontiguousarray(frame))
        if fi % 100 == 0:
            print(f"frame {fi}/{n}", file=sys.stderr)
    for w in writers:
        w.close()
    print(f"wrote {n} frames x {len(cams)} cameras to {args.out}; frames with >= 6 chessboard corners in view: " +
          ", ".join(f"{c['name']}={visible[:, i].mean() * 100:.0f}%" for i, c in enumerate(cams)))


if __name__ == "__main__":
    main()
