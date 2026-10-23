/**
 * Looks and painted backdrops for the maps that have no kit yet (the map-mechanics demos, docs/02
 * §20). Their play plane stays the extruded collision (mapGeometry.ts), recoloured by each look's
 * palette; the generated ground and foreground stay (layers.ts), and painted layers take the place
 * of the generic sky, skyline and blocks. Each map is its own place (owner, 18 Oct): no Lagos
 * styling outside the Street Market.
 *
 * Art: Higgsfield (GPT Image 2.5) via apps/web/scripts/backdrops.py; jobs and credits in
 * art/README.md's cost table.
 */
import type { EnvironmentDef } from './index';
import { MARKET_DAY, type EnvironmentLook } from './looks';

const NO_GLOW = { ...MARKET_DAY.sunGlow, strength: 0 };

/** The Moon: a hard low sun, a black sky with Earth in it, no air to soften anything. */
export const LUNAR: EnvironmentLook = {
  ...MARKET_DAY,
  name: 'lunar',
  sky: [0x04060c, 0x10162a],
  skyStops: [0x0d1220, 0x0b1020, 0x04060c],
  sunGlow: NO_GLOW,
  fog: { color: 0x0c111d, near: 90, far: 420 },
  hemi: { sky: 0x8796b8, ground: 0x2b2a2c, intensity: 0.95 },
  sun: { color: 0xffffff, intensity: 3.1, dir: [-0.72, 0.5, 0.48] },
  palette: {
    front: [0x6f6e74, 0x5b6470, 0x6a5b4c, 0x8a8781, 0x7c96a2],
    cap: [0xa3a2a8, 0x8e99a4, 0x9a8468, 0xb6b3ad, 0xa4bfcb],
    oneWay: 0xc9a24a,
    ground: 0x8b8984,
    mid: [0x9a9ea6, 0x8f949c, 0xa3a6ab, 0x878c94],
    far: 0x8a8f99,
    fore: 0x24262b,
  },
  backdropTint: { sky: 0xffffff, far: 0xc9ced8, mid: 0xdde1e8 },
  backdropHaze: { color: 0x0c111d, amount: { mid: 0.4 } },
  lampGlow: null,
};

/** A harbour in a storm: overcast light, slate clouds, rain-dark stone and steel. */
export const STORM: EnvironmentLook = {
  ...MARKET_DAY,
  name: 'storm',
  sky: [0x343d48, 0x6c7884],
  skyStops: [0x6a7480, 0x5d6874, 0x343d48],
  sunGlow: NO_GLOW,
  fog: { color: 0x5e6a76, near: 50, far: 190 },
  hemi: { sky: 0x9aa9b8, ground: 0x434b52, intensity: 1.85 },
  sun: { color: 0xc9d4de, intensity: 1.35, dir: [-0.3, 0.82, 0.48] },
  palette: {
    front: [0x6c7072, 0x5a646c, 0x6e5a4a, 0x5f5c53, 0x708a96],
    cap: [0x8f9496, 0x7f8b95, 0x8a715a, 0x78766d, 0x97b1bd],
    oneWay: 0xc9a24a,
    ground: 0x515c63,
    mid: [0x7b8691, 0x737d86, 0x828b92, 0x6e7880],
    far: 0x7c8894,
    fore: 0x24272b,
  },
  backdropTint: { sky: 0xffffff, far: 0xdfe5ec, mid: 0xd7dee5 },
  backdropHaze: { color: 0x5e6a76, amount: { mid: 0.35 } },
  lampGlow: null,
};

/** A physics lab hall: even cool overhead light, clean panels, soft cyan machines behind. */
export const LAB: EnvironmentLook = {
  ...MARKET_DAY,
  name: 'lab',
  sky: [0x9aa6b0, 0xc8d2da],
  skyStops: [0xc8d2da, 0xbcc6ce, 0x9aa6b0],
  sunGlow: NO_GLOW,
  fog: { color: 0x9fadb9, near: 70, far: 240 },
  hemi: { sky: 0xdbe7f1, ground: 0x59616b, intensity: 1.8 },
  sun: { color: 0xf3f8ff, intensity: 1.6, dir: [-0.2, 0.9, 0.38] },
  palette: {
    front: [0x8e949a, 0x7b8691, 0x8a7a68, 0x7a756c, 0x8fb0c0],
    cap: [0xc3c8cd, 0xa9b3bd, 0xa8957d, 0x9a958c, 0xb1d2e0],
    oneWay: 0xc9a24a,
    ground: 0xa7acb1,
    mid: [0xaab3bb, 0x9fa9b2, 0xb3bcc4, 0x98a2ab],
    far: 0x9aa6b0,
    fore: 0x2e3338,
  },
  backdropTint: { sky: 0xffffff, wall: 0xffffff, mid: 0xf2f4f6 },
  backdropHaze: { color: 0xc4ccd3, amount: { wall: 0.35, mid: 0.35 } },
  lampGlow: null,
};

/**
 * Panel placement: each layer spans the view sideways from every camera position and zoom
 * (backdrop.test.ts checks it); second panels are mirrored copies, which read as more of the same
 * distance rather than a repeat.
 */
export const LUNAR_OUTPOST: EnvironmentDef = {
  mapId: 'lunar-outpost',
  looks: { lunar: LUNAR },
  defaultLook: 'lunar',
  backdrop: {
    base: 'assets/backdrops/lunar_outpost/',
    skies: { lunar: 'sky.webp' },
    layers: [
      {
        name: 'far',
        z: -40,
        y: -2,
        panels: [
          { file: 'far.webp', x: 15, width: 92 },
          { file: 'far.webp', x: 105, width: 92, flip: true },
        ],
      },
      {
        name: 'mid',
        z: -14,
        y: -1,
        panels: [
          { file: 'mid.webp', x: 26, width: 72 },
          { file: 'mid.webp', x: 98, width: 72, flip: true },
        ],
      },
    ],
  },
};

export const STORM_FRONT: EnvironmentDef = {
  mapId: 'storm-front',
  looks: { storm: STORM },
  defaultLook: 'storm',
  backdrop: {
    base: 'assets/backdrops/storm_front/',
    skies: { storm: 'sky.webp' },
    layers: [
      {
        name: 'far',
        z: -40,
        y: -3,
        panels: [
          { file: 'far.webp', x: 15, width: 92 },
          { file: 'far.webp', x: 105, width: 92, flip: true },
        ],
      },
      {
        name: 'mid',
        z: -14,
        y: -3,
        panels: [
          { file: 'mid.webp', x: 26, width: 72 },
          { file: 'mid.webp', x: 98, width: 72, flip: true },
        ],
      },
    ],
  },
};

/**
 * Indoors: the hall's back wall is an opaque painting that fills the view; no sky. It runs past
 * the ceiling because a wide zoom on a 4:3 screen sees above the 44 m tall map.
 */
export const FLUX_LAB: EnvironmentDef = {
  mapId: 'flux-lab',
  looks: { lab: LAB },
  defaultLook: 'lab',
  backdrop: {
    base: 'assets/backdrops/flux_lab/',
    skies: {},
    layers: [
      { name: 'wall', z: -24, y: -4, opaque: true, panels: [{ file: 'wall.webp', x: 55, width: 156 }] },
      {
        name: 'mid',
        z: -8,
        y: 0,
        panels: [
          { file: 'mid.webp', x: 24, width: 62 },
          { file: 'mid.webp', x: 86, width: 62, flip: true },
        ],
      },
    ],
  },
};

/**
 * Fog Stair (maps-vertical; the owner's pick, 23 Oct): a mountain city on a river gorge in the
 * morning, fog off the river. Soft overcast light from the upper left, weathered concrete, faded
 * tile and brick, green-grey paint; distance and the river's fog swallow everything behind the
 * play plane. Its own place: no Lagos styling.
 */
export const FOG: EnvironmentLook = {
  ...MARKET_DAY,
  name: 'fog',
  sky: [0x7a8a98, 0xc9c8bc],
  skyStops: [0xb9bdb8, 0xc6c6bb, 0x7a8a98],
  sunGlow: { ...MARKET_DAY.sunGlow, color: 0xffecc8, strength: 0.18 },
  fog: { color: 0xa9b1b4, near: 45, far: 210 },
  hemi: { sky: 0xd5dde2, ground: 0x5d625e, intensity: 1.9 },
  sun: { color: 0xfff1dc, intensity: 1.45, dir: [-0.45, 0.78, 0.44] },
  palette: {
    front: [0x7d7f7c, 0x8f8b80, 0x7a5f52, 0x6c7a72, 0x8a9396],
    cap: [0xa6a8a3, 0xb6b0a2, 0x9b7c6b, 0x8fa096, 0xaeb7ba],
    oneWay: 0xb98a3e,
    ground: 0x74786f,
    mid: [0x9aa2a4, 0x929b9e, 0xa4aaa9, 0x8c9598],
    far: 0x9ba4a8,
    fore: 0x2b2f2e,
  },
  backdropTint: { sky: 0xffffff, far: 0xe8ecec, mid: 0xe2e6e6 },
  // fog: the near towers stay well back (they must never read as walls that stop bullets)
  backdropHaze: { color: 0xa9b1b4, amount: { far: 0.25, mid: 0.5 } },
  lampGlow: null,
};

export const FOG_STAIR: EnvironmentDef = {
  mapId: 'fog-stair',
  looks: { fog: FOG },
  defaultLook: 'fog',
  backdrop: {
    base: 'assets/backdrops/fog_stair/',
    skies: { fog: 'sky.webp' },
    layers: [
      {
        name: 'far',
        z: -40,
        y: -4,
        panels: [
          { file: 'far.webp', x: 10, width: 120 },
          { file: 'far.webp', x: 120, width: 120, flip: true },
          { file: 'far.webp', x: 230, width: 120 },
        ],
      },
      {
        name: 'mid',
        z: -14,
        y: -5,
        panels: [
          { file: 'mid.webp', x: 20, width: 90 },
          { file: 'mid.webp', x: 100, width: 90, flip: true },
          { file: 'mid.webp', x: 180, width: 90 },
          { file: 'mid.webp', x: 250, width: 90, flip: true },
        ],
      },
    ],
  },
};
