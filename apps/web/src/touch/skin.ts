/**
 * The touch controls wear the owner's round-two kit (docs/design/military-forge-ui-v2.html, "M1 Phone
 * HUD · thumb dials"): the move stick is the HP/fuel dial, the aim stick the ammo dial (one segment
 * per round, the throw ring), the buttons are the kit's dial buttons, the swap pill shows both guns
 * and the take button the gun on the crate underfoot. Markup and class names are the kit's (ui/kit.css);
 * touch.css only hosts them over the game.
 *
 * Values arrive the HUD's way (hud/bind.ts, hud/state.ts): the HUD's own values and state tokens for
 * the frame (feedTouchHud, the one call hud.ts makes) plus what only the controls know or read straight
 * from the frame (the grenade in hand, the crate underfoot, the equip clock, the throw being aimed).
 */
import { NO_WEAPON, grenades, weapons } from '@military-forge/content';
import { Binder } from '../hud/bind';
import { StateTokens } from '../hud/state';
import { HUD_VARS } from '../hud/template';
import { iconHref, weaponIcon } from '../ui/icons';
import type { Frame, PlayerView } from '../view';
import { weaponUnderfoot } from '../weaponItems';
import type { ControlId } from './layout';

const ic = (name: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const ring = (r: number, cls = 'tb__ring') => `<svg class="${cls}" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="${r}" pathLength="100"/></svg>`;
const arc = (cls: string, state = '') => `<circle class="${cls}" cx="84" cy="84" r="80" stroke-width="8" pathLength="100"${state ? ` data-state="${state}"` : ''}/>`;

/**
 * The kit's design size of each control's skin (px): a dial's base (its box is 168 with the arcs), a
 * button's diameter, a pill's height. The controller zooms the skin by the control's size over this.
 */
export const SKIN_BASE: Readonly<Record<ControlId, number>> = {
  move: 136,
  aim: 136,
  shield: 52,
  reload: 52,
  dash: 52,
  grenade: 58,
  melee: 52,
  cycleGrenade: 48,
  zoom: 48,
  scores: 48,
  pause: 48,
  swap: 52,
  take: 52,
};

/** The dials' box (px, design) around their 136 px base: the HP/fuel and ammo arcs ride outside it. */
export const DIAL_BOX = 168;

/** Each control's markup: the kit's, with the bound values (data-bind…) and states (data-state). */
export function skinHtml(id: ControlId): string {
  switch (id) {
    case 'move':
      return `<div class="mf-skin dial dial--move">
  <svg class="dial__arcs" viewBox="0 0 168 168" aria-hidden="true">${arc('dial__track dial__track--hp')}${arc('dial__hp')}${arc('dial__track dial__track--fuel')}${arc('dial__fuel')}</svg>
  <span class="dial__base"></span><span class="dial__groove"></span>
  <span class="dial__hint dial__hint--up">${ic('jet', 'ic--sm')}</span><span class="dial__hint dial__hint--down">${ic('chev-down', 'ic--sm')}</span>
  <span class="dial__knob mf-knob"></span>
  <span class="dial__lbl dial__lbl--hp" data-state="alive">${ic('hp', 'ic--sm')}<b class="num" data-bind="player.hp"></b></span>
  <span class="dial__lbl dial__lbl--fuel" data-state="alive"><b class="num" data-bind="player.fuel"></b>${ic('fuel', 'ic--sm')}</span>
</div>`;
    case 'aim':
      return `<div class="mf-skin dial dial--aim">
  <svg class="dial__arcs" viewBox="0 0 168 168" aria-hidden="true"><g class="mf-rounds" data-state="gun"></g>${arc('dial__throw', 'grenade-aim')}</svg>
  <span class="dial__base"></span><span class="dial__groove"></span>
  <span class="dial__knob dial__knob--aim mf-knob">${ic('target', 'ic--sm')}</span>
  <span class="dial__lbl dial__lbl--ammo" data-state="gun"><b class="num" data-bind="player.slot.0.mag"></b><span>/<span data-bind="player.slot.0.magSize"></span></span></span>
  <span class="dial__mode" data-state="grenade-aim">Aim the arc</span>
</div>`;
    case 'shield':
      return `<div class="mf-skin dial-btn dial-btn--shield">${ic('shield')}</div>`;
    case 'reload':
      return `<div class="mf-skin dial-btn dial-btn--reload">${ic('reload')}<b class="num tb__sub" data-state="gun" data-bind="player.slot.0.mag"></b><span data-state="reloading">${ring(27)}</span></div>`;
    case 'dash':
      return `<div class="mf-skin dial-btn dial-btn--dash">${ic('dash')}${ring(27)}</div>`;
    case 'grenade':
      return `<div class="mf-skin dial-btn dial-btn--grenade"><svg class="ic ic--fill ic--sm" aria-hidden="true"><use data-bind-attr="href: touch.grenade.icon"/></svg><b class="num tb__sub" data-bind="touch.grenade.count"></b><span class="mf-quick" aria-hidden="true">Quick</span></div>`;
    case 'melee':
      return `<div class="mf-skin dial-btn dial-btn--melee">${ic('melee')}</div>`;
    case 'cycleGrenade':
      return `<div class="mf-skin dial-btn dial-btn--sm">${ic('refresh', 'ic--sm')}</div>`;
    case 'zoom':
      return `<div class="mf-skin dial-btn dial-btn--sm">${ic('zoom', 'ic--sm')}<b class="num tb__sub" data-bind="touch.zoom" data-bind-show="touch.zoom"></b></div>`;
    case 'scores':
      return `<div class="mf-skin dial-btn dial-btn--sm">${ic('trophy', 'ic--sm')}</div>`;
    case 'pause':
      return `<div class="mf-skin tb pt-pause">${ic('pause')}</div>`;
    case 'swap':
      return `<div class="mf-skin pt-swap">
  <span class="pt-swap__held"><svg class="ic--kf mf-gun" aria-hidden="true" data-state="held-icon"><use data-bind-attr="href: player.slot.0.icon"/></svg><b data-bind="player.slot.0.name"></b></span>
  <span class="pt-swap__back" data-state="slung">${ic('backpack', 'ic--sm')}<svg class="ic--kf mf-gun" aria-hidden="true" data-state="slung-icon"><use data-bind-attr="href: player.slot.1.icon"/></svg></span>
  <span class="pt-swap__eq" data-state="swap">${ring(25, '')}</span>
</div>`;
    case 'take':
      return `<div class="mf-skin pt-pick">${ic('swap', 'ic--sm')}<span data-bind="touch.take.verb"></span><svg class="ic--kf" aria-hidden="true"><use data-bind-attr="href: touch.take.icon"/></svg><b data-bind="touch.take.name"></b></div>`;
  }
}

// ---------------------------------------------------------------- the aim dial's rounds

/** Up to this many rounds the ring shows one segment each; a bigger mag is one arc that empties. */
export const MAX_SEGMENTS = 40;

export interface RoundSegment {
  /** stroke-dasharray on pathLength 100 */
  dash: string;
  /** stroke-dashoffset */
  offset: string;
}

/**
 * The aim ring's segments: one per round in a full mag (the kit's 6 × "13 87" with a ~3.7 gap), or
 * one continuous arc past MAX_SEGMENTS. Pure, for tests.
 */
export function roundSegments(magSize: number): RoundSegment[] {
  const n = Math.max(0, Math.floor(magSize));
  if (n === 0) return [];
  if (n > MAX_SEGMENTS) return [{ dash: '100 0', offset: '0' }];
  // the kit's six rounds: 13 of each 16.67 drawn, starting 1.5 in (the same proportions for any mag)
  const step = 100 / n;
  const len = step * 0.78;
  const r = (v: number) => (Math.round(v * 100) / 100).toString();
  return Array.from({ length: n }, (_, i) => ({ dash: `${r(len)} ${r(100 - len)}`, offset: r(-(step * 0.09 + i * step)) }));
}

/** The continuous arc's dash for a mag past MAX_SEGMENTS: what's left of it. */
export function roundsLeftDash(mag: number, magSize: number): string {
  const f = magSize > 0 ? Math.max(0, Math.min(1, mag / magSize)) : 0;
  return `${(Math.round(f * 10000) / 100).toString()} 100`;
}

// ---------------------------------------------------------------- values

/**
 * The HUD's current names for what the kit calls player.slot.N.* (round one's model; the desktop
 * HUD's phase 2 moves to the kit's). Filled in only where the kit's own key is absent, so this is a
 * no-op once the model speaks the kit's names; delete it then.
 */
const KIT_NAMES: readonly [kit: string, now: string][] = [
  ['player.slot.0.name', 'weapon.0.name'],
  ['player.slot.0.mag', 'weapon.0.mag'],
  ['player.slot.0.magSize', 'weapon.0.magSize'],
  ['player.slot.0.icon', 'weapon.0.icon'],
  ['player.slot.1.name', 'weapon.1.name'],
  ['player.slot.1.icon', 'weapon.1.icon'],
];

export function adaptHudValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...values };
  for (const [kit, now] of KIT_NAMES) if (out[kit] === undefined && values[now] !== undefined) out[kit] = values[now]!;
  return out;
}

/** The controls' own variables: the equip ring and the throw ring (raw, every frame), from what they know first-hand. */
export const TOUCH_VARS: readonly [name: string, key: string][] = [
  ['--equip', 'touch.equip'],
  ['--throw', 'touch.throw'],
];

/**
 * The CSS variables the HUD sets on its root (hud/template.ts HUD_VARS: '--hp: v.hp; …'), as [name,
 * key], less the ones the controls set themselves (TOUCH_VARS: one writer per variable).
 */
export function hudVarPairs(spec: string = HUD_VARS): [name: string, key: string][] {
  const own = new Set(TOUCH_VARS.map(([n]) => n));
  return spec
    .split(';')
    .map((p) => p.split(':').map((s) => s.trim()) as [string, string])
    .filter(([n, k]) => n?.startsWith('--') && !!k && !own.has(n));
}

export interface LocalView {
  values: Record<string, string>;
  tokens: string[];
}

/** What the controls read straight from the frame (pure): the grenade in hand, the crate underfoot, zoom. */
export function localView(frame: Pick<Frame, 'localId' | 'pickups'> & { players: readonly PlayerView[] }): LocalView {
  const values: Record<string, string> = {};
  const tokens: string[] = [];
  const me = frame.players.find((p) => p.id === frame.localId);
  if (!me) return { values, tokens };
  // the grenade button: the selected type's icon and how many of it you carry
  const type = me.grenadeType ?? 0;
  const g = grenades[type] ?? grenades[0];
  values['touch.grenade.icon'] = iconHref(`g-${g?.id ?? 'frag'}`);
  const count = me.grenadeCounts ? (me.grenadeCounts[type] ?? 0) : me.frags;
  values['touch.grenade.count'] = String(count);
  if (count <= 0) tokens.push('no-grenades');
  // the gun in hand: zoom only for one that zooms
  const held = weapons[me.weapons[me.active]?.def ?? NO_WEAPON];
  if (me.alive && (held?.zoomMax ?? 1) > 1) tokens.push('zoomable');
  // the crate underfoot with a gun you don't hold: the take button
  const under = me.alive ? weaponUnderfoot(frame.pickups, me) : null;
  if (under && !under.held) {
    tokens.push('near-crate');
    const icon = weaponIcon(under.weapon.id);
    values['touch.take.name'] = under.weapon.name;
    values['touch.take.icon'] = icon ? iconHref(icon) : '';
    values['touch.take.verb'] = me.weapons[me.active]?.def === NO_WEAPON || !held ? 'Take' : 'Swap';
  }
  return { values, tokens };
}

/**
 * The equip clock: when the gun in hand changes, its equip time (content's `equip`, what the sim
 * waits: p.swapTicks) runs out as --equip goes 0 → 1 and the phone shows its swap state.
 */
export class EquipClock {
  private slot = -1;
  private def = -2;
  private from = -Infinity;
  private seconds = 0;
  /** the last update changed the slot in hand (a swap between the two guns, not a gun taken into the same slot) */
  swapped = false;

  /** --equip now (1 = ready) after the frame's gun in hand is `def` in `slot`. */
  update(slot: number, def: number, now: number): number {
    this.swapped = false;
    if (slot !== this.slot || def !== this.def) {
      const first = this.def === -2;
      this.swapped = !first && slot !== this.slot;
      this.slot = slot;
      this.def = def;
      this.seconds = weapons[def]?.equip ?? 0;
      this.from = first ? -Infinity : now; // the first frame isn't a swap
    }
    if (this.seconds <= 0) return 1;
    return Math.max(0, Math.min(1, (now - this.from) / (this.seconds * 1000)));
  }

  /** the gun in hand's equip time, ms */
  get ms(): number {
    return this.seconds * 1000;
  }
}

const fixed = (v: number) => (Math.round(v * 1000) / 1000).toString();

/**
 * Everything the skins bind, for one frame (pure): the HUD's values in the kit's names, what the
 * frame says (localView), the throw being aimed (the latch's strength 0–7, −1 when none: the ring
 * fills raw), the equip clock, and the zoom badge (the level once zoomed in, nothing at 1×).
 */
export function controlValues(hud: Readonly<Record<string, string>>, local: LocalView, extra: { throwAim: number; equip: number }): Record<string, string> {
  const values = adaptHudValues(hud);
  Object.assign(values, local.values);
  values['touch.throw'] = extra.throwAim >= 0 ? fixed(Math.max(0.06, extra.throwAim / 7)) : '0';
  values['touch.equip'] = fixed(extra.equip);
  values['touch.zoom'] = values['weapon.zoom'] && values['weapon.zoom'] !== '1×' ? values['weapon.zoom'] : '';
  return values;
}

/** The phone's state tokens on the touch root: the HUD's plus the controls' own (the kit's idle … low-hp). */
export function phoneTokens(hud: readonly string[], local: readonly string[], extra: { aiming: boolean; equip: number; slung: boolean; heldIcon: boolean; slungIcon: boolean }): string[] {
  const t = new Set([...hud, ...local]);
  if (extra.aiming || t.has('aiming')) t.add('grenade-aim');
  if (t.has('pickup-crate')) t.add('near-crate');
  if (extra.equip < 1 || t.has('switching')) t.add('swap');
  if (extra.slung) t.add('slung');
  if (extra.heldIcon) t.add('held-icon');
  if (extra.slungIcon) t.add('slung-icon');
  return [...t];
}

// ---------------------------------------------------------------- the view

/**
 * Binds the controls' skins (built by the controller) to the values: text, icons, the root's CSS
 * variables, the state tokens, and the aim ring's segments. Every write is cached (Binder,
 * StateTokens), so a frame costs a few string compares.
 */
export class TouchSkin {
  private readonly binder: Binder;
  private readonly states: StateTokens;
  private readonly rounds: SVGGElement | null;
  private roundsKey = '';
  private spentKey = '';

  constructor(readonly root: HTMLElement) {
    root.setAttribute('data-bind-var', [...hudVarPairs(), ...TOUCH_VARS].map(([n, k]) => `${n}: ${k}`).join('; '));
    this.binder = new Binder(root);
    // the tokens on the safe box, inside the root's .kit-v2: the kit's scoped state rules match there
    this.states = new StateTokens(root.querySelector<HTMLElement>('.mf-touch-safe') ?? root);
    this.rounds = root.querySelector<SVGGElement>('.mf-rounds');
  }

  /** The keys the skins bind (tests: each gets a value). */
  get keys(): string[] {
    return this.binder.keys;
  }

  update(values: Readonly<Record<string, string>>, tokens: readonly string[]): void {
    this.binder.update(values);
    this.states.set(tokens);
    this.drawRounds(Number(values['player.slot.0.mag']), Number(values['player.slot.0.magSize']));
  }

  get active(): string {
    return this.states.active;
  }

  /** One segment per round in a full mag; the spent ones dim (redrawn only when the mag or its size changes). */
  private drawRounds(mag: number, magSize: number): void {
    const g = this.rounds;
    if (!g) return;
    const size = Number.isFinite(magSize) ? magSize : 0;
    const left = Number.isFinite(mag) ? mag : 0;
    const key = String(size);
    if (key !== this.roundsKey) {
      this.roundsKey = key;
      this.spentKey = '';
      const ns = 'http://www.w3.org/2000/svg';
      const segs = roundSegments(size);
      g.replaceChildren(
        ...segs.map((s) => {
          const c = document.createElementNS(ns, 'circle');
          c.setAttribute('class', 'dial__round');
          for (const [k, v] of [['cx', '84'], ['cy', '84'], ['r', '80'], ['stroke-width', '7'], ['pathLength', '100']]) c.setAttribute(k!, v!);
          c.style.strokeDasharray = s.dash;
          c.style.strokeDashoffset = s.offset;
          return c;
        }),
      );
      if (segs.length === 1 && size > MAX_SEGMENTS) {
        // a big mag: the spent part under a fill that empties
        const fill = g.firstElementChild!.cloneNode() as SVGCircleElement;
        g.firstElementChild!.classList.add('is-spent');
        fill.classList.add('mf-rounds__fill');
        g.append(fill);
      }
    }
    const spent = size > MAX_SEGMENTS ? roundsLeftDash(left, size) : String(Math.max(0, Math.min(size, left)));
    if (spent === this.spentKey) return;
    this.spentKey = spent;
    if (size > MAX_SEGMENTS) {
      (g.lastElementChild as SVGElement | null)?.style.setProperty('stroke-dasharray', spent);
      return;
    }
    [...g.children].forEach((c, i) => c.classList.toggle('is-spent', i >= left));
  }
}
