"""Re-run the exposure model with the doc-14 §2.3 placements (Lagos layout for every standard product,
Strip POI clusters + metro, warm-up yard). Same camera/IAB rules as billboard_sim.py."""
import json, math, sys
import numpy as np
import billboard_sim as bs
N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
out = {}
lagos = [(18, 34), (48, 48), (78, 22), (104, 40)]                     # LM-S1..S4
out['lm_frame'] = bs.simulate('std', N, lagos, 8, 6, 6, 10)            # frame + Map Pack (all screens)
out['lm_owner'] = bs.simulate('std', N, lagos, 8, 6, 1, 10)            # Screen Owner (6/6)
out['lm_b1'] = bs.simulate('std', N, [(60, 52)], 21, 3.5, 1, 10)       # flyover banner
out['lm_b2'] = bs.simulate('std', N, [(95, 44)], 18, 3, 1, 10)         # rooftop sign
# Strip, §2.3: docks 2, old town 4, factory 3, airbase 3 (surface, y≈72); metro 4 (platform walls, y≈27)
strip = [(30, 72), (60, 72), (95, 72), (115, 72), (135, 72), (155, 72),
         (255, 72), (280, 72), (305, 72), (400, 72), (430, 72), (460, 72),
         (110, 27), (140, 27), (170, 27), (200, 27)]
out['strip_frame'] = bs.simulate('br', N, strip, 8, 6, 6, 10)          # frame + Strip Pack (all 16)
out['strip_banner'] = bs.simulate('br', N, [(45, 76), (125, 76), (280, 76), (430, 76)], 18, 3, 1, 10)
print(json.dumps(out, indent=1))
