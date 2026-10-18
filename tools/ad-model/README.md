# Billboard ad model (docs/14)

The exposure simulation and pricing maths behind docs/14 §2.3 and §6, as run on 17 Oct 2026. Estimates from simulated camera paths, not real players: re-run them on pilot telemetry before quoting numbers to advertisers.

| Script | What it does |
|---|---|
| `billboard_sim.py` | camera random walk per mode + IAB/MRC viewability rules (≥ 50% of pixels, ≥ 1.5% of screen, ≥ 1 s) → impressions per player-hour per surface |
| `sim4.py` | re-runs the model on the §2.3 placements (Street Market screens and hoardings, Strip clusters + metro) |
| `yard.py` | the BR warm-up yard screens (Drop Sponsor) |
| `econ3.py` | billable-CCU netting, rate card and revenue-at-sell-through tables (§6) |

Run with Python 3 + numpy: `python3 sim4.py 300 > sim4_out.json` (the argument is the number of simulated sessions).
