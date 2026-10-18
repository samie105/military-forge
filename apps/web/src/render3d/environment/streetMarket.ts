/**
 * Street Market (docs/01 §7, map 4): the environment around W8's kit. Positions are in map metres
 * (x along the street, z toward the camera); everything here is dressing behind or in front of the
 * gameplay band, never in it.
 */
import type { EnvironmentDef } from './index';
import { MARKET_DAY, MARKET_DUSK, MARKET_NIGHT } from './looks';

export const STREET_MARKET: EnvironmentDef = {
  mapId: 'street-market',
  kitUrl: 'assets/kits/street_market/kit_street_market.glb',
  layoutUrl: 'assets/kits/street_market/street_market.layout.json',
  looks: { day: MARKET_DAY, dusk: MARKET_DUSK, night: MARKET_NIGHT },
  defaultLook: 'day',
  // Higgsfield art (art/README.md cost table), processed by apps/web/scripts/backdrops.py
  backdrop: {
    base: 'assets/backdrops/street_market/',
    skies: { day: 'sky_day.webp', dusk: 'sky_dusk.webp', night: 'sky_night.webp' },
    layers: [
      // a hazy skyline far off: its feet hide behind the blocks in front, so it stands a little high
      {
        name: 'far',
        z: -34,
        y: 2,
        panels: [
          { file: 'far_a.webp', x: -50, width: 110 },
          { file: 'far_b.webp', x: 50, width: 110 },
        ],
      },
      // apartment blocks behind the market (the kit's screens and towers stand in front of them);
      // the 1 m gap between the two panels reads as an alley
      {
        name: 'mid',
        z: -16,
        y: -3,
        panels: [
          { file: 'mid_a.webp', x: -40.5, width: 80 },
          { file: 'mid_b.webp', x: 40.5, width: 80 },
        ],
      },
    ],
  },
  // W8's AdSlots (art/maps/street_market/street_market.adslots.json) and the house pool (apps/web/scripts/house-ads.py)
  ads: {
    slots: 'assets/kits/street_market/street_market.adslots.json',
    pool: 'assets/ads/street_market/house.json',
    base: 'assets/ads/street_market/',
  },
  lamps: [-71, -49, -27, -5, 17, 39, 61],
  dressing: {
    // sm_power_pole: the crossarm's top at 8.32 m, 2.4 m wide; the wires run on past the map's ends
    poles: { piece: 'sm_power_pole', attach: [[-1.05, 8.3], [-0.42, 8.3], [1.05, 8.3]], extendTo: [-92, 92], sag: 0.55 },
    // over the stalls and the minibuses, hung from the house fronts' back corners
    bunting: [
      { a: [-44.3, 7.4, -1.4], b: [-23.2, 7.6, -1.4], sag: 1.5 },
      { a: [23.2, 7.6, -1.4], b: [44.3, 7.4, -1.4], sag: 1.5 },
      // low over the minibuses: the mast's ad Screen (S3) is above 6.4 m
      { a: [-17.2, 5.8, -1.5], b: [-1.7, 4.7, -1.5], sag: 0.8 },
      { a: [1.7, 4.7, -1.5], b: [17.2, 5.8, -1.5], sag: 0.8 },
      { a: [-53.8, 10.8, -1.6], b: [-50.2, 7.4, -1.6], sag: 0.4 },
      { a: [50.2, 7.4, -1.6], b: [53.8, 10.8, -1.6], sag: 0.4 },
    ],
    // clear of the ad screens' rectangles (docs/14: ads are never occluded by dressing)
    trees: [
      { x: -41.5, z: -3.3, h: 6.8 },
      { x: -26.5, z: -2.7, h: 5.6 },
      { x: 26.8, z: -2.9, h: 6.0 },
      { x: 41.2, z: -3.6, h: 7.2 },
      { x: 6.5, z: -9.5, h: 8.5 },
      { x: -64.5, z: -4, h: 7 },
      { x: 64.5, z: -4.4, h: 7.5 },
    ],
    // between the ground-floor windows (top 3.16 m) and the first floor's (from 5.41 m), in front of the pilasters (z 1.08)
    signs: { pieces: ['sm_house_2f', 'sm_house_3f', 'sm_house_3f_blue'], y0: 3.62, y1: 4.5, z: 1.1, width: 5.3 },
  },
};
