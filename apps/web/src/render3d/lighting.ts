/**
 * Per-map lighting presets (docs/11 §2: one hemisphere + one directional light, baked AO in vertex
 * colours) and palettes (§4: low-saturation background, mid gameplay plane, players loudest).
 */
export interface LightingPreset {
  /** sky gradient, top → horizon */
  sky: [number, number];
  fog: { color: number; near: number; far: number };
  hemi: { sky: number; ground: number; intensity: number };
  sun: { color: number; intensity: number; dir: [number, number, number] };
  palette: {
    /** front faces by sim material: concrete, metal, wood, dirt, glass */
    front: number[];
    /** walkable tops by sim material */
    cap: number[];
    oneWay: number;
    /** ground plane behind the gameplay band */
    ground: number;
    /** mid-depth blocks */
    mid: number[];
    /** far skyline cards */
    far: number;
    /** foreground railings */
    fore: number;
  };
}

/** A dusky test yard: dark enough that the white debug HUD text stays readable over the sky. */
const YARD: LightingPreset = {
  sky: [0x3d4b5c, 0x93a1ab],
  fog: { color: 0x8796a1, near: 45, far: 150 },
  hemi: { sky: 0xdfe8f0, ground: 0x5d5546, intensity: 1.6 },
  sun: { color: 0xfff0d8, intensity: 2.0, dir: [-0.45, 0.8, 0.4] },
  palette: {
    front: [0x6f6a62, 0x5e6a74, 0x7a5a3e, 0x6b543c, 0x6f8a99],
    cap: [0x9a958a, 0x8a98a3, 0xa47c55, 0x6f8a3e, 0x9cc0d0],
    oneWay: 0xd9a42a,
    ground: 0x58604a,
    mid: [0x8b96a0, 0x98928a, 0x86919b, 0x9a9c90],
    far: 0x7d8b97,
    fore: 0x2f3338,
  },
};

const PRESETS: Readonly<Record<string, LightingPreset>> = {
  'movement-test': YARD,
};

export function lightingFor(mapId: string): LightingPreset {
  return PRESETS[mapId] ?? YARD;
}
