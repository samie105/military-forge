# WorldStreet billboard masters

Masters for WorldStreet's in-world billboards (Street Market), designed in Deet's Pen file, board
"DEET × Military Forge — billboard set v2" (node n8HYKf), exported at docs/14 §3.1's upload sizes
(Screens 2048×1536, Hoardings 2304×384). `apps/web/scripts/house-ads.py` grades them into the
runtime layers (`--sponsored-only`).

`logo/` holds unmodified copies of the WorldStreet team's own logo files
(Worldstreet/public/worldstreet-logo: WorldStreet2.png, WorldStreet4x.png), used on the art as is.

Rules for this art: brand and product names only; no prices, returns, profit claims or urgency.
Anything that mentions trading, forex or crypto carries "Trading involves risk. 18+." and is
category `finance` in house-ads.py (held off the boards by default: docs/14 §3.7).
