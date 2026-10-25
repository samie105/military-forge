/**
 * The Locker (docs/04 §6) in round two's kit (data-screen="locker", UI v2 phase 6): customise your
 * soldier. Pick an item to try it on (the soldier wears it), Wear it to keep it (an item you own; a
 * locked one says how to get it). A self-contained module: mountLocker() builds the screen inside
 * any element (fitted to the window like the menus, ui/fit.ts) and unmount() removes every trace
 * (DOM, styles, WebGL, listeners); the shell hosts it as the #/locker route, locker.html on its own.
 * The mm-* classes stay as hooks (the phone's layout, phone/locker.css, and the shot scripts).
 */
import {
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  RARITY_STYLE,
  cosmeticSourceLabel,
  cosmeticsForSlot,
  getCosmetic,
  fitsBody,
  isLoadoutGun,
  loadoutBody,
  weapons,
  type CosmeticLoadout,
  type CosmeticSlot,
  type DyeChannel,
  type WeaponDef,
} from '@military-forge/content';
import { CharacterAssembler, type CharacterInstance } from '../character';
import { weaponIcon } from '../ui/icons';
import { localGunStore, type GunStore } from './accountSync';
import { startFitting } from '../ui/fit';
import { moveIndicator } from '../ui/motion';
import { mountSprite } from '../ui/sprite';
import css from './locker.css?inline';
import { LocalLoadoutStore, ownedOnly, randomLoadout, starterInventory, withDye, withItem, type Inventory, type LoadoutStore } from './loadouts';
import { escapeHtml, ic, tileHtml } from './tiles';
import { Turntable, type FocusPreset, type LightPreset } from './turntable';

export { LocalLoadoutStore, ownedOnly, starterInventory, type Inventory, type LoadoutStore } from './loadouts';
export { tileHtml } from './tiles';

export interface LockerOptions {
  store?: LoadoutStore;
  inventory?: Inventory;
  /** share the game's assembler (and its geometry cache) */
  assembler?: CharacterAssembler;
  /** "Back" button; omitted = no button */
  onExit?: () => void;
  /** called after every change, already saved */
  onChange?: (loadout: CosmeticLoadout) => void;
  /** the two guns to spawn with (the Guns tab); default: this device's (locker/accountSync.ts) */
  guns?: GunStore;
  /** "Create your soldier": the character creator (body first, then the look); omitted = no button */
  onCreator?: () => void;
}

export interface LockerHandle {
  readonly loadout: CosmeticLoadout;
  unmount(): void;
}

/** The Locker as a shell route: `registerRoute({ id: 'locker', title: 'Locker', mount: (el) => mountLockerRoute(el) })`. */
export function mountLockerRoute(container: HTMLElement, options: LockerOptions = {}): () => void {
  const handle = mountLocker(container, options);
  return () => handle.unmount();
}

/**
 * The Locker's sections in round two's kit (data-screen="locker"), each one or more of the
 * loadout's slots. The kit's Gun finishes and Muzzle fire live in the Armory (camos, fire colours):
 * they aren't part of the saved loadout yet.
 */
const TABS: readonly { id: string; label: string; icon: string; slots: readonly { slot: CosmeticSlot; label: string }[] }[] = [
  { id: 'outfit', label: 'Outfit', icon: 'shirt', slots: [{ slot: 'top', label: 'Top' }, { slot: 'legs', label: 'Legs' }, { slot: 'gloves', label: 'Gloves' }, { slot: 'boots', label: 'Boots' }] },
  { id: 'helmet', label: 'Helmet', icon: 'helmet', slots: [{ slot: 'headgear', label: 'Headgear' }, { slot: 'eyewear', label: 'Eyewear' }] },
  { id: 'body', label: 'Body', icon: 'user', slots: [{ slot: 'bodyType', label: 'Build' }, { slot: 'skinTone', label: 'Skin' }] },
  { id: 'jetpack', label: 'Jetpack', icon: 'backpack', slots: [{ slot: 'jetpack', label: 'Jetpack' }, { slot: 'exhaust', label: 'Exhaust' }] },
  { id: 'dyes', label: 'Dyes', icon: 'palette', slots: [{ slot: 'dye', label: 'Dyes' }] },
  { id: 'trail', label: 'Dash trail', icon: 'sparkle', slots: [{ slot: 'trail', label: 'Dash trail' }] },
  // not a look: the two guns you spawn with (the Armory's Equip sets them too)
  { id: 'guns', label: 'Guns', icon: 'rack', slots: [] },
];
const CHANNEL_LABEL: Readonly<Record<DyeChannel, string>> = { primary: 'Main', secondary: 'Trim', accent: 'Accent' };
/** Each slot's glyph on an item without a colour (no item art yet). */
const SLOT_GLYPH: Partial<Record<CosmeticSlot, string>> = {
  top: 'shirt', legs: 'shirt', gloves: 'hand', boots: 'shirt', headgear: 'helmet', eyewear: 'eye',
  bodyType: 'user', jetpack: 'backpack', exhaust: 'flame', trail: 'sparkle',
};

/** The guns a player may choose, in the game's order. */
const LOADOUT_GUN_DEFS: readonly WeaponDef[] = weapons.filter((w) => isLoadoutGun(w.id));
const GUN_CLASS: Readonly<Record<string, string>> = { sidearm: 'Sidearm', smg: 'SMG', rifle: 'Rifle', dmr: 'Marksman', sniper: 'Sniper', shotgun: 'Shotgun', heavy: 'Heavy', special: 'Special' };

/** One gun in the Guns tab for loadout slot `slot`: On when it's that slot's, "Gun N" when it's the other's (picking it swaps the two). */
export function gunTileHtml(w: WeaponDef, slot: 0 | 1, pair: readonly [number, number]): string {
  const on = pair[slot] === w.index;
  const other = pair[1 - slot] === w.index;
  const icon = weaponIcon(w.id);
  const art = icon ? `<span class="mf-item__glyph mf-gun__art">${ic(icon, 'ic ic--kf')}</span>` : `<span class="mf-item__glyph">${ic('rack')}</span>`;
  const tag = on ? `<span class="tag tag--you">${ic('check')}On</span>` : other ? `<span class="tag tag--ghost">${ic('swap')}Gun ${2 - slot}</span>` : `<span class="tag tag--ghost">${GUN_CLASS[w.class] ?? w.class}</span>`;
  return `<button type="button" class="item mm-tile mf-gun${on ? ' is-on' : ''}" role="radio" aria-checked="${on}" data-gun="${w.id}" data-gslot="${slot}" title="${escapeHtml(`${w.name} · ${GUN_CLASS[w.class] ?? w.class}${other ? ` · now your gun ${2 - slot}: picking it swaps the two` : ''}`)}">
    <span class="item__art">${art}</span>
    <b class="item__name mm-name">${escapeHtml(w.name)}</b>
    ${tag}
  </button>`;
}

/** The Guns tab's two pickers. */
function gunsHtml(pair: readonly [number, number]): string {
  const picker = (slot: 0 | 1) =>
    `<h3 class="label mf-lk__sub">Gun ${slot + 1} · ${escapeHtml(weapons[pair[slot]]?.name ?? '')}</h3><div class="items mm-grid mf-guns" role="radiogroup" aria-label="Gun ${slot + 1}">${LOADOUT_GUN_DEFS.map((w) => gunTileHtml(w, slot, pair)).join('')}</div>`;
  return `<h2 class="display lk__h">Guns</h2><p class="lk__note mf-lk__guns-note">You spawn with these two. In a match you keep the guns you die holding.</p>${picker(0)}${picker(1)}`;
}

export function mountLocker(container: HTMLElement, options: LockerOptions = {}): LockerHandle {
  const store = options.store ?? new LocalLoadoutStore();
  const guns = options.guns ?? localGunStore();
  const inventory = options.inventory ?? starterInventory;
  const assembler = options.assembler ?? new CharacterAssembler();
  mountSprite();
  startFitting();
  const style = document.createElement('style');
  style.textContent = css;
  const fit = document.createElement('div');
  fit.className = 'mf mf-fit mf-gear-fit kit-v2';
  fit.innerHTML = `
  <section class="screen screen--menu" data-screen="locker" data-active-state="outfit" aria-label="Locker">
    <div class="bg" aria-hidden="true"><div class="bg__scrim"></div><div class="bg__camo"></div><div class="bg__grid"></div><div class="bg__dots"></div><div class="bg__slash"></div><div class="bg__word">LOCKER</div></div>
    <div class="menu mm-locker">
      <header class="menu-top mm-header">
        ${options.onExit ? `<button type="button" class="btn btn--ghost btn--icon btn--sm m-p8 mm-button" data-action="exit" aria-label="Back">${ic('back')}</button>` : ''}
        <h1 class="menu-top__title">Locker</h1><span class="serial">Quartermaster</span>
        <span class="mm-status" aria-live="polite"></span>
      </header>
      <nav class="tabs lk__tabs mm-tabs" role="tablist" aria-label="Locker sections" data-scroll-x>${TABS.map((t, i) => `<button type="button" class="tab m-p8" role="tab" data-tab="${i}">${ic(t.icon)}${t.label}</button>`).join('')}<span class="m-p5" aria-hidden="true"></span></nav>
      <div class="lk__stage mm-stage">
        <span class="brackets" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <div class="lk__disc" aria-hidden="true"></div>
        <canvas aria-label="Your soldier. Drag to turn, scroll to zoom."></canvas>
        <div class="mm-overlay">Loading soldier…</div>
        ${options.onCreator ? `<button type="button" class="btn btn--volt btn--sm m-p8 mf-lk__creator" data-action="creator">${ic('user')}Create your soldier</button>` : ''}
        <div class="mf-lk__fits">
          <span class="stamp stamp--volt stamp--lg lk__fits m-p7">${ic('fits')}Fits the body</span>
          <p class="lk__rule">Nothing you wear sticks out past the body, so every outfit hides and hits the same.</p>
        </div>
        <div class="mm-controls">
          <div class="seg mm-seg" data-group="focus" role="radiogroup" aria-label="View"><button type="button" class="seg__opt" role="radio" data-focus="full">Full</button><button type="button" class="seg__opt" role="radio" data-focus="face">Face</button><button type="button" class="seg__opt" role="radio" data-focus="jetpack">Jetpack</button></div>
          <span class="label lk__drag">${ic('rotate', 'ic ic--sm')}Drag to turn</span>
          <div class="seg mm-seg" data-group="light" role="radiogroup" aria-label="Light"><button type="button" class="seg__opt" role="radio" data-light="lobby">Lobby</button><button type="button" class="seg__opt" role="radio" data-light="night">Night</button><button type="button" class="seg__opt" role="radio" data-light="desert">Desert</button></div>
        </div>
      </div>
      <section class="lk__panel card card--print mm-panel" role="tabpanel">
        <div class="mm-panel__body"></div>
        <p class="mm-detail lk__note" aria-live="polite"></p>
        <div class="lk__act">
          <button type="button" class="btn btn--ghost m-p8" data-action="random">${ic('dice')}Randomise</button>
          <button type="button" class="btn btn--paper btn--xl m-p8" data-action="wear" disabled>${ic('check')}<span class="mm-wear">Wear it</span></button>
        </div>
      </section>
    </div>
  </section>`;
  container.append(style, fit);
  const root = fit.querySelector<HTMLElement>('.mm-locker')!;
  const screen = fit.querySelector<HTMLElement>('.screen')!;

  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const panel = $<HTMLElement>('.mm-panel__body');
  const detail = $<HTMLElement>('.mm-detail');
  const status = $<HTMLElement>('.mm-status');
  const overlay = $<HTMLElement>('.mm-overlay');
  const wear = $<HTMLButtonElement>('[data-action="wear"]');
  const wearText = $<HTMLElement>('.mm-wear');
  const tabBar = $<HTMLElement>('.mm-tabs');
  const turntable = new Turntable($<HTMLCanvasElement>('canvas'));
  let loadout: CosmeticLoadout = DEFAULT_COSMETIC_LOADOUT;
  /** what's being tried on: an item (and its dye channel), null when the soldier wears the saved look */
  let trying: { id: string; channel?: DyeChannel } | null = null;
  let tab = 0;
  let character: CharacterInstance | null = null;
  let alive = true;
  /** the player changed something before the saved look arrived: their edit wins */
  let edited = false;
  /** only the latest save may update the status */
  let saves = 0;

  const select = (group: string, attr: string, value: string) => {
    for (const b of root.querySelectorAll<HTMLElement>(`[data-group="${group}"] button`)) {
      b.setAttribute('aria-checked', String(b.dataset[attr] === value));
    }
  };

  /** the look with what's being tried on */
  const preview = (): CosmeticLoadout => {
    if (!trying) return loadout;
    const item = getCosmetic(trying.id);
    if (!item) return loadout;
    return item.slot === 'dye' ? withDye(loadout, trying.channel ?? 'primary', item.id) : withItem(loadout, item.slot, item.id);
  };

  const renderWear = () => {
    const item = trying ? getCosmetic(trying.id) : null;
    const owned = item ? inventory.owns(item.id) : false;
    const isOn = !item || (item.slot === 'dye' ? loadout.dyes[trying!.channel ?? 'primary'] === item.id : loadout.items[item.slot] === item.id);
    wear.disabled = !item || isOn || !owned;
    wearText.textContent = item && !owned ? 'Locked' : 'Wear it';
    screen.setAttribute('data-active-state', [TABS[tab]!.id, item ? (owned ? 'trying' : 'trying-locked') : 'idle'].join(' '));
  };

  const render = () => {
    tabBar.querySelectorAll<HTMLElement>('[data-tab]').forEach((b, i) => b.setAttribute('aria-selected', String(i === tab)));
    const sel = tabBar.querySelector<HTMLElement>('[aria-selected="true"]');
    if (sel) moveIndicator(tabBar.querySelector<HTMLElement>('.m-p5')!, sel.offsetLeft, sel.offsetWidth);
    const t = TABS[tab]!;
    if (t.id === 'guns') {
      panel.innerHTML = gunsHtml(guns.get());
      renderWear();
      return;
    }
    const body = loadoutBody(loadout);
    const section = (slot: CosmeticSlot, label: string, multi: boolean) => {
      // what fits the soldier's body (the creator switches body)
      const list = cosmeticsForSlot(slot).filter((c) => fitsBody(c, body));
      const tiles = (channel?: DyeChannel) =>
        list
          .map((c) =>
            tileHtml(
              c,
              channel ? loadout.dyes[channel] === c.id : slot !== 'dye' && loadout.items[slot] === c.id,
              inventory.owns(c.id),
              channel,
              trying?.id === c.id && trying.channel === channel,
              SLOT_GLYPH[slot] ?? t.icon,
            ),
          )
          .join('');
      const sw = list[0]?.colour ? ' mf-items--sw' : '';
      if (slot === 'dye') return DYE_CHANNELS.map((ch) => `<h3 class="label mf-lk__sub">${CHANNEL_LABEL[ch]}</h3><div class="items${sw} mm-grid" role="radiogroup" aria-label="${CHANNEL_LABEL[ch]} dye">${tiles(ch)}</div>`).join('');
      return `${multi ? `<h3 class="label mf-lk__sub">${label}</h3>` : ''}<div class="items${sw} mm-grid" role="radiogroup" aria-label="${label}">${tiles()}</div>`;
    };
    panel.innerHTML = `<h2 class="display lk__h">${t.label}</h2>${t.slots.map((x) => section(x.slot, x.label, t.slots.length > 1)).join('')}`;
    renderWear();
  };

  const showOnSoldier = () => character?.setLoadout(preview());

  const apply = (next: CosmeticLoadout) => {
    loadout = next;
    trying = null;
    edited = true;
    character?.setLoadout(loadout);
    render();
    const save = ++saves;
    const report = (text: string) => {
      if (alive && save === saves) status.textContent = text;
    };
    store.save(loadout).then(
      () => report(store.label),
      (error: unknown) => report(`Not saved: ${error instanceof Error ? error.message : String(error)}`),
    );
    options.onChange?.(loadout);
  };

  root.addEventListener('click', (e) => {
    const target = (e.target as Element).closest<HTMLElement>('button');
    if (!target) return;
    const d = target.dataset;
    if (d.action === 'exit') options.onExit?.();
    else if (d.action === 'creator') options.onCreator?.();
    else if (d.action === 'random') apply(randomLoadout(inventory, Math.random, loadoutBody(loadout)));
    else if (d.action === 'wear') {
      const next = preview();
      if (trying && inventory.owns(trying.id)) apply(next);
    } else if (d.gun && d.gslot !== undefined) {
      // a gun for slot N; the other slot's gun swaps places with it
      const w = weapons.find((x) => x.id === d.gun);
      if (!w) return;
      const slot = Number(d.gslot) as 0 | 1;
      const pair = guns.get();
      const next: [number, number] = [pair[0], pair[1]];
      if (pair[1 - slot] === w.index) next[1 - slot] = pair[slot];
      next[slot] = w.index;
      guns.set(next);
      detail.textContent = `${w.name} is your gun ${slot + 1}`;
      status.textContent = store.label;
      render();
    } else if (d.tab !== undefined) {
      tab = Number(d.tab);
      render();
    } else if (d.focus) {
      turntable.setFocus(d.focus as FocusPreset);
      select('focus', 'focus', d.focus);
    } else if (d.light) {
      turntable.setLighting(d.light as LightPreset);
      select('light', 'light', d.light);
    } else if (d.id) {
      // try it on: the soldier wears it; Wear it keeps it (an item you own)
      const item = getCosmetic(d.id)!;
      const how = cosmeticSourceLabel(item.source);
      const owned = inventory.owns(item.id);
      detail.textContent = `${item.name} · ${RARITY_STYLE[item.rarity].label}${owned ? '' : ` · Locked. How to get it: ${how}`}`;
      trying = { id: item.id, ...(d.channel ? { channel: d.channel as DyeChannel } : {}) };
      showOnSoldier();
      render();
    }
  });

  select('focus', 'focus', 'full');
  select('light', 'light', 'lobby');
  render();
  void (async () => {
    const saved = await store.load().catch(() => {
      if (alive) status.textContent = 'Could not load your saved look';
      return null;
    });
    if (!alive) return;
    if (saved && !edited) loadout = ownedOnly(saved, inventory);
    try {
      const instance = await assembler.create(loadout, 0);
      if (!alive) return instance.dispose();
      character = instance;
      character.setLoadout(preview());
      turntable.setCharacter(character);
      overlay.hidden = true;
      render();
    } catch (error) {
      overlay.textContent = `Could not load the soldier: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();

  return {
    get loadout() {
      return loadout;
    },
    unmount() {
      alive = false;
      character?.dispose();
      turntable.dispose();
      fit.remove();
      style.remove();
      if (!options.assembler) assembler.dispose();
    },
  };
}
