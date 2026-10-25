/**
 * The HUD's numbers, as pure functions of the frame, the tuning and recent events, so they're
 * testable without a DOM. hud.ts turns them into elements.
 */
import { DRAGON, GRENADE_PICKUP_COUNT, HitZone, NO_WEAPON, RIOT_SHIELD, TUNING_GROUPS, defaultTuning, grenades, pickups as pickupDefs, weapons, type PickupDef, type Tuning, type WeaponDef } from '@military-forge/content';
import { DamageSource, type SimEvent } from '@military-forge/sim';
import { iconHref, weaponIcon } from '../ui/icons';
import type { MapEventView, PickupView, PlayerView, WeaponView } from '../view';
import { weaponUnderfoot } from '../weaponItems';

/**
 * What arsenal-b's PlayerView adds (#40 grenade belt, #44 flashbang, #47 EMP grenade; see
 * arsenal-b-interfaces.md). Absent until those land: the HUD reads them when they're there.
 */
export interface ArsenalFields {
  /** the selected grenade type (cycled with Btn.CycleGrenade) */
  grenadeType: number;
  /** grenades carried, by type: 0 frag, 1 smoke, 2 gas, 3 flashbang, 4 mine, 5 EMP */
  grenadeCounts: readonly number[];
  /** flashbang blindness 0..1 */
  blind: number;
  /** ticks of toxic-gas cough left */
  gasTicks: number;
  /** ticks the EMP grenade keeps the jetpack dead */
  jetDisabledTicks: number;
}

export type HudPlayer = PlayerView & Partial<ArsenalFields>;

/** The small badge after a kill-feed line (the kit's .kf__badge). */
export type FeedBadge = 'headshot' | 'ricochet' | 'blast' | 'fall' | 'suicide' | null;

export interface FeedEntry {
  key: number;
  killer: string;
  victim: string;
  /** what did it, in words: a weapon name, "melee", "frag", "mine", "gas", "fell" */
  how: string;
  /** what did it, as a sprite href ('#icon-wpn-widow', '#icon-g-frag', '#icon-melee'); '' = say `how` */
  icon: string;
  badge: FeedBadge;
  headshot: boolean;
  suicide: boolean;
  /** a fall (or the world): "Vikram fell" */
  fell: boolean;
  killerBot: boolean;
  victimBot: boolean;
  /** this player was in it */
  mine: 'killer' | 'victim' | null;
}

export function damageSourceName(source: number): string {
  if (source === DamageSource.Grenade) return 'frag';
  if (source === DamageSource.World) return 'fell';
  if (source === DamageSource.Melee) return 'melee';
  if (source === DamageSource.Mine) return 'mine';
  if (source === DamageSource.Gas) return 'gas';
  return weapons[source]?.name ?? '?';
}

/** The sprite href for what did it ('' when the kit has no glyph: the feed says it in words). */
export function damageSourceIcon(source: number): string {
  if (source === DamageSource.Grenade) return iconHref('g-frag');
  if (source === DamageSource.Mine) return iconHref('g-mine');
  if (source === DamageSource.Gas) return iconHref('g-gas');
  if (source === DamageSource.Melee) return iconHref('melee');
  if (source === DamageSource.World) return '';
  const icon = weaponIcon(weapons[source]?.id);
  return icon ? iconHref(icon) : '';
}

/**
 * Kill-feed lines from one batch of sim events: deaths, with a headshot from a head hit on the same
 * victim earlier in the batch and a ricochet from a bullet that bounced off a shield into them.
 * `nextKey` numbers them for the DOM; `bots` marks bot players.
 */
export function feedFromEvents(events: readonly SimEvent[], localId: number, names: ReadonlyMap<number, string>, nextKey: () => number, bots: ReadonlySet<number> = new Set()): FeedEntry[] {
  const headHit = new Set<number>();
  const ricochet = new Set<number>();
  const out: FeedEntry[] = [];
  const name = (id: number) => (id < 0 ? 'world' : (names.get(id) ?? `Player ${id + 1}`));
  for (const e of events) {
    if (e.type === 'hit') {
      if (e.zone === HitZone.Head) headHit.add(e.target);
      else headHit.delete(e.target);
    } else if (e.type === 'ricochet') {
      if (e.hit === 2) ricochet.add(e.target);
    } else if (e.type === 'death') {
      const suicide = e.killer === e.victim || e.killer < 0;
      const fell = e.source === DamageSource.World;
      const headshot = headHit.has(e.victim) && !suicide;
      const blast = e.source === DamageSource.Grenade || e.source === DamageSource.Mine;
      const badge: FeedBadge = fell ? 'fall' : suicide ? 'suicide' : headshot ? 'headshot' : ricochet.has(e.victim) ? 'ricochet' : blast ? 'blast' : null;
      out.push({
        key: nextKey(),
        killer: suicide ? name(e.victim) : name(e.killer),
        victim: name(e.victim),
        how: damageSourceName(e.source),
        icon: damageSourceIcon(e.source),
        badge,
        headshot,
        suicide,
        fell,
        killerBot: !suicide && bots.has(e.killer),
        victimBot: bots.has(e.victim),
        mine: e.killer === localId && !suicide ? 'killer' : e.victim === localId ? 'victim' : null,
      });
      ricochet.delete(e.victim);
    }
  }
  return out;
}

/**
 * Screen angle (radians, 0 = right, clockwise: screen y points down) from `me` to a world point.
 * Damage arcs and pointers point this way.
 */
export function screenAngle(me: { x: number; y: number }, at: { x: number; y: number }): number {
  return Math.atan2(-(at.y - me.y), at.x - me.x);
}

export interface HealthView {
  /** 0..1 */
  fill: number;
  hp: number;
  /** seconds until regeneration starts (0 when it runs or isn't needed) */
  regenIn: number;
  regenerating: boolean;
  low: boolean;
}

/**
 * Health with the regen delay (docs/03: `healthRegenDelay` after the last hit, then
 * `healthRegen` HP/s). `sinceHitS` = seconds since this player last took damage.
 */
export function healthView(hp: number, t: Pick<Tuning, 'healthMax' | 'healthRegenDelay'>, sinceHitS: number): HealthView {
  const fill = Math.max(0, Math.min(1, hp / t.healthMax));
  const hurt = hp > 0 && hp < t.healthMax;
  const regenIn = hurt ? Math.max(0, t.healthRegenDelay - sinceHitS) : 0;
  return { fill, hp: Math.max(0, Math.ceil(hp)), regenIn, regenerating: hurt && regenIn === 0, low: fill <= 0.35 };
}

export interface FuelView {
  /** 0..1 */
  fill: number;
  /** 0..1 of the bar: the regen delay still to run, drawn right after the fill */
  delay: number;
  /** 0..1 position of the minimum fuel to ignite */
  ignite: number;
  /** below the ignite threshold: the jetpack won't start */
  empty: boolean;
  /** 0..1: how much of the regen delay is still to run (the kit's thin strip under the fuel bar) */
  delayLeft: number;
}

/**
 * Fuel with its regen-delay segment: while `fuelRegenDelay` ticks run (local mode and the
 * predicted player online), a segment after the fill shows how much delay is left.
 */
export function fuelView(p: Pick<PlayerView, 'fuel' | 'fuelRegenDelay' | 'grounded'>, t: Pick<Tuning, 'fuelMax' | 'fuelMinIgnite' | 'fuelRegenDelayGround' | 'fuelRegenDelayAir'>): FuelView {
  const fill = Math.max(0, Math.min(1, p.fuel / t.fuelMax));
  const full = (p.grounded ? t.fuelRegenDelayGround : t.fuelRegenDelayAir) * 60;
  const delay = p.fuelRegenDelay > 0 && full > 0 && fill < 1 ? Math.min(1 - fill, 0.25 * Math.min(1, p.fuelRegenDelay / full)) : 0;
  const delayLeft = p.fuelRegenDelay > 0 && full > 0 && fill < 1 ? Math.min(1, p.fuelRegenDelay / full) : 0;
  return { fill, delay, ignite: Math.min(1, t.fuelMinIgnite / t.fuelMax), empty: p.fuel < t.fuelMinIgnite, delayLeft };
}

export interface WeaponCard {
  /** which of the two slots (0, 1) */
  slot: number;
  def: number;
  name: string;
  melee: boolean;
  mag: number;
  reserve: number;
  /** reload progress 0..1, or -1 when not reloading */
  reload: number;
  /** held (or both, dual-wielding) */
  active: boolean;
  /** a heavy weapon's speed multiplier (1 = none) */
  speed: number;
  lowAmmo: boolean;
}

export function weaponCards(p: Pick<PlayerView, 'weapons' | 'active' | 'dual'>): WeaponCard[] {
  return p.weapons.flatMap((w: WeaponView, i): WeaponCard[] => {
    if (w.def === NO_WEAPON) return [];
    const def = weapons[w.def];
    if (!def) return [];
    const melee = def.fireMode === 'melee';
    const total = def.reload * 60;
    return [
      {
        slot: i,
        def: w.def,
        name: def.name,
        melee,
        mag: w.mag,
        reserve: w.reserve,
        reload: w.reloadTicks > 0 && total > 0 ? Math.max(0, Math.min(1, 1 - w.reloadTicks / total)) : -1,
        active: p.dual || i === p.active,
        speed: def.moveSpeedMul,
        lowAmmo: !melee && w.mag <= Math.max(1, Math.floor(def.mag * 0.2)),
      },
    ];
  });
}

/**
 * The scoreboard's leader bar (docs/design/pen-diff.md N4): who leads, towards the kill limit, and
 * where you stand ("Kemi leads 8/10 · you're 2 kills behind"). Rows in rank order; '' when empty.
 */
export function leaderLine(rows: readonly ScoreRow[], killLimit: number, name: (r: ScoreRow) => string = (r) => r.name): string {
  const top = rows[0];
  if (!top) return '';
  const of = killLimit > 0 ? `/${killLimit}` : '';
  const kills = (n: number) => `${n} ${n === 1 ? 'kill' : 'kills'}`;
  const me = rows.find((r) => r.you);
  const second = rows[1];
  if (second && second.score === top.score) {
    const behind = me && me.score < top.score ? ` · you're ${kills(top.score - me.score)} behind` : '';
    return `Tied at ${top.score}${of}${behind}`;
  }
  if (top.you) return `You lead ${top.score}${of}${second ? ` · ${kills(top.score - second.score)} ahead of ${name(second)}` : ''}`;
  return `${name(top)} leads ${top.score}${of}${me ? ` · you're ${kills(top.score - me.score)} behind` : ''}`;
}

export interface ScoreRow {
  key: number;
  /** the player's id in the room: voice chat lights the row while they talk (voice/), the avatar wears their look (presentation/) */
  id?: number;
  /** team modes (v21): the player's team, −1 / absent = none */
  team?: number;
  name: string;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  /** ms, -1 = unknown (local mode, or not reported yet) */
  ping: number;
  you: boolean;
  host: boolean;
  bot: boolean;
  left: boolean;
}

// ---- riot shield, dash, conditions, grenade belt, pickups (docs/02 §21, docs/03 §9, §12, §14) ----

export type ShieldState = 'none' | 'slung' | 'raising' | 'up';

export interface ShieldStatus {
  state: ShieldState;
  hp: number;
  /** 0..1 of a fresh shield */
  fill: number;
}

/** The riot shield as the HUD names it: up (guarding the front), slung (the back), raising, none. */
export function shieldStatus(p: Pick<PlayerView, 'shield' | 'shieldHp'>): ShieldStatus {
  const hp = Math.max(0, Math.ceil(p.shieldHp ?? 0));
  if (!p.shield || hp <= 0) return { state: 'none', hp: 0, fill: 0 };
  const state: ShieldState = p.shield === 'front' ? 'up' : p.shield === 'back' ? 'slung' : 'raising';
  return { state, hp, fill: Math.min(1, hp / RIOT_SHIELD.hp) };
}

export interface DashStatus {
  /** ready (the fuel buys a dash); spent (not enough fuel for one: the ring refills toward it) */
  state: 'ready' | 'spent';
  /** 0..1 of a dash's fuel still to come back (0 when ready) */
  fill: number;
  /** full dashes the fuel buys now (-1: dashes are free) */
  left: number;
}

/**
 * The dash as the HUD shows it (docs/02 §21, the owner, 19 Oct: "as far as you have fuel you can
 * dash as many times as you want but it eats from your fuel"): no cooldown, just the fuel.
 */
export function dashStatus(p: Pick<PlayerView, 'fuel'>, t: Pick<Tuning, 'dashFuelCost'>): DashStatus {
  const cost = t.dashFuelCost;
  if (!(cost > 0)) return { state: 'ready', fill: 0, left: -1 };
  const fuel = Math.max(0, p.fuel);
  const left = Math.floor(fuel / cost + 1e-9);
  if (left > 0) return { state: 'ready', fill: 0, left };
  return { state: 'spent', fill: Math.min(1, 1 - fuel / cost), left: 0 };
}

export interface Conditions {
  /** the jetpack is dead: an EMP zone or storm (map), or the EMP grenade's lockout */
  emp: boolean;
  /** seconds of the EMP grenade's lockout left; 0 = the map's EMP (as long as you stay in it) */
  empSeconds: number;
  /** flashbang blindness 0..1 */
  blind: number;
  inGas: boolean;
}

export function conditions(p: HudPlayer): Conditions {
  const lockout = Math.max(0, p.jetDisabledTicks ?? 0);
  return {
    emp: !!p.jetDisabled || lockout > 0,
    empSeconds: lockout / 60,
    blind: Math.max(0, Math.min(1, p.blind ?? 0)),
    inGas: (p.gasTicks ?? 0) > 0,
  };
}

/** The grenade belt's types, in the sim's type order (content `grenades`): frag, smoke, gas, flashbang, mine, EMP. */
export const BELT: readonly { id: string; name: string; max: number }[] = grenades.map((g) => ({ id: g.id, name: g.name, max: g.maxCount }));

export interface BeltSlot {
  id: string;
  name: string;
  count: number;
  max: number;
  selected: boolean;
  /** this build has the type (arsenal-b's belt), so the slot shows */
  present: boolean;
}

export function grenadeBelt(p: HudPlayer): BeltSlot[] {
  const counts = p.grenadeCounts;
  const selected = p.grenadeType ?? 0;
  return BELT.map((b, i) => {
    const present = counts ? i < counts.length : i === 0;
    const count = counts ? (counts[i] ?? 0) : i === 0 ? p.frags : 0;
    return { ...b, count, selected: present && i === selected, present };
  });
}

/** Within this far (m) of an item you're told how to take it. */
export const PICKUP_PROMPT_RANGE = 3;

/** The nearest item within reach of the prompt, null when none. */
export function pickupNear(me: Pick<PlayerView, 'x' | 'y' | 'alive'>, items: readonly PickupView[] | undefined): PickupDef | null {
  if (!me.alive || !items?.length) return null;
  let best: PickupView | null = null;
  let bestD = PICKUP_PROMPT_RANGE;
  for (const k of items) {
    const d = Math.hypot(k.x - me.x, (k.y - me.y) * 0.75);
    if (d <= bestD) {
      best = k;
      bestD = d;
    }
  }
  return (best && pickupDefs[best.def]) ?? null;
}

// ---- the take control: what the prompts name (owner, 25 Oct: "it says hold square … if it's square, let it be square") ----

/**
 * The word on the phone's Take button (touch/skin.ts draws it under the button: cap('Take'); the
 * editor calls the control "Take a gun", touch/layout.ts). Every touch prompt names the button by
 * this word, and a test fails if the button's word and this one ever part.
 */
export const TAKE_WORD = 'Take';

/** The device the player takes guns with: the phone's Take button, a key, or a controller's button. */
export type TakeDevice = 'touch' | 'keys' | 'pad';

/** The one control every take prompt names (the crate card's key, the phone's chip, the lines). */
export interface TakeControl {
  device: TakeDevice;
  /** what the player presses, as they see it: 'Take' (the on-screen button), 'E' (the key), '□' or 'X' (the pad's button) */
  name: string;
  /** held, not tapped (a controller's "hold reload to take") */
  hold: boolean;
  /** the binding's code for drawButtonCap ('KeyE', 'PadHold2'); '' on touch */
  code: string;
  /** the instruction in two words: 'Tap Take', 'Press E', 'Hold □' */
  say: string;
}

/**
 * The take control for the device in play. `cap`: the binding's cap as the HUD writes it
 * (ui/icons.ts capText: 'E', or a pad's 'Hold □' / '△'); `code`: the binding's code ('KeyE',
 * 'PadHold2', 'Pad3'). Touch ignores both: the button on screen says TAKE_WORD.
 */
export function takeControl(device: TakeDevice, cap = 'E', code = ''): TakeControl {
  if (device === 'touch') return { device, name: TAKE_WORD, hold: false, code: '', say: `Tap ${TAKE_WORD}` };
  const held = /^Hold\s+/i.exec(cap);
  const hold = device === 'pad' && (/^PadHold\d/.test(code) || !!held);
  const name = (held ? cap.slice(held[0].length) : cap).trim() || 'E';
  return { device, name, hold, code, say: `${hold ? 'Hold' : 'Press'} ${name}` };
}

const asTake = (take: TakeControl | string | null): TakeControl => (take === null ? takeControl('touch') : typeof take === 'string' ? takeControl('keys', take, '') : take);

/**
 * One short line for what lies close by, the nearest first; '' when none. A gun underfoot you don't
 * hold: `Press E · Widow` (the take control, then the gun); a gun a step away: `Widow · stand on it`,
 * or `Widow · walk over for ammo` when you hold one; grenades and the shield: `Riot Shield · walk over`.
 * `take`: the take control (takeControl); a string is a key's cap, null the phone's Take button.
 */
export function pickupPrompt(me: Pick<PlayerView, 'x' | 'y' | 'alive'> & Partial<Pick<PlayerView, 'weapons' | 'active'>>, items: readonly PickupView[] | undefined, take: TakeControl | string | null = 'E'): string {
  if (!me.alive || !items?.length) return '';
  const weaponsHeld = me.weapons ?? [];
  const under = weaponUnderfoot(items, { x: me.x, y: me.y, weapons: weaponsHeld });
  if (under && !under.held) return `${asTake(take).say} · ${under.weapon.name}`;
  const def = pickupNear(me, items);
  if (def?.kind === 'weapon') {
    const held = def.weapon !== undefined && weaponsHeld.some((w) => w.def === def.weapon);
    return `${def.name} · ${held ? 'walk over for ammo' : 'stand on it'}`;
  }
  return def ? `${def.name} · walk over` : '';
}

/** An item's glyph: the shield, or the grenade type of a pair. */
export function pickupIcon(def: PickupDef): string {
  if (def.kind === 'grenades' && def.grenade !== undefined) return iconHref(`g-${grenades[def.grenade]?.id ?? 'frag'}`);
  if (def.kind === 'weapon' && def.weapon !== undefined) return iconHref(weaponIcon(weapons[def.weapon]?.id) ?? 'armory');
  return iconHref('shield');
}

/** A map event's look in the kit: its colour token and icon, by MapEventKind. */
export function eventLook(kind: string): { color: string; icon: string } {
  switch (kind) {
    case 'emp':
      return { color: 'var(--c-ev-emp)', icon: 'ev-emp' };
    case 'gust':
      return { color: 'var(--c-ev-squall)', icon: 'ev-squall' };
    case 'fog':
      return { color: 'var(--c-ev-fog)', icon: 'ev-fog' };
    case 'gravitySurge':
    case 'lowGravity':
    case 'flip':
      return { color: 'var(--c-ev-gravity)', icon: 'ev-gravity' };
    default:
      return { color: 'var(--c-ev-gravity)', icon: 'warn' };
  }
}

// ---- round two's desktop HUD (docs/design/military-forge-ui-v2.html, data-screen="hud") ----

/** The held slot's family line, by the gun's class. */
const FAMILY: Readonly<Record<string, string>> = { sidearm: 'Pistol', smg: 'SMG', rifle: 'Rifle', dmr: 'Marksman', sniper: 'Sniper', shotgun: 'Shotgun', heavy: 'Heavy', special: 'Special', melee: 'Blade' };

export function weaponFamily(def: Pick<WeaponDef, 'class'> | undefined): string {
  return def ? (FAMILY[def.class] ?? def.class) : '';
}

/** A blast (a grenade, a mine, a launcher's explosive round): it launches who it hits. */
export function isBlastSource(source: number): boolean {
  return source === DamageSource.Grenade || source === DamageSource.Mine || !!weapons[source]?.projectile?.explosion;
}

/** The flamethrower's burn ticking (not a new hit): the "On fire" cue says it, no damage arc. */
export function isBurnTick(source: number, damage: number): boolean {
  const burn = DRAGON.projectile?.burn;
  return source === DRAGON.index && !!burn && damage <= burn.dps * burn.pulse + 1e-6;
}

/** What one damage arc looks like: the kit's arc kinds and --amt (0..1, the hit's weight). */
export type ArcKind = 'bullet' | 'heavy' | 'blast';

export function damageArc(source: number, damage: number): { kind: ArcKind; amount: number } {
  const amount = Math.max(0.2, Math.min(1, damage / 60));
  if (isBlastSource(source)) return { kind: 'blast', amount };
  return { kind: damage >= 45 ? 'heavy' : 'bullet', amount };
}

/** The 8 dash directions (the sim's 'dash' event: 0 = right, counter-clockwise), as words. */
const DASH_WORDS = ['Right', 'Up-right', 'Up', 'Up-left', 'Left', 'Down-left', 'Down', 'Down-right'] as const;

/** The dash ring's direction tick and hint: the rose's 0 is up, clockwise; the arrow icon points right. */
export function dashHint(dir: number): { words: string; rose: number; arrow: number } {
  const k = ((Math.round(dir) % 8) + 8) % 8;
  return { words: DASH_WORDS[k]!, rose: 90 - 45 * k, arrow: -45 * k };
}

/**
 * The "Tuned by host" tag: what the room's host changed, the first two by name (2 → "Gravity 0.6× ·
 * Dash speed 1.4×"), against `base`: the defaults, or online the defaults with the admin's values
 * (those show as "Tuned by admin", not as the host's).
 */
export function tunedSummary(t: Tuning, base: Tuning = defaultTuning): string {
  const parts: string[] = [];
  for (const group of TUNING_GROUPS) {
    for (const f of group.fields) {
      const now = t[f.key];
      const was = base[f.key];
      if (now === was) continue;
      const label = f.label.replace(/\s*\(.*\)\s*$/, '');
      const first = label.split(' ')[0]!.toLowerCase();
      const name = group.title.toLowerCase().includes(first) ? label : `${group.title} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
      const ratio = was > 0 && now > 0 ? `${Math.round((now / was) * 100) / 100}×` : String(Math.round(now * 100) / 100);
      parts.push(`${name} ${ratio}`);
    }
  }
  if (parts.length <= 2) return parts.join(' · ');
  return `${parts.slice(0, 2).join(' · ')} · ${parts.length - 2} more`;
}

export interface CompareRow {
  key: 'damage' | 'rate' | 'range' | 'weight' | 'mag';
  held: string;
  floor: string;
  /** bars, 0..1 of the arsenal's most */
  a: number;
  b: number;
  /** better (up), worse (down) or the same, for the player: lighter is better */
  dir: 'up' | 'down' | 'same';
  delta: string;
}

const guns = weapons.filter((w) => w.fireMode !== 'melee');
const perShot = (w: WeaponDef) => w.damage * w.pellets;
const perMinute = (w: WeaponDef) => Math.round(60 / Math.max(1e-6, w.interval));
const MOST = {
  damage: Math.max(...guns.map(perShot)),
  rate: Math.max(...guns.map(perMinute)),
  range: Math.max(...guns.map((w) => w.range)),
  mag: Math.max(...guns.map((w) => w.mag)),
};

/** A gun's weight in words, by how much it slows you (moveSpeedMul). */
export function weightWords(mul: number): string {
  return mul >= 0.98 ? 'Light' : mul >= 0.9 ? 'Medium' : 'Heavy';
}

const signed = (n: number, unit = '') => (n > 0 ? `+${n}${unit}` : n < 0 ? `−${-n}${unit}` : 'same');

/** The crate's quick compare (the kit's .cmp): the gun in hand against the one on the floor. */
export function crateCompare(held: WeaponDef, floor: WeaponDef): CompareRow[] {
  const row = (key: CompareRow['key'], a: number, b: number, most: number, show: (n: number) => string, unit = ''): CompareRow => ({
    key,
    held: show(a),
    floor: show(b),
    a: Math.min(1, a / most),
    b: Math.min(1, b / most),
    dir: b > a ? 'up' : b < a ? 'down' : 'same',
    delta: signed(Math.round(b - a), unit),
  });
  const heavy = (w: WeaponDef) => Math.max(0, Math.min(1, (1.02 - w.moveSpeedMul) / 0.4));
  const weightDir: CompareRow['dir'] = floor.moveSpeedMul > held.moveSpeedMul ? 'up' : floor.moveSpeedMul < held.moveSpeedMul ? 'down' : 'same';
  return [
    row('damage', perShot(held), perShot(floor), MOST.damage, String),
    row('rate', perMinute(held), perMinute(floor), MOST.rate, String),
    row('range', held.range, floor.range, MOST.range, (n) => `${n} m`, ' m'),
    { key: 'weight', held: weightWords(held.moveSpeedMul), floor: weightWords(floor.moveSpeedMul), a: Math.max(0.08, heavy(held)), b: Math.max(0.08, heavy(floor)), dir: weightDir, delta: weightDir === 'up' ? 'faster' : weightDir === 'down' ? 'slower' : 'same' },
    row('mag', held.mag, floor.mag, MOST.mag, String),
  ];
}

// ---- the premium in-match moments (owner, 23 Oct: the swap, guns on the ground, map events) ----

/** A gun's fire mode in a word, for the compare card's art strip. */
const FIRE_WORDS: Readonly<Record<string, string>> = { semi: 'Semi-auto', auto: 'Full auto', burst: 'Burst', spinup: 'Spin-up', beam: 'Beam', charge: 'Charge', melee: 'Melee' };

export function fireWords(def: Pick<WeaponDef, 'fireMode'> | undefined): string {
  return def ? (FIRE_WORDS[def.fireMode] ?? def.fireMode) : '';
}

/** The item card's look: a gun (volt), grenades (brass), the riot shield (steel). */
export type ItemTone = 'gun' | 'grenades' | 'shield';

export interface ItemCard {
  title: string;
  line: string;
  icon: string;
  tone: ItemTone;
}

/**
 * The one-line card for an item close by that isn't a gun underfoot (that one gets the compare
 * card), icon first, a few words after (owner, 25 Oct: "make them minimal"): a grenade pair and what
 * it does to your count (`3 → 5`, or `Full`), the riot shield's HP, a gun a step away (`Stand on it`,
 * or `Ammo` when you hold one). Grenades and the shield are taken by walking over them, so no
 * control is named; a gun's line names none either: standing on it, the compare card names the take
 * control.
 */
export function itemCard(def: PickupDef, me: Partial<Pick<PlayerView, 'weapons'>> & Partial<Pick<ArsenalFields, 'grenadeCounts'>>): ItemCard {
  const icon = pickupIcon(def);
  if (def.kind === 'grenades' && def.grenade !== undefined) {
    const g = grenades[def.grenade];
    const max = g?.maxCount ?? 0;
    const have = me.grenadeCounts?.[def.grenade] ?? 0;
    const after = Math.min(Math.max(max, have), have + GRENADE_PICKUP_COUNT);
    return { title: g?.name ?? def.name, line: have >= max ? 'Full' : `${have} → ${after}`, icon, tone: 'grenades' };
  }
  if (def.kind === 'weapon' && def.weapon !== undefined) {
    const w = weapons[def.weapon];
    const held = (me.weapons ?? []).some((s) => s.def === def.weapon);
    return { title: w?.name ?? def.name, line: held ? 'Ammo' : 'Stand on it', icon, tone: 'gun' };
  }
  return { title: def.name, line: `${RIOT_SHIELD.hp} HP`, icon, tone: 'shield' };
}

/** How far (m) a world tag stays full size; it is smallest and faintest from TAG_FAR on, gone past TAG_GONE. */
export const TAG_NEAR = 6;
export const TAG_FAR = 30;
export const TAG_GONE = 48;

/**
 * A world tag's size and strength by its distance from you (m): full up to TAG_NEAR, then down to
 * 0.72 scale and 0.45 opacity at TAG_FAR; hidden (null) past TAG_GONE. Stepped (scale by 0.02,
 * opacity by 0.05), so a tag is rewritten only when the step changes, not every frame you move.
 */
export function tagFade(distance: number): { scale: number; opacity: number } | null {
  if (!(distance <= TAG_GONE)) return null;
  const k = Math.max(0, Math.min(1, (distance - TAG_NEAR) / (TAG_FAR - TAG_NEAR)));
  const step = (v: number, s: number) => Math.round(v / s) * s;
  return { scale: +step(1 - 0.28 * k, 0.02).toFixed(2), opacity: +step(1 - 0.55 * k, 0.05).toFixed(2) };
}

/** A tag's distance in words: whole metres up close, 5 m steps beyond 10 m. */
export function tagDistance(distance: number): string {
  const d = Math.max(0, distance);
  return `${d < 10 ? Math.round(d) : Math.round(d / 5) * 5} m`;
}

/** A map event's stage on screen: the warning, the impact as it starts, running, and the all-clear after. */
export type EventStage = 'warning' | 'impact' | 'active' | 'end';

export interface EventMoment {
  stage: EventStage;
  kind: string;
  name: string;
  description: string;
  /** whole seconds left in its phase (warning: to the start; active: to the end); 0 at the end */
  seconds: number;
  /** warning: 0 → 1 toward the start; active: 1 → 0 as it runs out; end: 0 */
  progress: number;
}

/** The impact stamp's time on screen as an event starts, and the all-clear's after it ends (ms). */
export const EVENT_IMPACT_MS = 900;
export const EVENT_END_MS = 1800;

/**
 * The map event's sequence (warning → impact → active → end) from the frame's event and the clock.
 * The frame only knows warning and active; this remembers when the active phase began (the impact
 * plays for EVENT_IMPACT_MS, unless we joined mid-event) and what just ended (the all-clear plays
 * for EVENT_END_MS). A new event takes over at once, whatever is showing.
 */
export class EventTimeline {
  private current: { key: string; kind: string; name: string; description: string; warned: boolean; activeAt: number } | null = null;
  private ended: { kind: string; name: string; description: string; until: number } | null = null;

  update(view: Pick<MapEventView, 'id' | 'kind' | 'name' | 'description' | 'phase' | 'secondsLeft' | 'progress' | 'occurrence'> | null | undefined, now: number): EventMoment | null {
    if (view) {
      const key = `${view.id}:${view.occurrence}`;
      if (this.current?.key !== key) {
        this.current = { key, kind: view.kind, name: view.name, description: view.description, warned: false, activeAt: -Infinity };
        this.ended = null;
      }
      const c = this.current;
      const seconds = Math.max(1, Math.ceil(view.secondsLeft - 1e-9));
      const base = { kind: c.kind, name: c.name, description: c.description, seconds };
      if (view.phase === 'warning') {
        c.warned = true;
        return { ...base, stage: 'warning', progress: clamp01(view.progress) };
      }
      // the start: an impact, unless we came in after it (a late join, a reconnect)
      if (c.activeAt === -Infinity) c.activeAt = c.warned || view.progress < 0.05 ? now : now - EVENT_IMPACT_MS;
      return { ...base, stage: now - c.activeAt < EVENT_IMPACT_MS ? 'impact' : 'active', progress: clamp01(1 - view.progress) };
    }
    const c = this.current;
    if (c) {
      this.current = null;
      if (c.activeAt !== -Infinity) this.ended = { kind: c.kind, name: c.name, description: c.description, until: now + EVENT_END_MS };
    }
    if (this.ended && now < this.ended.until) return { stage: 'end', kind: this.ended.kind, name: this.ended.name, description: this.ended.description, seconds: 0, progress: 0 };
    this.ended = null;
    return null;
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The frame's event as a moment without the timeline's memory: warning or active (no impact, no all-clear). */
export function eventMomentOf(view: Pick<MapEventView, 'kind' | 'name' | 'description' | 'phase' | 'secondsLeft' | 'progress'> | null | undefined): EventMoment | null {
  if (!view) return null;
  const warning = view.phase === 'warning';
  return {
    stage: warning ? 'warning' : 'active',
    kind: view.kind,
    name: view.name,
    description: view.description,
    seconds: Math.max(1, Math.ceil(view.secondsLeft - 1e-9)),
    progress: clamp01(warning ? view.progress : 1 - view.progress),
  };
}

/** The event's effect in a few words for the active strip: what follows the colon ("…: jets climb slowly" → "Jets climb slowly"). */
export function eventEffect(description: string): string {
  const i = description.indexOf(':');
  const s = (i >= 0 ? description.slice(i + 1) : description).trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** What the all-clear says is back, by kind. */
const EVENT_END_LINES: Readonly<Record<string, string>> = {
  gravitySurge: 'Gravity back to normal',
  lowGravity: 'Gravity back to normal',
  flip: 'Gravity back to normal',
  emp: 'Jetpacks back online',
  fog: 'Full range again',
  gust: 'The wind drops',
};

export function eventEndLine(kind: string): string {
  return EVENT_END_LINES[kind] ?? 'Back to normal';
}

/** The small arrow on the event's icon: which way gravity goes (surge down, low gravity up, flip both). */
export function eventArrow(kind: string): string {
  return kind === 'gravitySurge' ? 'chev-down' : kind === 'lowGravity' ? 'chev-up' : kind === 'flip' ? 'rotate' : '';
}

/** The screen treatment's kind (hud.css .mf-evfx[data-kind]): the event kinds, anything else 'custom'. */
export function eventFx(kind: string): string {
  return kind in EVENT_END_LINES ? kind : 'custom';
}

/** Kill streaks in the war tone's words: 2 → "2 down", up to "Unstoppable" past 7; '' for one. */
export function streakWords(streak: number): string {
  if (streak < 2) return '';
  if (streak >= 8) return 'Unstoppable';
  return `${streak} down`;
}
