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

/**
 * What a map does to the rules (docs/02 §20). The same fields work map-wide (MapDef.rules), inside
 * a zone (MapZone) and while a map event runs (MapEventDef). All optional: absent is neutral.
 * Where several apply, multipliers multiply (rules × event × each zone the body is in), drag and
 * wind add, dive takes the strongest, and jetDisabled is on if anything says so.
 */
export interface MapModifiers {
  /** gravity on players and grenades: 0 = zero-g, 0.4 = low-g, negative = pulled upward */
  gravityMul?: number;
  /** jet fuel burned per second: below 1, flights last longer */
  fuelBurnMul?: number;
  /** fuel refill speed, ground and air */
  fuelRegenMul?: number;
  /**
   * Hitscan range and falloff distances (> 0). Map-wide or in an event: every bullet's range. In a
   * zone: bullets crossing it use up their range 1/m times faster per metre (fog, water).
   */
  bulletRangeMul?: number;
  /** walk, crouch, air and jet speed caps */
  moveSpeedMul?: number;
  /** pushes from blasts, bullets and melee; above 1 it also raises the knockback speed cap */
  knockbackMul?: number;
  /** 1/s: airborne players and grenades lose speed at e^(−drag·t) (water, mud, thick air) */
  drag?: number;
  /** m/s², [x, y]: a steady push on airborne players and grenades */
  wind?: [number, number];
  /** m/s²: holding Down in the air pushes you down (zero-g, fighting reversed gravity) */
  dive?: number;
  /** jetpacks cut out (EMP) */
  jetDisabled?: boolean;
}

/** Zone presets (ZONE_KINDS in mechanics.ts holds each kind's defaults, colour and editor fields). */
export type ZoneKind =
  | 'zeroG'
  | 'lowG'
  | 'reverseG'
  | 'longFlight'
  | 'damping'
  | 'wind'
  | 'slow'
  | 'water'
  | 'jumpPad'
  | 'boostPad'
  | 'emp'
  | 'custom';

/**
 * An area that changes the rules for whatever is in it: players (their body centre), grenades
 * (their centre) and bullets (the part of the ray inside it). `kind` picks the look and the
 * defaults for every effect field left out (ZONE_KINDS); fields given here override them.
 */
export interface MapZone extends MapModifiers {
  /** unique within the map */
  id: string;
  kind: ZoneKind;
  /** an axis-aligned box [minX, minY, maxX, maxY]… */
  rect?: [number, number, number, number];
  /** …or a polygon, flat [x0, y0, x1, y1, …], either winding (exactly one of rect/points) */
  points?: number[];
  /** pads, m/s [x, y]: touching the zone raises your speed along this direction to at least its length */
  launch?: [number, number];
  /** only on while this map event is active (an event zone), e.g. a reversed-gravity pocket */
  event?: string;
  /** shown in the debug overlay */
  label?: string;
}

/** Event presets (EVENT_KINDS in mechanics.ts holds each kind's defaults and colour). */
export type MapEventKind = 'gravitySurge' | 'lowGravity' | 'emp' | 'fog' | 'gust' | 'flip' | 'custom';

/**
 * Something that just happens to the whole map for a while: its modifiers apply map-wide, and its
 * event zones switch on. `kind` supplies the defaults for every field left out (EVENT_KINDS).
 */
export interface MapEventDef extends MapModifiers {
  /** unique within the map */
  id: string;
  kind: MapEventKind;
  /** banner title, e.g. "EMP STORM" */
  name?: string;
  /** banner line, e.g. "Jetpacks offline" */
  description?: string;
  /** seconds it lasts */
  duration?: number;
  /** seconds of "incoming" banner before it starts */
  warning?: number;
  /** wind gusts: the wind swells from nothing to full and back every this many seconds */
  gustPeriod?: number;
  /** the wind blows the other way on some occurrences (seeded) */
  windFlip?: boolean;
  /** of the zones tied to this event (MapZone.event), switch on one per occurrence (seeded), not all */
  pickOneZone?: boolean;
}

/** When events happen: a function of the room seed and the tick only, so every client predicts it. */
export type MapEventSchedule =
  | {
      /** every `cycle` seconds from `start`, at most one event, at a seeded moment, picked by weight */
      kind: 'random';
      start: number;
      cycle: number;
      /** chance (0–1) that a cycle has an event (default 1) */
      chance?: number;
      /** by event id; events not listed weigh 1, 0 leaves one out */
      weights?: Record<string, number>;
    }
  | {
      /** scripted: each entry's event starts `at` seconds after `start` (its warning before that) */
      kind: 'timeline';
      start?: number;
      /** repeat the whole timeline every this many seconds */
      loop?: number;
      entries: { at: number; event: string }[];
    };

export interface MapEvents {
  defs: MapEventDef[];
  schedule: MapEventSchedule;
}

/**
 * Random pickups (docs/03 §12): a spawner owns a few spots and shares one timer between them. When
 * the timer fires, the game's seeded PRNG picks one of the free spots and an item from the pool,
 * so items turn up at random places and times. A spawner with one spot is a classic fixed spawn.
 */
export interface MapSpawner {
  /** for debug views and logs */
  id: string;
  /** SPAWN_POOLS id (pickups.ts): what can appear */
  pool: string;
  /** where an item can appear: the point it rests on (on the floor) */
  spots: { x: number; y: number }[];
  /** seconds before the first item, uniformly random in [min, max] */
  first: [number, number];
  /** seconds from an item being taken until the next one appears, uniformly random in [min, max] */
  respawn: [number, number];
  /** items from this spawner on the map at once (default 1, at most spots.length) */
  maxActive?: number;
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
  /** map-wide modifiers, e.g. low gravity everywhere (docs/02 §20) */
  rules?: MapModifiers;
  /** areas that change the rules inside them */
  zones?: MapZone[];
  /** things that just happen, on a seeded schedule */
  events?: MapEvents;
  /** pickup spawners (docs/03 §12); a map without them plays exactly as before */
  spawners?: MapSpawner[];
}
