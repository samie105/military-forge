/**
 * Map mechanics catalogue (docs/02 §20): zone and event kinds with their defaults, colours and
 * editor fields. The sim reads the defaults (a zone or event that leaves a field out gets its
 * kind's value), so this file is content: it is part of CONTENT_HASH.
 */
import type { MapEventDef, MapEventKind, MapModifiers, MapZone, ZoneKind } from './types';

/** A modifier the map editor shows, with the range the map compiler accepts. */
export interface ModifierField {
  key: keyof MapModifiers;
  label: string;
  unit: string;
  /** inclusive limits (each component, for vectors) */
  min: number;
  max: number;
  step: number;
}

export const MODIFIER_FIELDS: readonly ModifierField[] = [
  { key: 'gravityMul', label: 'Gravity', unit: '×', min: -2, max: 3, step: 0.05 },
  { key: 'fuelBurnMul', label: 'Fuel burn', unit: '×', min: 0, max: 4, step: 0.05 },
  { key: 'fuelRegenMul', label: 'Fuel refill', unit: '×', min: 0, max: 5, step: 0.1 },
  { key: 'bulletRangeMul', label: 'Bullet range', unit: '×', min: 0.05, max: 4, step: 0.05 },
  { key: 'moveSpeedMul', label: 'Move speed', unit: '×', min: 0.1, max: 3, step: 0.05 },
  { key: 'knockbackMul', label: 'Knockback', unit: '×', min: 0, max: 4, step: 0.1 },
  { key: 'drag', label: 'Drag', unit: '1/s', min: 0, max: 10, step: 0.1 },
  { key: 'wind', label: 'Wind', unit: 'm/s²', min: -40, max: 40, step: 0.5 },
  { key: 'dive', label: 'Dive', unit: 'm/s²', min: 0, max: 60, step: 1 },
  { key: 'jetDisabled', label: 'Jetpacks off', unit: '', min: 0, max: 1, step: 1 },
];

/** Pad launch speed limit (m/s, each component): the knockback cap. */
export const MAX_LAUNCH = 26;

/** Every modifier filled in: what a zone, an event or a map-wide rule set actually does. */
export interface ResolvedModifiers {
  gravityMul: number;
  fuelBurnMul: number;
  fuelRegenMul: number;
  bulletRangeMul: number;
  moveSpeedMul: number;
  knockbackMul: number;
  drag: number;
  windX: number;
  windY: number;
  dive: number;
  jetDisabled: boolean;
}

export const NEUTRAL_MODIFIERS: Readonly<ResolvedModifiers> = Object.freeze({
  gravityMul: 1,
  fuelBurnMul: 1,
  fuelRegenMul: 1,
  bulletRangeMul: 1,
  moveSpeedMul: 1,
  knockbackMul: 1,
  drag: 0,
  windX: 0,
  windY: 0,
  dive: 0,
  jetDisabled: false,
});

type ZoneDefaults = MapModifiers & { launch?: [number, number] };

export interface ZoneKindInfo {
  label: string;
  /** what it does, for the editor and the docs */
  description: string;
  /** debug overlay and 3D tint, 0xRRGGBB */
  color: number;
  /** effect values for the fields a zone of this kind leaves out */
  defaults: ZoneDefaults;
}

export const ZONE_KINDS: Readonly<Record<ZoneKind, ZoneKindInfo>> = {
  zeroG: {
    label: 'Zero-g',
    description: 'No gravity: you drift on what speed you have. Hold Down to dive.',
    color: 0x56d4dd,
    defaults: { gravityMul: 0, drag: 0.4, dive: 14 },
  },
  lowG: { label: 'Low gravity', description: 'Gravity at a third: long jumps and slow falls.', color: 0xa371f7, defaults: { gravityMul: 0.35 } },
  reverseG: {
    label: 'Reversed gravity',
    description: 'Gravity pulls up. Hold Down to fight it; you bob at the top edge.',
    color: 0xf778ba,
    defaults: { gravityMul: -0.6, dive: 30, drag: 1.5 },
  },
  longFlight: { label: 'Long flight', description: 'Jet fuel burns at 40%: flights last 2.5× longer.', color: 0x3fb950, defaults: { fuelBurnMul: 0.4 } },
  damping: { label: 'Bullet fog', description: 'Bullets crossing it use up their range 3× faster.', color: 0xb1bac4, defaults: { bulletRangeMul: 0.35 } },
  wind: { label: 'Wind', description: 'A steady push on fliers and grenades.', color: 0x79c0ff, defaults: { wind: [12, 0] } },
  slow: { label: 'Mud', description: 'Slow going: speed caps at 45%, heavy drag.', color: 0x9e6a03, defaults: { moveSpeedMul: 0.45, drag: 3 } },
  water: {
    label: 'Deep water',
    description: 'Slow, floaty and draggy; bullets die in it.',
    color: 0x1f6feb,
    defaults: { moveSpeedMul: 0.6, gravityMul: 0.45, drag: 1.5, bulletRangeMul: 0.4 },
  },
  jumpPad: { label: 'Jump pad', description: 'Launches you straight up.', color: 0xe3b341, defaults: { launch: [0, 16] } },
  boostPad: { label: 'Boost pad', description: 'Throws you forward in a long, low arc.', color: 0xff7b72, defaults: { launch: [16, 9] } },
  emp: { label: 'EMP field', description: 'Jetpacks cut out inside.', color: 0xd2a8ff, defaults: { jetDisabled: true } },
  custom: { label: 'Custom', description: 'Only the effects you set.', color: 0x8b949e, defaults: {} },
};

type EventDefaults = Required<Pick<MapEventDef, 'name' | 'description' | 'duration' | 'warning'>> &
  MapModifiers &
  Pick<MapEventDef, 'gustPeriod' | 'windFlip' | 'pickOneZone'>;

export interface EventKindInfo {
  label: string;
  /** banner and debug colour, 0xRRGGBB */
  color: number;
  defaults: EventDefaults;
}

export const EVENT_KINDS: Readonly<Record<MapEventKind, EventKindInfo>> = {
  gravitySurge: {
    label: 'Gravity surge',
    color: 0xff7b72,
    defaults: { name: 'GRAVITY SURGE', description: 'Everything is heavier: jets climb slowly', duration: 15, warning: 3, gravityMul: 1.8 },
  },
  lowGravity: {
    label: 'Low gravity',
    color: 0xa371f7,
    defaults: { name: 'LOW GRAVITY', description: 'Everything floats: long jumps, slow falls', duration: 15, warning: 3, gravityMul: 0.35 },
  },
  emp: {
    label: 'EMP storm',
    color: 0xd2a8ff,
    defaults: { name: 'EMP STORM', description: 'Jetpacks offline', duration: 8, warning: 4, jetDisabled: true },
  },
  fog: {
    label: 'Fog bank',
    color: 0xb1bac4,
    defaults: { name: 'FOG BANK', description: 'Bullets fall short', duration: 20, warning: 3, bulletRangeMul: 0.4 },
  },
  gust: {
    label: 'Wind gusts',
    color: 0x79c0ff,
    defaults: { name: 'WIND GUSTS', description: 'Gusts throw fliers and grenades sideways', duration: 15, warning: 3, wind: [16, 0], gustPeriod: 3, windFlip: true },
  },
  flip: {
    label: 'Gravity pocket',
    color: 0xf778ba,
    defaults: { name: 'GRAVITY POCKET', description: 'Gravity flips inside the marked zone', duration: 15, warning: 4, pickOneZone: true },
  },
  custom: { label: 'Custom', color: 0x8b949e, defaults: { name: 'MAP EVENT', description: '', duration: 10, warning: 3 } },
};

/** `explicit` over `defaults` over neutral, field by field (an explicit undefined is "left out"). */
export function resolveModifiers(explicit: MapModifiers, defaults: MapModifiers = {}): ResolvedModifiers {
  const wind = explicit.wind ?? defaults.wind;
  return {
    gravityMul: explicit.gravityMul ?? defaults.gravityMul ?? 1,
    fuelBurnMul: explicit.fuelBurnMul ?? defaults.fuelBurnMul ?? 1,
    fuelRegenMul: explicit.fuelRegenMul ?? defaults.fuelRegenMul ?? 1,
    bulletRangeMul: explicit.bulletRangeMul ?? defaults.bulletRangeMul ?? 1,
    moveSpeedMul: explicit.moveSpeedMul ?? defaults.moveSpeedMul ?? 1,
    knockbackMul: explicit.knockbackMul ?? defaults.knockbackMul ?? 1,
    drag: explicit.drag ?? defaults.drag ?? 0,
    windX: wind ? wind[0] : 0,
    windY: wind ? wind[1] : 0,
    dive: explicit.dive ?? defaults.dive ?? 0,
    jetDisabled: explicit.jetDisabled ?? defaults.jetDisabled ?? false,
  };
}

export interface ResolvedZone extends ResolvedModifiers {
  /** pad launch [x, y] in m/s, null for zones that aren't pads */
  launch: [number, number] | null;
}

export function resolveZone(zone: MapZone): ResolvedZone {
  const defaults = Object.hasOwn(ZONE_KINDS, zone.kind) ? ZONE_KINDS[zone.kind].defaults : {};
  return { ...resolveModifiers(zone, defaults), launch: zone.launch ?? defaults.launch ?? null };
}

export interface ResolvedEvent extends ResolvedModifiers {
  name: string;
  description: string;
  duration: number;
  warning: number;
  /** 0 = steady wind */
  gustPeriod: number;
  windFlip: boolean;
  pickOneZone: boolean;
}

export function resolveEvent(def: MapEventDef): ResolvedEvent {
  const d = Object.hasOwn(EVENT_KINDS, def.kind) ? EVENT_KINDS[def.kind].defaults : EVENT_KINDS.custom.defaults;
  return {
    ...resolveModifiers(def, d),
    name: def.name ?? d.name,
    description: def.description ?? d.description,
    duration: def.duration ?? d.duration,
    warning: def.warning ?? d.warning,
    gustPeriod: def.gustPeriod ?? d.gustPeriod ?? 0,
    windFlip: def.windFlip ?? d.windFlip ?? false,
    pickOneZone: def.pickOneZone ?? d.pickOneZone ?? false,
  };
}

/** A zone's polygon as flat points (a rect becomes its four corners, counter-clockwise). */
export function zonePoints(zone: MapZone): number[] {
  if (zone.rect) {
    const [x0, y0, x1, y1] = zone.rect;
    return [x0, y0, x1, y0, x1, y1, x0, y1];
  }
  return zone.points ?? [];
}

/** True when a modifier set changes nothing. */
export function isNeutral(m: Readonly<ResolvedModifiers>): boolean {
  const n = NEUTRAL_MODIFIERS;
  return (
    m.gravityMul === n.gravityMul &&
    m.fuelBurnMul === n.fuelBurnMul &&
    m.fuelRegenMul === n.fuelRegenMul &&
    m.bulletRangeMul === n.bulletRangeMul &&
    m.moveSpeedMul === n.moveSpeedMul &&
    m.knockbackMul === n.knockbackMul &&
    m.drag === n.drag &&
    m.windX === n.windX &&
    m.windY === n.windY &&
    m.dive === n.dive &&
    m.jetDisabled === n.jetDisabled
  );
}
