/**
 * The character creator (owner, 22 Oct: "the 3D setup"): pick a body first, then dress it, on a large
 * live 3D turntable (drag to turn, scroll or pinch to zoom, a light preset). Randomise, Save; locked
 * items try on and say how to get them. Field Print's kit with Frost's glass on the panels.
 * First-time players get it once after the name screen (skippable); the Locker opens it again. A body
 * whose 3D art isn't in yet (the female soldier, until the Forge's art lands) is drawn on the male
 * rig, and the creator says so on the stage and on her card.
 * A self-contained module like the Locker: mountCreator() builds the screen inside any element and
 * unmount() removes every trace (DOM, style, WebGL, listeners). The model is creator/model.ts.
 */
import {
  BODIES,
  DYE_CHANNELS,
  DEFAULT_COSMETIC_LOADOUT,
  RARITY_STYLE,
  cosmeticSourceLabel,
  getCosmetic,
  loadoutBody,
  sanitizeCosmeticLoadout,
  type Body,
  type CosmeticDef,
  type CosmeticLoadout,
  type CosmeticSlot,
  type DyeChannel,
  type LoadoutSlot,
} from '@military-forge/content';
import { CharacterAssembler, type CharacterInstance } from '../character';
import { LocalLoadoutStore, ownedOnly, randomLoadout, starterInventory, withDye, withItem, type Inventory, type LoadoutStore } from '../locker/loadouts';
import { escapeHtml, ic, tileHtml } from '../locker/tiles';
import { Turntable, type FocusPreset, type LightPreset } from '../locker/turntable';
import { startFitting } from '../ui/fit';
import { moveIndicator } from '../ui/motion';
import { mountSprite } from '../ui/sprite';
import { getPortrait, peekPortrait, type PortraitRequest } from '../portrait';
import css from './creator.css?inline';
import { BODY_NAMES, BODY_SLOTS, bodyCards, itemsFor, lookTabs, markCreatorSeen, withBody, type BodyCard } from './model';

export { creatorSeen, markCreatorSeen } from './model';

export type CreatorExit = 'saved' | 'skipped' | 'back';

export interface CreatorOptions {
  store?: LoadoutStore;
  inventory?: Inventory;
  /** share the game's assembler (and its geometry cache) */
  assembler?: CharacterAssembler;
  /** the first-run step after the name screen: "Skip for now" instead of Back */
  first?: boolean;
  /** leaving: after Save, Skip or Back */
  onExit?: (how: CreatorExit) => void;
  /** where the first-run flag lives (default: localStorage) */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export interface CreatorHandle {
  readonly loadout: CosmeticLoadout;
  readonly body: Body;
  unmount(): void;
}

/** The creator as a shell route (#/creator), like the Locker's. */
export function mountCreatorRoute(container: HTMLElement, options: CreatorOptions = {}): () => void {
  const handle = mountCreator(container, options);
  return () => handle.unmount();
}

const CHANNEL_LABEL: Readonly<Record<DyeChannel, string>> = { primary: 'Main', secondary: 'Trim', accent: 'Accent' };
const SLOT_GLYPH: Partial<Record<string, string>> = {
  top: 'shirt', jacket: 'shirt', legs: 'shirt', gloves: 'hand', boots: 'shirt', headgear: 'helmet', eyewear: 'eye', hair: 'user',
  bodyType: 'user', jetpack: 'backpack', exhaust: 'flame', trail: 'sparkle', accessory: 'star',
};

function storageOrNull(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The body cards (the body step's first choice). `artPending`: bodies whose 3D art isn't in yet (drawn
 * on the male rig): their card says so.
 */
export function bodyCardsHtml(cards: readonly BodyCard[], body: Body, artPending: ReadonlySet<Body> = new Set()): string {
  return cards
    .map((c) => {
      const on = c.body === body;
      const absent = c.builds === 0;
      const pending = artPending.has(c.body);
      const note = absent ? 'Not available yet' : pending ? 'Deploys on the standard body for now' : `${c.builds} ${c.builds === 1 ? 'build' : 'builds'}`;
      const tag = on ? `<span class="tag tag--you">${ic('check')}On</span>` : pending ? '<span class="tag tag--soon">Soon</span>' : '';
      return `<button type="button" class="mf-cr__body${on ? ' is-on' : ''}${pending ? ' is-pending' : ''}" role="radio" aria-checked="${on}" data-body="${c.body}"${absent ? ' disabled' : ''}>
        <span class="mf-cr__body-art" aria-hidden="true">${ic('user')}</span>
        <b class="mf-cr__body-name">${escapeHtml(c.name)}</b>
        ${tag}
        <span class="mf-cr__body-note">${note}</span>
      </button>`;
    })
    .join('');
}

export function mountCreator(container: HTMLElement, options: CreatorOptions = {}): CreatorHandle {
  const store = options.store ?? new LocalLoadoutStore();
  const inventory = options.inventory ?? starterInventory;
  const assembler = options.assembler ?? new CharacterAssembler();
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  const first = !!options.first;
  mountSprite();
  startFitting();
  const style = document.createElement('style');
  style.textContent = css;
  const fit = document.createElement('div');
  fit.className = 'mf mf-fit mf-cr-fit kit-v2';
  fit.innerHTML = `
  <section class="screen screen--menu" data-screen="creator" data-active-state="body" aria-label="Create your soldier">
    <div class="bg" aria-hidden="true"><div class="bg__scrim"></div><div class="bg__camo"></div><div class="bg__grid"></div><div class="bg__dots"></div><div class="bg__slash"></div><div class="bg__word">RECRUIT</div></div>
    <div class="menu mf-cr">
      <header class="menu-top mf-cr__head">
        ${first ? '' : `<button type="button" class="btn btn--ghost btn--icon btn--sm m-p8" data-action="back" aria-label="Back">${ic('back')}</button>`}
        <div class="mf-cr__title">
          <span class="eyebrow">${first ? 'Enlistment · last step' : 'Locker'}</span>
          <h1 class="menu-top__title">Create your soldier</h1>
        </div>
        <ol class="mf-cr__steps" aria-label="Steps">
          <li data-step="body"><button type="button" data-goto="body"><b class="num">1</b>Body</button></li>
          <li data-step="look"><button type="button" data-goto="look"><b class="num">2</b>Look</button></li>
        </ol>
        <span class="mf-cr__status" aria-live="polite"></span>
        ${first ? `<button type="button" class="btn btn--ghost btn--sm m-p8" data-action="skip">Skip for now${ic('arrow-right')}</button>` : ''}
      </header>
      <div class="mf-cr__stage">
        <canvas aria-label="Your soldier. Drag to turn; scroll or pinch to zoom."></canvas>
        <div class="mf-cr__overlay">Loading soldier…</div>
        <div class="mf-cr__placeholder" role="note" hidden>
          <span class="stamp stamp--warn stamp--lg">Standard body</span>
          <p></p>
          <span class="mf-cr__placeholder-short">Deploys on the standard body for now</span>
        </div>
        <div class="mf-cr__view">
          <div class="seg" data-group="focus" role="radiogroup" aria-label="View"><button type="button" class="seg__opt" role="radio" data-focus="full">Full</button><button type="button" class="seg__opt" role="radio" data-focus="face">Face</button><button type="button" class="seg__opt" role="radio" data-focus="jetpack">Back</button></div>
          <div class="mf-cr__zoom" role="group" aria-label="Zoom"><button type="button" class="btn btn--ghost btn--icon btn--sm" data-zoom="in" aria-label="Zoom in">${ic('plus')}</button><button type="button" class="btn btn--ghost btn--icon btn--sm" data-zoom="out" aria-label="Zoom out">${ic('minus')}</button></div>
          <div class="seg" data-group="light" role="radiogroup" aria-label="Light"><button type="button" class="seg__opt" role="radio" data-light="lobby">Lobby</button><button type="button" class="seg__opt" role="radio" data-light="night">Night</button><button type="button" class="seg__opt" role="radio" data-light="desert">Desert</button></div>
        </div>
        <span class="label mf-cr__hint">${ic('rotate', 'ic ic--sm')}Drag to turn · scroll or pinch to zoom</span>
      </div>
      <aside class="mf-cr__panel" aria-label="Your soldier">
        <nav class="tabs mf-cr__tabs" role="tablist" aria-label="Look"></nav>
        <div class="mf-cr__body-step" role="group"></div>
        <div class="mf-cr__list"></div>
        <p class="mf-cr__detail" aria-live="polite"></p>
        <div class="mf-cr__act">
          <button type="button" class="btn btn--ghost m-p8" data-action="random" aria-label="Randomise">${ic('dice')}<span class="mf-cr__label">Randomise</span></button>
          <span class="mf-cr__act-gap"></span>
          <button type="button" class="btn btn--ghost m-p8" data-action="prev" aria-label="Back to body" hidden>${ic('back')}<span class="mf-cr__label">Body</span></button>
          <button type="button" class="btn btn--paper m-p8" data-action="next">Next: look${ic('arrow-right')}</button>
          <button type="button" class="btn btn--volt btn--xl m-p8" data-action="save">${ic('check')}<span class="mf-cr__save">Save soldier</span><span class="mf-cr__save-short" aria-hidden="true">Save</span></button>
        </div>
      </aside>
    </div>
  </section>`;
  container.append(style, fit);
  const screen = fit.querySelector<HTMLElement>('.screen')!;
  const root = fit.querySelector<HTMLElement>('.mf-cr')!;
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const tabsEl = $<HTMLElement>('.mf-cr__tabs');
  const bodyStep = $<HTMLElement>('.mf-cr__body-step');
  const list = $<HTMLElement>('.mf-cr__list');
  const detail = $<HTMLElement>('.mf-cr__detail');
  const status = $<HTMLElement>('.mf-cr__status');
  const overlay = $<HTMLElement>('.mf-cr__overlay');
  const placeholderNote = $<HTMLElement>('.mf-cr__placeholder');
  const save = $<HTMLButtonElement>('[data-action="save"]');
  const saveText = $<HTMLElement>('.mf-cr__save');
  const next = $<HTMLButtonElement>('[data-action="next"]');
  const prev = $<HTMLButtonElement>('[data-action="prev"]');
  const turntable = new Turntable($<HTMLCanvasElement>('canvas'));

  let draft: CosmeticLoadout = DEFAULT_COSMETIC_LOADOUT;
  /** the draft's body (its body type's) */
  let body: Body = 'male';
  /** bodies whose 3D art isn't in yet (the assembler draws them on the male rig) */
  const artPending = new Set<Body>();
  let step: 'body' | 'look' = 'body';
  let tab = 0;
  /** a locked item tried on (not in the draft) */
  let trying: { id: string; channel?: DyeChannel } | null = null;
  let character: CharacterInstance | null = null;
  let alive = true;
  let edited = false;
  let saving = false;

  /** the soldier on the stage is a stand-in: the draft's body has no 3D art yet */
  const standIn = () => artPending.has(body);

  /** picking a hairstyle: the stage shows the head bare (most helmets cover the hair); the look keeps its headgear */
  const bareHead = () => step === 'look' && lookTabs(body)[tab]?.id === 'hair' && !!getCosmetic('headgear_none');
  const preview = (): CosmeticLoadout => {
    const item = trying ? getCosmetic(trying.id) : null;
    const look =
      !item ? draft
      : item.slot === 'dye' ? withDye(draft, trying!.channel ?? 'primary', item.id)
      : item.slot === 'bodyType' ? withBody(draft, body, item.id)
      : sanitizeCosmeticLoadout(withItem(draft, item.slot, item.id));
    return bareHead() ? withItem(look, 'headgear', 'headgear_none') : look;
  };

  const show = () => {
    const c = character;
    if (!c) return;
    void c.setLoadout(preview()).then(() => {
      if (!alive || c !== character) return;
      // the assembler drew another body than the look's: its art isn't in yet
      const wanted = loadoutBody(c.loadout);
      if (c.body !== wanted) artPending.add(wanted);
      else artPending.delete(wanted);
      render();
    });
  };

  const select = (group: string, attr: string, value: string) => {
    for (const b of root.querySelectorAll<HTMLElement>(`[data-group="${group}"] button`)) b.setAttribute('aria-checked', String(b.dataset[attr] === value));
  };

  const grid = (slot: CosmeticSlot, label: string, heading: boolean, glyph: string): string => {
    const items = itemsFor(slot, body);
    const tiles = (channel?: DyeChannel) =>
      items
        .map((c: CosmeticDef) =>
          tileHtml(
            c,
            channel ? draft.dyes[channel] === c.id : slot !== 'dye' && draft.items[slot as LoadoutSlot] === c.id,
            inventory.owns(c.id),
            channel,
            trying?.id === c.id && trying.channel === channel,
            SLOT_GLYPH[slot] ?? glyph,
          ),
        )
        .join('');
    const sw = items[0]?.colour ? ' mf-items--sw' : '';
    if (slot === 'dye') return DYE_CHANNELS.map((ch) => `<h3 class="label mf-cr__sub">${CHANNEL_LABEL[ch]}</h3><div class="items${sw}" role="radiogroup" aria-label="${CHANNEL_LABEL[ch]} colour">${tiles(ch)}</div>`).join('');
    return `${heading ? `<h3 class="label mf-cr__sub">${escapeHtml(label)}</h3>` : ''}<div class="items${sw}" role="radiogroup" aria-label="${escapeHtml(label)}">${tiles()}</div>`;
  };

  const render = () => {
    const isStandIn = standIn();
    screen.setAttribute('data-active-state', [step, isStandIn ? 'stand-in' : '', first ? 'first' : ''].filter(Boolean).join(' '));
    for (const li of root.querySelectorAll<HTMLElement>('.mf-cr__steps li')) {
      const on = li.dataset.step === step;
      li.classList.toggle('is-on', on);
      li.querySelector('button')!.setAttribute('aria-current', on ? 'step' : 'false');
    }
    placeholderNote.hidden = !isStandIn;
    placeholderNote.querySelector('p')!.textContent = `${BODY_NAMES[body]}: arriving soon. Until then she deploys on the standard body.`;
    if (step === 'body') {
      tabsEl.hidden = true;
      bodyStep.hidden = false;
      bodyStep.innerHTML = `<h2 class="display mf-cr__h">Choose your body</h2>
        <div class="mf-cr__bodies" role="radiogroup" aria-label="Body">${bodyCardsHtml(bodyCards(), body, artPending)}</div>`;
      list.innerHTML = BODY_SLOTS.map((s) => grid(s.slot, s.label, true, 'user')).join('');
    } else {
      const tabs = lookTabs(body);
      tab = Math.min(tab, tabs.length - 1);
      tabsEl.hidden = false;
      bodyStep.hidden = true;
      bodyStep.innerHTML = '';
      // the label in a span: on a phone the tabs not chosen show their icon only, so every tab fits (P1-8)
      tabsEl.innerHTML = `${tabs.map((t, i) => `<button type="button" class="tab m-p8" role="tab" data-tab="${i}" aria-selected="${i === tab}" aria-label="${escapeHtml(t.label)}">${ic(t.icon)}<span class="mf-cr__tablabel">${t.label}</span></button>`).join('')}<span class="m-p5" aria-hidden="true"></span>`;
      const sel = tabsEl.querySelector<HTMLElement>('[aria-selected="true"]');
      if (sel) {
        moveIndicator(tabsEl.querySelector<HTMLElement>('.m-p5')!, sel.offsetLeft, sel.offsetWidth);
        sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      const t = tabs[tab]!;
      list.innerHTML = t.slots.map((s) => grid(s.slot, s.label, t.slots.length > 1, t.icon)).join('');
    }
    paintThumbs();
    next.hidden = step !== 'body';
    prev.hidden = step !== 'look';
    save.disabled = saving;
    saveText.textContent = first ? 'Save and play' : 'Save soldier';
  };

  /**
   * Each item's own picture (mobile audit P1-8: one glyph per slot told the items apart by name only):
   * the soldier's look with that item, drawn by the portrait service, in the tile's art box. Head items
   * get the head-and-shoulders portrait, the rest the full body. Drawn when idle, cached; the glyph
   * stays until a picture is in (and when 3D isn't available here).
   */
  const HEAD_SLOTS: ReadonlySet<string> = new Set(['headgear', 'eyewear', 'hair']);
  const paintThumbs = () => {
    for (const tile of list.querySelectorAll<HTMLElement>('.item[data-id]:not([data-channel])')) {
      const glyph = tile.querySelector<HTMLElement>('.mf-item__glyph');
      const def = getCosmetic(tile.dataset.id ?? '');
      if (!glyph || !def || def.slot === 'dye' || def.slot === 'bodyType') continue;
      const req: PortraitRequest = { look: withItem(draft, def.slot as LoadoutSlot, def.id), size: 128, pose: HEAD_SLOTS.has(def.slot) ? 'portrait' : 'poster-1' };
      const put = (img: { url: string; fallback?: boolean } | null) => {
        if (!img || img.fallback || !glyph.isConnected) return;
        glyph.innerHTML = `<img class="mf-item__thumb" src="${img.url}" alt="" draggable="false">`;
        glyph.classList.add('has-thumb');
      };
      const cached = peekPortrait(req);
      if (cached) put(cached);
      else void getPortrait(req, 'idle').then(put, () => {});
    }
  };

  const set = (loadout: CosmeticLoadout) => {
    draft = loadout;
    body = loadoutBody(draft);
    trying = null;
    edited = true;
    status.textContent = 'Not saved yet';
    show();
    render();
  };

  const pickBody = (b: Body) => {
    const card = bodyCards().find((c) => c.body === b)!;
    if (!card.builds) return;
    if (loadoutBody(draft) !== b) set(withBody(draft, b));
    detail.textContent = card.name;
  };

  const pickItem = (id: string, channel?: DyeChannel) => {
    const item = getCosmetic(id);
    if (!item) return;
    const owned = inventory.owns(id);
    if (!owned) {
      // a locked item tries on, and says how to get it
      trying = { id, ...(channel ? { channel } : {}) };
      detail.textContent = `${item.name} · ${RARITY_STYLE[item.rarity].label} · Locked. How to get it: ${cosmeticSourceLabel(item.source)}`;
      show();
      render();
      return;
    }
    detail.textContent = `${item.name} · ${RARITY_STYLE[item.rarity].label}`;
    if (item.slot === 'dye') set(withDye(draft, channel ?? 'primary', id));
    else if (item.slot === 'bodyType') set(withBody(draft, body, id));
    else set(sanitizeCosmeticLoadout(withItem(draft, item.slot, id)));
  };

  const doSave = () => {
    if (saving) return;
    saving = true;
    render();
    const look = ownedOnly(draft, inventory);
    store.save(look).then(
      () => {
        if (!alive) return;
        saving = false;
        markCreatorSeen(storage);
        status.textContent = store.label;
        options.onExit?.('saved');
      },
      (error: unknown) => {
        if (!alive) return;
        saving = false;
        status.textContent = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
        render();
      },
    );
  };

  root.addEventListener('click', (e) => {
    const target = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!target || target.disabled) return;
    const d = target.dataset;
    if (d.action === 'back') options.onExit?.('back');
    else if (d.action === 'skip') {
      markCreatorSeen(storage);
      options.onExit?.('skipped');
    } else if (d.action === 'save') doSave();
    else if (d.action === 'random') {
      set(randomLoadout(inventory, Math.random, body));
      detail.textContent = 'Randomised from what you own';
    } else if (d.action === 'next' || d.goto === 'look') {
      step = 'look';
      render();
      show();
    } else if (d.action === 'prev' || d.goto === 'body') {
      step = 'body';
      render();
      show();
    } else if (d.body) pickBody(d.body as Body);
    else if (d.tab !== undefined) {
      const wasBare = bareHead();
      tab = Number(d.tab);
      render();
      if (bareHead() !== wasBare) show();
      if (bareHead()) detail.textContent = 'Headwear off while you pick a hairstyle';
      // the stage frames the tab (locker/stage.ts shots; the animation agent's)
      turntable.frameTab(lookTabs(body)[tab]?.id ?? '');
    } else if (d.focus) {
      turntable.setFocus(d.focus as FocusPreset);
      select('focus', 'focus', d.focus);
    } else if (d.light) {
      turntable.setLighting(d.light as LightPreset);
      select('light', 'light', d.light);
    } else if (d.zoom) turntable.zoomBy(d.zoom === 'in' ? 0.85 : 1 / 0.85);
    else if (d.id) pickItem(d.id, d.channel as DyeChannel | undefined);
  });

  select('focus', 'focus', 'full');
  select('light', 'light', 'lobby');
  render();
  // which bodies' art is in (the cards say "Art coming" for the rest)
  for (const b of BODIES)
    void assembler.hasBodyArt(b).then(
      (has) => {
        if (!alive || has === !artPending.has(b)) return;
        if (has) artPending.delete(b);
        else artPending.add(b);
        render();
      },
      () => {},
    );
  void (async () => {
    const saved = await store.load().catch(() => {
      if (alive) status.textContent = 'Could not load your saved look';
      return null;
    });
    if (!alive) return;
    if (saved && !edited) {
      draft = ownedOnly(saved, inventory);
      body = loadoutBody(draft);
      render();
    }
    try {
      const instance = await assembler.create(preview(), 0);
      if (!alive) return instance.dispose();
      character = instance;
      show();
      turntable.setCharacter(character);
      overlay.hidden = true;
    } catch (error) {
      overlay.textContent = `Could not load the soldier: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();

  return {
    get loadout() {
      return draft;
    },
    get body() {
      return body;
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
