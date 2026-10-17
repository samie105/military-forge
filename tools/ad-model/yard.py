"""Warm-up yard (08 §4): small arena, 4 Screens showing one Drop Sponsor creative, players stay 5–30 s, no deaths.
Hot-joiners (placed straight onto the plane) never see the yard."""
import math, json, numpy as np
rng = np.random.default_rng(11)
DT = 0.25
import billboard_sim as bs
def run(n=4000, hot=0.2, MW=80.0, MH=40.0, boards=((15, 22), (40, 30), (65, 22), (40, 12)), bw=8, bh=6):
    bx = np.array([b[0] for b in boards]); by = np.array([b[1] for b in boards])
    seen = 0; vsec = 0.0
    for m in range(n):
        if rng.random() < hot:
            continue
        zoom = rng.choice(bs.ZOOMS, p=bs.ZOOM_P)
        W0, H0, Wb, Hb = bs.window_at_depth(zoom)
        if (bw * bh) / (Wb * Hb) < 0.015:
            continue
        T = rng.uniform(5, 30)
        x, y = rng.uniform(5, MW - 5), rng.uniform(4, MH - 4); vx = vy = 0.0
        run = 0; got = False
        for k in range(int(T / DT)):
            vx += (-vx / 2.0) * DT + 6.0 * math.sqrt(DT) * rng.standard_normal() * 0.7
            vy += (-vy / 1.5) * DT + 4.0 * math.sqrt(DT) * rng.standard_normal() * 0.7
            x = min(max(x + vx * DT, 1), MW - 1); y = min(max(y + vy * DT, 1), MH - 1)
            cx = min(max(x, W0 / 2), MW - W0 / 2); cy = min(max(y + 1.5, H0 / 2), MH - H0 / 2)
            ox = np.clip(np.minimum(bx + bw / 2, cx + Wb / 2) - np.maximum(bx - bw / 2, cx - Wb / 2), 0, None)
            oy = np.clip(np.minimum(by + bh / 2, cy + Hb / 2) - np.maximum(by - bh / 2, cy - Hb / 2), 0, None)
            if ((ox * oy) >= 0.5 * bw * bh).any():
                run += 1; vsec += DT
                if run >= 4: got = True
            else:
                run = 0
        seen += got
    return dict(p_seen=seen / n * 0.9, vsec=vsec / n * 0.9)
print(json.dumps({'hot0.2': run(hot=0.2), 'hot0.4': run(hot=0.4)}, indent=1))
