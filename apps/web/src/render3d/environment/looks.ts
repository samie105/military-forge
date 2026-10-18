/**
 * Lighting and grading presets for maps drawn from a kit (docs/11 §2: one hemisphere + one
 * directional light, baked AO in vertex colours; §4: palette discipline). A look extends the
 * render3d `LightingPreset` (lights, fog, the extruded plane's fallback palette) with what the
 * environment builds: the sky, the grade of each kit layer, the street and the contact shadows.
 */
import { Color } from 'three';
import type { LightingPreset } from '../lighting';
import type { MapGrade } from './grade';

export interface EnvironmentLook extends LightingPreset {
  name: string;
  /** sky gradient stops, bottom → top: below the skyline, horizon, zenith */
  skyStops: [number, number, number];
  /** heights of those stops on the sky card (m) */
  skyHeights: [number, number, number];
  /** a soft glow on the sky where the sun is: world x, y on the sky card, size (m), additive strength */
  sunGlow: { color: number; x: number; y: number; size: number; strength: number };
  grade: {
    haze: number;
    tint: number;
    aoHeight: number;
    aoFloor: number;
    floorSaturation: number;
    gameplay: [saturation: number, gain: number];
    mid: [saturation: number, gain: number, haze: number, hazePerM: number];
    far: [saturation: number, gain: number, haze: number, hazePerM: number];
  };
  /** the street in front of the gameplay band and the ground behind it */
  street: {
    asphalt: number;
    kerb: number;
    kerbAlt: number;
    gutter: number;
    pavement: number;
    marking: number;
    backGround: number;
  };
  /** contact shadows under kit pieces: colour and opacity (with blob shadows; weaker under the High shadow map) */
  contact: { color: number; opacity: number; opacityShadowMap: number };
  /** the shadow side of mid-depth dressing is lifted toward the haze by this much (low contrast) */
  midLift: number;
  /** multiplies the painted backdrops (backdrop.ts) by layer name: 'sky', 'far', 'mid' */
  backdropTint: Record<string, number>;
  /** street lamps lit: a glow at each head and a pool of light on the road (null: off) */
  lampGlow: { color: number; strength: number } | null;
  /** multiplies billboard creatives (ads/boards.ts): unlit, so dimmed and tinted into the light of the look */
  adTint: number;
}

/**
 * Street Market, day: late-morning sun through dusty air. Warm cream horizon, a soft blue zenith,
 * the kit's painted plaster kept but quieted, mid and far blocks fading into the haze.
 */
export const MARKET_DAY: EnvironmentLook = {
  name: 'day',
  // the Locker's warm 'desert' rim (#ffd29a): late-morning sun
  rim: { color: 0xffd29a, strength: 0.6 },
  sky: [0x7fa6c9, 0xdfe3df],
  skyStops: [0xc4cfd3, 0xdfe4e0, 0x7ea5c8],
  skyHeights: [-10, 8, 72],
  sunGlow: { color: 0xfff0d6, x: -44, y: 60, size: 90, strength: 0.07 },
  fog: { color: 0xc8d1d4, near: 70, far: 280 },
  hemi: { sky: 0xdde8f2, ground: 0x6d6253, intensity: 1.25 },
  sun: { color: 0xffe6c4, intensity: 2.6, dir: [-0.62, 0.68, 0.4] },
  palette: {
    front: [0x8a8275, 0x707a82, 0x8a6a4a, 0x7a6450, 0x7a96a4],
    cap: [0xb0a693, 0x99a4ad, 0xb08a62, 0x8a7a5e, 0xa4c4d2],
    oneWay: 0xc9a24a,
    ground: 0x8f8574,
    mid: [0x9da3a6, 0xa4a29b, 0x969fa6, 0xaaa79e],
    far: 0xb3bcc0,
    fore: 0x3e3a35,
  },
  grade: {
    haze: 0xc3ced3,
    tint: 0xfff8f0,
    aoHeight: 2.6,
    aoFloor: 0.62,
    floorSaturation: 0.72,
    gameplay: [0.9, 1.0],
    mid: [0.62, 0.98, 0.1, 0.03],
    far: [0.38, 0.95, 0.32, 0.011],
  },
  street: {
    asphalt: 0x5f5d5a,
    kerb: 0xa39e93,
    kerbAlt: 0x77736c,
    gutter: 0x4a4743,
    pavement: 0x8a857b,
    marking: 0xc9c5b8,
    backGround: 0x8c887c,
  },
  contact: { color: 0x241d17, opacity: 0.55, opacityShadowMap: 0.35 },
  midLift: 0.1,
  backdropTint: { sky: 0xffffff, far: 0xffffff, mid: 0xffffff },
  lampGlow: null,
  adTint: 0xf4f1ea,
};

/**
 * Street Market, dusk: the sun low on the left, warm light raking along the street, a violet sky
 * fading to amber, the painted city behind turned rosy; the street lamps are on.
 */
export const MARKET_DUSK: EnvironmentLook = {
  ...MARKET_DAY,
  name: 'dusk',
  // the Locker's warm 'desert' rim (#ffd29a): low sun
  rim: { color: 0xffd29a, strength: 0.6 },
  sky: [0x5c5f9e, 0xe89a70],
  skyStops: [0xe2a27a, 0xe99b74, 0x5c5f9e],
  sunGlow: { ...MARKET_DAY.sunGlow, strength: 0 },
  fog: { color: 0xd39c84, near: 70, far: 260 },
  hemi: { sky: 0xa898c8, ground: 0x5a4036, intensity: 1.1 },
  sun: { color: 0xffb47c, intensity: 2.6, dir: [-0.84, 0.36, 0.4] },
  grade: {
    ...MARKET_DAY.grade,
    haze: 0xcf9f8c,
    tint: 0xffe2cc,
    gameplay: [0.92, 0.97],
    mid: [0.6, 0.92, 0.14, 0.03],
    far: [0.4, 0.88, 0.36, 0.011],
  },
  street: { ...MARKET_DAY.street, asphalt: 0x5a5250, pavement: 0x857669, backGround: 0x8a7468 },
  contact: { color: 0x2a1a18, opacity: 0.55, opacityShadowMap: 0.35 },
  midLift: 0.12,
  // cooler and darker than the sunlit street, so the warm-lit players stay in front of it
  backdropTint: { sky: 0xffffff, far: 0x957f9e, mid: 0xae8f9c },
  lampGlow: { color: 0xffc27a, strength: 0.5 },
  // the (unlit) boards dim with the kit around them, so a board is no brighter against it than in
  // the day (docs/14 §3.4): the CPU model (ads/test/brightness.test.ts) asks for ≈ 0.75×, the
  // review's on-screen measure for ≈ 0.57×; 0.65× sits between (board ≈ the nearby kit's p95)
  adTint: dimmed(0xd8c4bc, 0.65),
};

/**
 * Street Market, night: blue moonlight from the right, a navy sky over the city's glow, the city
 * behind gone to deep blue silhouettes; the street lamps pool warm light on the road. Kept bright
 * enough on the play plane that players stay the clearest thing on screen.
 */
export const MARKET_NIGHT: EnvironmentLook = {
  ...MARKET_DAY,
  name: 'night',
  // the Locker's 'night' rim (#3fd0c0)
  rim: { color: 0x3fd0c0, strength: 0.6 },
  sky: [0x0f1b3b, 0x2c4560],
  skyStops: [0x34485a, 0x2a3f58, 0x0f1b3b],
  sunGlow: { ...MARKET_DAY.sunGlow, strength: 0 },
  fog: { color: 0x1f2b40, near: 70, far: 240 },
  hemi: { sky: 0x8090b4, ground: 0x2a2622, intensity: 1.15 },
  sun: { color: 0xc0ccf0, intensity: 1.25, dir: [0.45, 0.7, 0.55] },
  grade: {
    ...MARKET_DAY.grade,
    haze: 0x2c3852,
    tint: 0xc8d2ee,
    // moonlight is weak at colour: and the blue house must not read as team blue
    gameplay: [0.6, 0.98],
    mid: [0.5, 0.8, 0.22, 0.03],
    far: [0.3, 0.7, 0.45, 0.012],
  },
  street: { ...MARKET_DAY.street, asphalt: 0x4a4c55, kerb: 0x8d8c90, kerbAlt: 0x5c5c62, pavement: 0x6c6c72, backGround: 0x5a5d68 },
  contact: { color: 0x0c0e16, opacity: 0.5, opacityShadowMap: 0.3 },
  midLift: 0.04,
  backdropTint: { sky: 0xffffff, far: 0x404d6c, mid: 0x5a6688 },
  lampGlow: { color: 0xffbd6e, strength: 0.95 },
  // ≈ 0.5× of the night tint the boards had: the kit around them is that much darker (brightness.test.ts)
  adTint: dimmed(0x8f99b0, 0.5),
};

/**
 * `hex` with its light scaled by `k` (in linear RGB, as three lights and shades it), back as sRGB
 * hex: dims a tint without shifting its hue.
 */
export function dimmed(hex: number, k: number): number {
  return new Color(hex).multiplyScalar(k).getHex();
}

/** The grade a look describes, as grade.ts takes it. */
export function mapGrade(look: EnvironmentLook): MapGrade {
  const g = look.grade;
  return {
    hazeColor: new Color(g.haze),
    tint: new Color(g.tint),
    aoHeight: g.aoHeight,
    aoFloor: g.aoFloor,
    floorSaturation: g.floorSaturation,
    layers: {
      gameplay: { saturation: g.gameplay[0], gain: g.gameplay[1], haze: 0, hazePerM: 0, hazeMax: 0 },
      mid: { saturation: g.mid[0], gain: g.mid[1], haze: g.mid[2], hazePerM: g.mid[3], hazeMax: 0.6 },
      far: { saturation: g.far[0], gain: g.far[1], haze: g.far[2], hazePerM: g.far[3], hazeMax: 0.85 },
    },
  };
}
