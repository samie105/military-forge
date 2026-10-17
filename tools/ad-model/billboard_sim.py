"""Monte Carlo model of in-world billboard exposure in a 2.5D side-view shooter.
Outputs per-player-match stats per frame, then scales to CCU tiers."""
import numpy as np, math, json, sys

rng = np.random.default_rng(7)
DT = 0.25
FOV_V = math.radians(35.0)
ASPECT = 16 / 9
BOARD_Z = 6.0  # metres behind the gameplay plane (mid-depth layer z=-10..-1)

def window_at_depth(zoom_mult):
    W0 = 36.0 * zoom_mult
    H0 = W0 / ASPECT
    d = (H0 / 2) / math.tan(FOV_V / 2)
    s = (d + BOARD_Z) / d
    return W0, H0, W0 * s, H0 * s  # gameplay-plane window, billboard-depth window

ZOOMS = np.array([1.0, 1.2, 1.4, 2.0])
ZOOM_P = np.array([0.6, 0.2, 0.1, 0.1])

def simulate(kind, n_matches, boards, bw, bh, n_frames, dwell, occl=0.9):
    """kind: 'std' (120x60 deathmatch) or 'br' (480x140 strip).
    Returns dict of per-player-match averages per frame."""
    if kind == 'std':
        MW, MH, T = 120.0, 60.0, 6 * 60.0
    else:
        MW, MH, T = 480.0, 140.0, 7 * 60.0
    steps = int(T / DT)
    B = len(boards)
    bx = np.array([b[0] for b in boards]); by = np.array([b[1] for b in boards])
    seen = np.zeros((n_matches, B, n_frames), bool)
    expos = np.zeros((n_matches, B, n_frames), np.int32)
    vsec = np.zeros((n_matches, B, n_frames))
    onscreen_any = np.zeros(n_matches)
    alive_sec = np.zeros(n_matches)
    for m in range(n_matches):
        zoom = rng.choice(ZOOMS, p=ZOOM_P)
        W0, H0, Wb, Hb = window_at_depth(zoom)
        cov = (bw * bh) / (Wb * Hb)
        if cov < 0.015:
            continue  # board too small on screen at this zoom: never viewable
        phase = rng.uniform(0, n_frames * dwell, B)
        # player state
        if kind == 'std':
            spawns_x = rng.uniform(8, 112, 12); spawns_y = rng.choice([6, 22, 38, 50], 12)
            def respawn():
                i = rng.integers(12); return spawns_x[i], spawns_y[i]
            x, y = respawn(); vx = vy = 0.0
            life = rng.exponential(35.0); dead = 0.0
            t_end = T
        else:
            x = rng.uniform(10, 470); y = 66.0 if rng.random() < 0.8 else 25.0
            vx = vy = 0.0
            t_end = min(T, 30 + rng.uniform(0.3, 1.0) * (T - 30))  # survival time
            life = 1e9; dead = 0.0
            zone_c = rng.uniform(150, 330)
        runlen = np.zeros(B, np.int32); runframe = -np.ones(B, np.int32)
        any_on = 0
        for k in range(steps):
            t = k * DT
            if t > t_end:
                break
            if dead > 0:
                dead -= DT
                if dead <= 0:
                    x, y = respawn(); life = rng.exponential(35.0)
                runlen[:] = 0; runframe[:] = -1
                continue
            # OU velocity
            if kind == 'std':
                vx += (-vx / 2.0) * DT + 6.0 * math.sqrt(DT) * rng.standard_normal() * 0.7
                vy += (-vy / 1.5) * DT + 4.0 * math.sqrt(DT) * rng.standard_normal() * 0.7
            else:
                drift = 0.6 * np.sign(zone_c - x) * min(1.0, t / T * 2)
                vx += ((drift * 3 - vx) / 3.0) * DT + 4.0 * math.sqrt(DT) * rng.standard_normal() * 0.7
                vy += (-vy / 1.5) * DT + 2.5 * math.sqrt(DT) * rng.standard_normal() * 0.7
            x = min(max(x + vx * DT, 1), MW - 1); y = min(max(y + vy * DT, 1), MH - 1)
            if kind == 'br':
                y = min(max(y, 18), 100)
            cx = min(max(x, W0 / 2), MW - W0 / 2); cy = min(max(y + 1.5, H0 / 2), MH - H0 / 2)
            alive_sec[m] += DT
            # >=50% of board area inside depth window (axis-aligned overlap)
            ox = np.clip(np.minimum(bx + bw / 2, cx + Wb / 2) - np.maximum(bx - bw / 2, cx - Wb / 2), 0, None)
            oy = np.clip(np.minimum(by + bh / 2, cy + Hb / 2) - np.maximum(by - bh / 2, cy - Hb / 2), 0, None)
            vis = (ox * oy) >= 0.5 * bw * bh
            if vis.any():
                any_on += 1
            fr = (((t + phase) // dwell) % n_frames).astype(np.int32)
            for b in range(B):
                if vis[b]:
                    if runframe[b] == fr[b]:
                        runlen[b] += 1
                    else:
                        runlen[b] = 1; runframe[b] = fr[b]
                    vsec[m, b, fr[b]] += DT
                    if runlen[b] == 4:  # >= 1 continuous second
                        expos[m, b, fr[b]] += 1; seen[m, b, fr[b]] = True
                else:
                    runlen[b] = 0; runframe[b] = -1
            if kind == 'std':
                life -= DT
                if life <= 0:
                    dead = 3.0 + 2.0  # respawn delay + death cam (counted as no-view)
        onscreen_any[m] = any_on * DT
    # occlusion haircut (players/projectiles/UI covering >50% of a board)
    res = dict(
        p_seen_per_match=float(seen.mean() * occl),
        expos_per_match=float(expos.mean() * occl),
        vsec_per_match=float(vsec.mean() * occl),
        alive_min=float(alive_sec.mean() / 60),
        per_board_share=float(vsec.sum(axis=2).mean() / max(alive_sec.mean(), 1e-9)),
        any_board_share=float(onscreen_any.mean() / max(alive_sec.mean(), 1e-9)),
        # same advertiser holding one frame slot on EVERY screen of the map
        p_seen_all_screens_per_match=float(seen.any(axis=1).mean() * occl),
        expos_all_screens_per_match=float(expos.sum(axis=1).mean() * occl),
    )
    return res

if __name__ == '__main__':
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    std_boards = [(20, 30), (45, 46), (60, 20), (75, 46), (100, 30), (60, 54)]  # 6 screens
    br_boards = [(12 + 24 * i, 72) for i in range(20)]  # 20 screens along the surface
    out = {}
    for frames, dwell in [(6, 10), (4, 15)]:
        out[f'std_{frames}x{dwell}'] = simulate('std', N, std_boards, 8, 4, frames, dwell)
        out[f'br_{frames}x{dwell}'] = simulate('br', N, br_boards, 8, 4, frames, dwell)
    print(json.dumps(out, indent=1))
