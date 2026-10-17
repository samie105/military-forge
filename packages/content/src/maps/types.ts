/**
 * Authoring format for maps (docs/02 §4). Solid regions are closed polygons; the map compiler
 * in @military-forge/sim turns them into collision segments with outward normals.
 */
export const Material = {
  Concrete: 0,
  Metal: 1,
  Wood: 2,
  Dirt: 3,
  Glass: 4,
} as const;
export type Material = (typeof Material)[keyof typeof Material];

export interface MapPolygon {
  /** flat [x0, y0, x1, y1, ...]; either winding (the compiler normalises to CCW) */
  points: number[];
  material?: Material;
}

/** A platform you can fly up through and land on; drop through by holding down. */
export interface MapOneWay {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface MapLabel {
  x: number;
  y: number;
  text: string;
}

export type DummyScript =
  | { kind: 'idle' }
  | { kind: 'crouch'; periodTicks: number }
  | { kind: 'strafe'; minX: number; maxX: number }
  | { kind: 'jet'; periodTicks: number; burstTicks: number }
  | { kind: 'strafeJet'; minX: number; maxX: number; periodTicks: number; burstTicks: number };

export interface DummySpawn {
  name: string;
  x: number;
  y: number;
  script: DummyScript;
}

export interface MapDef {
  id: string;
  name: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  solids: MapPolygon[];
  oneWays: MapOneWay[];
  /** feet positions for human players */
  spawns: { x: number; y: number }[];
  dummies: DummySpawn[];
  labels: MapLabel[];
}
