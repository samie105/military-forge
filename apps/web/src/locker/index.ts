/**
 * The Locker (docs/04 §6): customise your soldier. A self-contained module: mountLocker() builds
 * the screen inside any element and unmount() removes every trace (DOM, styles, WebGL, listeners),
 * so W4's shell can host it as a route later.
 */
import {
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  RARITY_STYLE,
  cosmeticSourceLabel,
  cosmeticsForSlot,
  getCosmetic,
  type CosmeticDef,
  type CosmeticLoadout,
  type CosmeticSlot,
  type DyeChannel,
} from '@military-forge/content';
import { CharacterAssembler, type CharacterInstance } from '../character';
import css from './locker.css?inline';
import { LocalLoadoutStore, ownedOnly, randomLoadout, starterInventory, withDye, withItem, type Inventory, type LoadoutStore } from './loadouts';
import { Turntable, type FocusPreset, type LightPreset } from './turntable';

export { LocalLoadoutStore, ownedOnly, starterInventory, type Inventory, type LoadoutStore } from './loadouts';

export interface LockerOptions {
  store?: LoadoutStore;
  inventory?: Inventory;
  /** share the game's assembler (and its geometry cache) */
  assembler?: CharacterAssembler;
  /** "Back" button; omitted = no button */
  onExit?: () => void;
  /** called after every change, already saved */
  onChange?: (loadout: CosmeticLoadout) => void;
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

const TABS: readonly { slot: CosmeticSlot; label: string }[] = [
  { slot: 'bodyType', label: 'Body' },
  { slot: 'skinTone', label: 'Skin' },
  { slot: 'headgear', label: 'Headgear' },
  { slot: 'eyewear', label: 'Eyewear' },
  { slot: 'top', label: 'Top' },
  { slot: 'gloves', label: 'Gloves' },
  { slot: 'legs', label: 'Legs' },
  { slot: 'boots', label: 'Boots' },
  { slot: 'jetpack', label: 'Jetpack' },
  { slot: 'exhaust', label: 'Exhaust' },
  { slot: 'trail', label: 'Trail' },
  { slot: 'dye', label: 'Dyes' },
];

const SHAPES: Record<string, string> = {
  circle: '<circle cx="6" cy="6" r="4.6"/>',
  triangle: '<path d="M6 1.2 11 10.4H1z"/>',
  diamond: '<path d="M6 .8 11.2 6 6 11.2.8 6z"/>',
  pentagon: '<path d="M6 .9 11.2 4.7 9.2 10.9H2.8L.8 4.7z"/>',
  star: '<path d="m6 .6 1.6 3.6 3.9.4-2.9 2.6.8 3.9L6 9.1l-3.4 2 .8-3.9L.5 4.6l3.9-.4z"/>',
};
const LOCK = '<svg class="mm-lock-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 5.5V4a3 3 0 0 1 6 0v1.5h.5a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1zm1.5 0h3V4a1.5 1.5 0 0 0-3 0z"/></svg>';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** One item tile: rarity frame + shape (colour-blind safe), swatch for colour items, lock + how-to-get. */
export function tileHtml(item: CosmeticDef, equipped: boolean, owned: boolean, channel?: DyeChannel): string {
  const r = RARITY_STYLE[item.rarity];
  const how = owned ? '' : cosmeticSourceLabel(item.source);
  const title = `${item.name} · ${r.label}${how ? ` · Locked: ${how}` : ''}`;
  return `<button type="button" class="mm-tile${owned ? '' : ' mm-locked'}" style="--rarity:${r.colour}" data-id="${item.id}"${channel ? ` data-channel="${channel}"` : ''} aria-pressed="${equipped}" title="${escapeHtml(title)}">
    <svg class="mm-rarity" viewBox="0 0 12 12" role="img" aria-label="${r.label}">${SHAPES[r.shape]}</svg>
    ${item.colour ? `<span class="mm-swatch" style="background:${item.colour}"></span>` : ''}
    <span class="mm-name">${escapeHtml(item.name)}</span>
    ${owned ? '' : `<span class="mm-how">${LOCK}${escapeHtml(how)}</span>`}
  </button>`;
}

export function mountLocker(container: HTMLElement, options: LockerOptions = {}): LockerHandle {
  const store = options.store ?? new LocalLoadoutStore();
  const inventory = options.inventory ?? starterInventory;
  const assembler = options.assembler ?? new CharacterAssembler();
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  root.className = 'mm-locker';
  root.innerHTML = `
    <header class="mm-header">
      ${options.onExit ? '<button type="button" class="mm-button" data-action="exit">&larr; Back</button>' : ''}
      <h1>Locker</h1>
      <span class="mm-status" aria-live="polite"></span>
      <button type="button" class="mm-button" data-action="random">Randomise</button>
    </header>
    <nav class="mm-tabs" role="tablist">${TABS.map((t, i) => `<button type="button" role="tab" data-tab="${i}">${t.label}</button>`).join('')}</nav>
    <section class="mm-panel" role="tabpanel"></section>
    <div class="mm-stage">
      <canvas aria-label="Your soldier. Drag to rotate, scroll to zoom."></canvas>
      <div class="mm-overlay">Loading soldier…</div>
      <div class="mm-controls">
        <div class="mm-seg" data-group="focus"><button data-focus="full">Full</button><button data-focus="face">Face</button><button data-focus="jetpack">Jetpack</button></div>
        <div class="mm-seg" data-group="light"><button data-light="lobby">Lobby</button><button data-light="night">Night</button><button data-light="desert">Desert</button></div>
      </div>
      <p class="mm-detail" aria-live="polite"></p>
    </div>`;
  container.append(style, root);

  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const panel = $<HTMLElement>('.mm-panel');
  const detail = $<HTMLElement>('.mm-detail');
  const status = $<HTMLElement>('.mm-status');
  const overlay = $<HTMLElement>('.mm-overlay');
  const turntable = new Turntable($<HTMLCanvasElement>('canvas'));
  let loadout: CosmeticLoadout = DEFAULT_COSMETIC_LOADOUT;
  let tab = 2;
  let character: CharacterInstance | null = null;
  let alive = true;
  /** the player changed something before the saved look arrived: their edit wins */
  let edited = false;
  /** only the latest save may update the status */
  let saves = 0;

  const select = (group: string, attr: string, value: string) => {
    for (const b of root.querySelectorAll<HTMLElement>(`[data-group="${group}"] button`)) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  };

  const render = () => {
    root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b, i) => b.setAttribute('aria-selected', String(i === tab)));
    const { slot } = TABS[tab]!;
    const tiles = (channel?: DyeChannel) =>
      cosmeticsForSlot(slot)
        .map((c) => tileHtml(c, channel ? loadout.dyes[channel] === c.id : slot !== 'dye' && loadout.items[slot] === c.id, inventory.owns(c.id), channel))
        .join('');
    panel.innerHTML =
      slot === 'dye'
        ? DYE_CHANNELS.map((ch) => `<h2>${ch[0]!.toUpperCase()}${ch.slice(1)}</h2><div class="mm-grid mm-swatches">${tiles(ch)}</div>`).join('')
        : `<div class="mm-grid${cosmeticsForSlot(slot)[0]?.colour ? ' mm-swatches' : ''}">${tiles()}</div>`;
  };

  const apply = (next: CosmeticLoadout) => {
    loadout = next;
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
    else if (d.action === 'random') apply(randomLoadout(inventory));
    else if (d.tab !== undefined) {
      tab = Number(d.tab);
      render();
    } else if (d.focus) {
      turntable.setFocus(d.focus as FocusPreset);
      select('focus', 'focus', d.focus);
    } else if (d.light) {
      turntable.setLighting(d.light as LightPreset);
      select('light', 'light', d.light);
    } else if (d.id) {
      const item = getCosmetic(d.id)!;
      const how = cosmeticSourceLabel(item.source);
      detail.textContent = `${item.name} · ${RARITY_STYLE[item.rarity].label}${inventory.owns(item.id) ? '' : ` · Locked. How to get: ${how}`}`;
      if (!inventory.owns(item.id)) return;
      if (item.slot === 'dye') apply(withDye(loadout, d.channel as DyeChannel, item.id));
      else apply(withItem(loadout, item.slot, item.id));
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
      character.setLoadout(loadout);
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
      root.remove();
      style.remove();
      if (!options.assembler) assembler.dispose();
    },
  };
}
