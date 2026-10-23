/**
 * The owner's admin page (pnpm playtest → /admin): every gameplay number it may change, with its
 * range and default, and how a set of changes ("admin values") is applied.
 *
 * Admin values are a flat map `{ key: number }` holding only what differs from the defaults
 * (`weapon.k47.damage`, `tuning.gravity`, `bots.count`…), so they are easy to clamp, save, copy and
 * diff. Fields come in three scopes:
 * - `tuning`: a Tuning key; the game server sets every room's tuning from them (sent as TUNING);
 * - `content`: a number on a weapon, grenade or projectile definition, changed in place in this
 *   module's objects (`applyContentOverrides`) on the server and, from the OVERRIDES message, on
 *   every client, so the sim and its prediction read the same numbers;
 * - `server`: pickups, bots, the match and lag compensation, which only the game server runs.
 * Every range stays inside what the protocol carries (a magazine fits u8, a fuse u9 ticks, a
 * flashbang's white-out the blind ticks, and so on).
 */
import { EMP, FLASHBANG, FRAG, GAS, MINE, SMOKE, grenades, type GrenadeDef } from './grenades';
import { fluxLabMap } from './maps/fluxLab';
import { lunarOutpostMap } from './maps/lunarOutpost';
import { mechanicsTestMap } from './maps/mechanicsTest';
import { movementTestMap } from './maps/movementTest';
import { stormFrontMap } from './maps/stormFront';
import { streetMarketMap } from './maps/streetMarket';
import { ARMORY_RESPAWN_RANGE, POWER_WEAPONS, SPAWN_POOLS } from './pickups';
import { TUNING_GROUPS, defaultTuning, type Tuning } from './tuning';
import { weapons, type WeaponDef } from './weapons';

export type AdminScope = 'tuning' | 'content' | 'server';

export interface AdminField {
  /** unique, stable: the key in admin values (`weapon.k47.damage`) */
  key: string;
  /** top-level group on the page, and the section inside it (a gun, a grenade type) */
  group: string;
  section: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** the shipped value */
  def: number;
  scope: AdminScope;
  /** content fields: the live value and how to set it (server fields have neither) */
  get?: () => number;
  set?: (v: number) => void;
  /** a Tuning key (scope 'tuning') */
  tuningKey?: keyof Tuning;
}

/** The admin's changed values: key → number. */
export type AdminValues = Record<string, number>;

const fields: AdminField[] = [];

function add(f: Omit<AdminField, 'def'> & { def?: number }): void {
  const def = f.def ?? f.get!();
  fields.push({ ...f, def });
}

/** A number field on an object (the object is the live content definition). */
function prop<T extends object, K extends keyof T>(group: string, section: string, key: string, label: string, obj: T, name: K, min: number, max: number, step: number, also?: (v: number) => void): void {
  add({
    key,
    group,
    section,
    label,
    min,
    max,
    step,
    scope: 'content',
    get: () => obj[name] as number,
    set: (v) => {
      (obj as Record<K, number>)[name] = v;
      also?.(v);
    },
  });
}

// ---------- movement, jetpack, dash, blast launch, grenade throws, health: the tuning panel's fields ----------

for (const group of TUNING_GROUPS) {
  for (const f of group.fields) {
    add({ key: `tuning.${f.key}`, group: 'Movement & feel', section: group.title, label: f.label, min: f.min, max: f.max, step: f.step, def: defaultTuning[f.key], scope: 'tuning', tuningKey: f.key });
  }
}

// ---------- weapons ----------

/** Damage a gun deals, wherever its definition keeps it (a launcher's projectile, a blade's swing). */
function damageField(w: WeaponDef): void {
  const g = 'Weapons';
  const p = w.projectile;
  if (w.fireMode === 'melee') return prop(g, w.name, `weapon.${w.id}.damage`, 'Damage (a swing)', w, 'meleeDamage', 0, 250, 1);
  if (!p) return prop(g, w.name, `weapon.${w.id}.damage`, w.pellets > 1 ? 'Damage per pellet' : 'Damage', w, 'damage', 0, 250, 1);
  if (p.damage > 0) return prop(g, w.name, `weapon.${w.id}.damage`, p.players === 'consume' ? 'Damage per flame' : 'Direct hit damage', p, 'damage', 0, 250, 1, (v) => (w.damage = v));
  if (p.explosion) return prop(g, w.name, `weapon.${w.id}.damage`, 'Blast damage', p.explosion, 'maxDamage', 0, 300, 1, (v) => (w.damage = v));
}

for (const w of weapons) {
  const g = 'Weapons';
  const s = w.name;
  const k = (name: string) => `weapon.${w.id}.${name}`;
  damageField(w);
  // a melee weapon's interval is its swing, whose ticks travel as meleeTicks u6 (63): at most 1 s;
  // a gun's is its cooldown, 18 bits of 1/1024 tick (255 ticks): at most 3 s
  if (w.fireMode === 'melee') prop(g, s, k('interval'), 'Seconds between swings', w, 'interval', 0.2, 1, 0.01);
  else prop(g, s, k('interval'), w.burst ? 'Seconds between bursts' : 'Seconds between shots', w, 'interval', 0.05, 3, 0.01);
  if (w.fireMode !== 'melee') {
    if (!w.projectile || w.spread.base > 0) prop(g, s, k('spread'), 'Spread (± degrees)', w.spread, 'base', 0, 30, 0.1);
    if (!w.projectile) {
      prop(g, s, k('range'), 'Range (m)', w, 'range', 1, 120, 0.5);
      prop(g, s, k('falloffStart'), 'Falloff starts at (m)', w, 'falloffStart', 0, 120, 0.5);
      prop(g, s, k('minDamageMul'), 'Damage at full range (×)', w, 'minDamageMul', 0, 1, 0.05);
    }
    prop(g, s, k('mag'), w.regen ? 'Tank / cell' : 'Magazine', w, 'mag', 1, 250, 1);
    if (w.reserve > 0) prop(g, s, k('reserve'), 'Reserve', w, 'reserve', 0, 999, 1);
    if (w.reload > 0) prop(g, s, k('reload'), 'Reload (s)', w, 'reload', 0, 10, 0.05);
  } else prop(g, s, k('range'), 'Reach (m)', w, 'range', 0.3, 3, 0.05);
  prop(g, s, k('equip'), 'Equip time (s)', w, 'equip', 0, 3, 0.05);
  prop(g, s, k('recoilPushAir'), 'Recoil push in the air (m/s)', w, 'recoilPushAir', 0, 20, 0.1);
  prop(g, s, k('recoilPushGround'), 'Recoil slide on the ground (m/s)', w, 'recoilPushGround', 0, 20, 0.1);
  prop(g, s, k('moveSpeedMul'), 'Move speed while held (×)', w, 'moveSpeedMul', 0.3, 1.5, 0.01);
  if (w.charge !== undefined) prop(g, s, k('charge'), 'Charge (s)', w, 'charge', 0.05, 4, 0.05);
  if (w.spin) {
    prop(g, s, k('spinUp'), 'Spin-up (s)', w.spin, 'up', 0.05, 5, 0.05);
    prop(g, s, k('spinDown'), 'Spin-down (s)', w.spin, 'down', 0.05, 5, 0.05);
  }
  const p = w.projectile;
  if (p) {
    prop(g, s, k('projectileSpeed'), `${p.name} speed (m/s)`, p, 'speed', 1, 60, 0.5);
    prop(g, s, k('projectileLife'), `${p.name} life (s)`, p, 'life', 0.1, 8, 0.05); // fuse u9: 511 ticks
    if (p.explosion && p.damage > 0) prop(g, s, k('blastDamage'), 'Blast damage', p.explosion, 'maxDamage', 0, 300, 1);
    if (p.explosion) prop(g, s, k('blastRadius'), 'Blast radius (m)', p.explosion, 'radius', 0.5, 12, 0.1);
    if (p.emp) {
      prop(g, s, k('empRadius'), 'EMP radius (m)', p.emp, 'radius', 0.5, 12, 0.1);
      prop(g, s, k('empSeconds'), 'Jetpacks dead for (s)', p.emp, 'jetDisable', 0, 4, 0.1); // jetDisabledTicks u8
    }
    if (p.burn) {
      prop(g, s, k('burnDps'), 'Burning, damage per second', p.burn, 'dps', 0, 30, 0.5);
      prop(g, s, k('burnSeconds'), 'Burning for (s)', p.burn, 'seconds', 0, 2, 0.05); // burnTicks u7
    }
  }
}

// ---------- grenades ----------

function grenadeFields(gdef: GrenadeDef): void {
  const g = 'Grenades';
  const s = gdef.name;
  const k = (name: string) => `grenade.${gdef.id}.${name}`;
  prop(g, s, k('throwSpeed'), 'Throw speed (m/s)', gdef, 'throwSpeed', 3, 40, 0.1);
  prop(g, s, k('fuse'), gdef.effect === 'mine' ? 'Straight flight (s)' : 'Fuse (s)', gdef, 'fuse', 0.1, 6, 0.05); // fuse u9
  switch (gdef.effect) {
    case 'explode':
      prop(g, s, k('radius'), 'Blast radius (m)', gdef.explosion, 'radius', 0.5, 12, 0.1);
      prop(g, s, k('damage'), 'Damage', gdef.explosion, 'maxDamage', 0, 300, 1);
      prop(g, s, k('impulse'), 'Push (m/s)', gdef.explosion, 'impulse', 0, 60, 0.5);
      break;
    case 'cloud':
      prop(g, s, k('radius'), 'Cloud radius (m)', gdef.cloud, 'radius', 1, 10, 0.1);
      prop(g, s, k('duration'), 'Cloud lasts (s)', gdef.cloud, 'duration', 2, 17, 0.5); // cloud age u10: 1023 ticks
      prop(g, s, k('grow'), 'Cloud grows in (s)', gdef.cloud, 'grow', 0, 5, 0.1);
      prop(g, s, k('fade'), 'Cloud fades over (s)', gdef.cloud, 'fade', 0, 5, 0.1);
      if (gdef.cloud.dpsCore > 0) {
        prop(g, s, k('dpsCore'), 'Damage per second, centre', gdef.cloud, 'dpsCore', 0, 60, 0.5);
        prop(g, s, k('dpsEdge'), 'Damage per second, edge', gdef.cloud, 'dpsEdge', 0, 60, 0.5);
      }
      break;
    case 'flash':
      prop(g, s, k('radius'), 'Reach (m)', gdef.flash, 'radius', 2, 40, 0.5);
      prop(g, s, k('white'), 'Full white (s)', gdef.flash, 'white', 0, 2.5, 0.05); // blindTicks u8, with the fade
      prop(g, s, k('fadeOut'), 'Fade out (s)', gdef.flash, 'fade', 0, 1.75, 0.05); // blindFade u7
      break;
    case 'mine':
      prop(g, s, k('arm'), 'Arms after (s)', gdef.mine, 'arm', 0, 5, 0.1);
      prop(g, s, k('triggerRadius'), 'Trigger radius (m)', gdef.mine, 'triggerRadius', 0.3, 5, 0.1);
      prop(g, s, k('radius'), 'Blast radius (m)', gdef.mine.explosion, 'radius', 0.5, 12, 0.1);
      prop(g, s, k('damage'), 'Damage', gdef.mine.explosion, 'maxDamage', 0, 300, 1);
      break;
    case 'emp':
      prop(g, s, k('radius'), 'EMP radius (m)', gdef.emp, 'radius', 0.5, 12, 0.1);
      prop(g, s, k('jetDisable'), 'Jetpacks dead for (s)', gdef.emp, 'jetDisable', 0, 4, 0.1); // jetDisabledTicks u8
      break;
  }
}
for (const gdef of grenades) grenadeFields(gdef);

// ---------- pickups (the server's) ----------

const ALL_MAPS = [movementTestMap, mechanicsTestMap, lunarOutpostMap, stormFrontMap, fluxLabMap, streetMarketMap];
const crateSpawners = () => ALL_MAPS.flatMap((m) => (m.spawners ?? []).filter((s) => s.pool === 'weapons'));
const weaponPool = SPAWN_POOLS.weapons!;
const poolWeight = (power: boolean) => () => weaponPool.items.find((i) => POWER_WEAPONS.has(i.pickup.slice('weapon:'.length)) === power)?.weight ?? 0;
const setPoolWeight = (power: boolean) => (v: number) => {
  for (const it of weaponPool.items as { pickup: string; weight: number }[]) if (POWER_WEAPONS.has(it.pickup.slice('weapon:'.length)) === power) it.weight = v;
};
add({ key: 'pickups.everydayWeight', group: 'Pickups', section: 'Weapon crates', label: 'Everyday guns: weight', min: 1, max: 10, step: 1, scope: 'server', get: poolWeight(false), set: setPoolWeight(false) });
add({ key: 'pickups.powerWeight', group: 'Pickups', section: 'Weapon crates', label: 'Power weapons: weight (0: never)', min: 0, max: 10, step: 1, scope: 'server', get: poolWeight(true), set: setPoolWeight(true) });
add({
  key: 'pickups.crateRespawnMin',
  group: 'Pickups',
  section: 'Weapon crates',
  label: 'Next crate after, at least (s)',
  min: 1,
  max: 120,
  step: 1,
  scope: 'server',
  get: () => crateSpawners()[0]?.respawn[0] ?? 12,
  set: (v) => {
    for (const s of crateSpawners()) s.respawn = [v, Math.max(v, s.respawn[1])];
  },
});
add({
  key: 'pickups.crateRespawnMax',
  group: 'Pickups',
  section: 'Weapon crates',
  label: 'Next crate after, at most (s)',
  min: 1,
  max: 120,
  step: 1,
  scope: 'server',
  get: () => crateSpawners()[0]?.respawn[1] ?? 18,
  set: (v) => {
    for (const s of crateSpawners()) s.respawn = [Math.min(v, s.respawn[0]), v];
  },
});
add({
  key: 'pickups.armoryRespawn',
  group: 'Pickups',
  section: 'Test armory',
  label: 'A rack gun is back after (s)',
  min: 0.5,
  max: 60,
  step: 0.5,
  scope: 'server',
  get: () => ARMORY_RESPAWN_RANGE[0],
  set: (v) => {
    ARMORY_RESPAWN_RANGE[0] = v;
    ARMORY_RESPAWN_RANGE[1] = v;
  },
});

// ---------- bots and the match (the server's; the game server reads their values) ----------

/** Bot levels by the `bots.level` value. */
export const ADMIN_BOT_LEVELS = ['easy', 'normal', 'hard'] as const;
add({ key: 'bots.count', group: 'Bots & match', section: 'Bots', label: 'Fill rooms to (players, 0: no bots)', min: 0, max: 16, step: 1, def: 0, scope: 'server' });
add({ key: 'bots.level', group: 'Bots & match', section: 'Bots', label: 'Level (0 easy, 1 normal, 2 hard)', min: 0, max: 2, step: 1, def: 1, scope: 'server' });
add({ key: 'match.timeLimit', group: 'Bots & match', section: 'Match', label: 'Time limit (s)', min: 60, max: 1200, step: 30, def: 300, scope: 'server' });
add({ key: 'match.killLimit', group: 'Bots & match', section: 'Match', label: 'Kill limit', min: 5, max: 100, step: 1, def: 20, scope: 'server' });

// ---------- the network (the server's) ----------

// lag compensation's latency cap (netcode LAG_COMP_LATENCY_CAP_MS; a server's LAG_COMP_LATENCY_MS):
// shots are rewound for this much latency, plus the most the shooter's view can lag (200 ms)
add({ key: 'net.lagCompMs', group: 'Network', section: 'Lag compensation', label: 'Rewind shots for up to this much latency (ms; the view delay, 200 ms, comes on top)', min: 0, max: 1000, step: 10, def: 250, scope: 'server' });

/** Every field the admin page offers, in page order. */
export const ADMIN_FIELDS: readonly AdminField[] = fields;
const byKey = new Map(fields.map((f) => [f.key, f]));

/** The field for `key`, or undefined. */
export function adminField(key: string): AdminField | undefined {
  return byKey.get(key);
}

/**
 * A server field's default as this server runs it (its bots and match limits come from its own
 * options): the page shows it, and a value equal to it counts as unchanged.
 */
export function setAdminDefault(key: string, v: number): void {
  const f = byKey.get(key);
  if (f && f.scope === 'server' && !f.set) f.def = clampAdminValue(f, v);
}

/** `v` kept inside the field's range, on its step for whole-number fields. */
export function clampAdminValue(f: AdminField, v: number): number {
  const within = Math.min(f.max, Math.max(f.min, v));
  return Number.isInteger(f.step) ? Math.round(within) : within;
}

/**
 * Admin values out of an untrusted edit: known keys, finite numbers, inside each range; values
 * equal to the default are dropped (only changes are kept).
 */
export function clampAdmin(raw: unknown): AdminValues {
  const src = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: AdminValues = {};
  for (const [key, v] of Object.entries(src)) {
    const f = byKey.get(key);
    if (!f || typeof v !== 'number' || !Number.isFinite(v)) continue;
    const c = clampAdminValue(f, v);
    if (c !== f.def) out[key] = c;
  }
  // the crate respawn's two ends stay in order
  const lo = out['pickups.crateRespawnMin'];
  const hi = out['pickups.crateRespawnMax'];
  if (lo !== undefined && hi !== undefined && lo > hi) out['pickups.crateRespawnMax'] = lo;
  return out;
}

/**
 * Puts the content numbers of `values` in place (scope 'content'; 'server' too when `server`), and
 * every other content field back to its default. Applying `{}` restores the shipped game. The game
 * server applies the server fields as well; clients only the content ones.
 */
export function applyContentOverrides(values: AdminValues, server = false): void {
  for (const f of fields) {
    if (!f.set || (f.scope === 'server' && !server)) continue;
    const v = values[f.key];
    f.set(v === undefined ? f.def : clampAdminValue(f, v));
  }
  // the crate respawn's ends again, in order, whatever order they were set in
  if (server) {
    const lo = values['pickups.crateRespawnMin'] ?? byKey.get('pickups.crateRespawnMin')!.def;
    const hi = Math.max(lo, values['pickups.crateRespawnMax'] ?? byKey.get('pickups.crateRespawnMax')!.def);
    for (const s of crateSpawners()) s.respawn = [lo, hi];
  }
}

/** The Tuning keys of `values` (scope 'tuning'). */
export function adminTuning(values: AdminValues): Partial<Tuning> {
  const out: Partial<Tuning> = {};
  for (const f of fields) {
    if (f.scope !== 'tuning' || f.tuningKey === undefined) continue;
    const v = values[f.key];
    if (v !== undefined) (out as Record<string, number>)[f.tuningKey] = clampAdminValue(f, v);
  }
  return out;
}

/** The value of `key` in `values`, or its default. */
export function adminValue(values: AdminValues, key: string): number {
  return values[key] ?? byKey.get(key)?.def ?? 0;
}

/**
 * Presets (the admin page's buttons). Classic is the shipped game; Floaty: low gravity, long
 * flights, slow falls, grenades that sail; Chaos: big blasts, fast guns, short respawns, launchers
 * everywhere.
 */
export const ADMIN_PRESETS: Readonly<Record<'classic' | 'floaty' | 'chaos', AdminValues>> = {
  classic: {},
  floaty: clampAdmin({
    'tuning.gravity': 9,
    'tuning.terminalVy': -12,
    'tuning.fuelMax': 300, // the most the range allows: ~1.5× the 196 default, as 220 was over 140
    'tuning.fuelBurn': 35,
    'tuning.jetThrust': 26,
    'tuning.airMaxX': 7.5,
    'tuning.airDragX': 0.6,
    'tuning.dashSpeed': 23, // ~15% over the 20 m/s default, as 16 was over 14
    'tuning.grenadeThrowScale': 1.3,
    [`grenade.${FRAG.id}.fuse`]: 2.6,
    [`grenade.${SMOKE.id}.duration`]: 16,
  }),
  chaos: clampAdmin({
    'tuning.blastImpulseScale': 1.8,
    'tuning.respawnDelay': 1,
    'tuning.healthRegen': 12,
    'tuning.fuelRegenGround': 90,
    'tuning.dashFuelCost': 8,
    [`grenade.${FRAG.id}.radius`]: 6,
    [`grenade.${FRAG.id}.impulse`]: 40,
    [`grenade.${GAS.id}.radius`]: 5,
    [`grenade.${FLASHBANG.id}.radius`]: 24,
    [`grenade.${MINE.id}.triggerRadius`]: 2.5,
    [`grenade.${EMP.id}.radius`]: 6,
    'weapon.k47.interval': 0.07,
    'weapon.buzz.interval': 0.06,
    'weapon.hammer44.interval': 0.35,
    'weapon.thumper.interval': 0.6,
    'weapon.thumper.mag': 6,
    'weapon.popper.blastRadius': 4,
    'weapon.ripper.charge': 0.2,
    'pickups.powerWeight': 6,
    'pickups.crateRespawnMin': 4,
    'pickups.crateRespawnMax': 8,
  }),
};
