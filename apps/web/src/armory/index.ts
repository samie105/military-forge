/**
 * The Armory: every weapon model in 3D with its sockets and its stats from packages/content.
 * A self-contained module like the Locker: mountArmory() builds the screen inside any element and
 * unmount() removes every trace (DOM, styles, WebGL, listeners), so W4's shell can host it as a
 * route: `registerRoute({ id: 'armory', title: 'Armory', mount: (el) => mountArmoryRoute(el) })`.
 */
import type { LightPreset } from '../locker/turntable';
import css from './armory.css?inline';
import { statsCard, weaponDef } from './stats';
import { startFitting } from '../ui/fit';
import { weaponIcon } from '../ui/icons';
import { mountSprite } from '../ui/sprite';
import { getAttachment, isLoadoutGun, weapons as gameWeapons } from '@military-forge/content';
import { localGunStore, type GunStore } from '../locker/accountSync';
import { TextureLoader, type Texture } from 'three';
import { camoFits, camoMaterial, prepareCamoPatterns, type CamoSheet } from './camo';
import type { SpecialsManifest } from './specials';
import { ArmoryViewer, SOCKET_COLOURS, type AttachmentEntry, type FlashSheet, type ModelFrame, type Socket } from './viewer';

export { statsCard, type StatRow, type StatsCard } from './stats';

export interface ArmoryOptions {
  /** where weapons/ and vfx/ live; default: the app's public assets */
  assets?: string;
  /** "Back" button; omitted = no button */
  onExit?: () => void;
  /** the weapon to open with */
  weapon?: string;
  /** keep a Fire flash on screen this long (screenshots, QA); default: the flash's own duration */
  flashHoldMs?: number;
  /** freeze a special effect (flame, beam, orb…) this many seconds after Fire (screenshots, QA) */
  fxFreezeS?: number;
  /** cosmetic fire colour (weapons.vfx.json fireTints id) */
  fireTint?: string;
  /** camo to show (weapons/camos.json id) */
  camo?: string;
  /** attachments to mount on the first weapon (ids from packages/content/src/attachments.ts) */
  attach?: string[];
  /** open on a view: 'whole' or a socket name, a lighting preset, and fire once (deep links) */
  focus?: string;
  light?: LightPreset;
  fire?: boolean;
  /** "Try it in training" (a game weapon): default, the app's training with it in hand (/?app&try=id) */
  onTry?: (weaponId: string) => void;
  /** the two guns the player spawns with (Equip as gun 1 / 2); default: this device's, which the app sends to the account (locker/accountSync.ts) */
  guns?: GunStore;
}

export interface ArmoryHandle {
  select(id: string): Promise<void>;
  unmount(): void;
}

interface WeaponEntry {
  name: string;
  family: string;
  hands: number;
  tris: number;
  lengthM: number;
}

interface VfxManifest {
  flash: FlashSheet;
  weapons: Record<string, { flash: string | null; flashScale?: number; special?: string }>;
  fireTints?: { monoAtlas: string; tints: Record<string, { name: string; flash: string | null; tracer: string | null }> };
}

/** The Armory as a shell route. */
export function mountArmoryRoute(container: HTMLElement, options: ArmoryOptions = {}): () => void {
  const handle = mountArmory(container, options);
  return () => handle.unmount();
}

const SOCKET_NOTES: Record<string, string> = {
  grip: 'main hand', muzzle: 'flash, tracer, suppressor', offhand: 'left-hand IK', eject: 'casings',
  mag: 'reload', rail_top: 'scope / sight', rail_bottom: 'foregrip / laser', backblast: 'exhaust',
  tip: 'blade tip', pin: 'pin ring', light: 'status light', ground: 'rest frame',
  pilot: 'pilot light', charge: 'charge wind-up', face: 'blocks bullets',
};

const ic = (name: string, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

/** The rack's families in the kit's order, and their words. */
const FAMILIES: readonly [string, string][] = [
  ['pistol', 'Pistol'], ['rifle', 'Rifle'], ['shotgun', 'Shotgun'], ['sniper', 'Sniper'], ['launcher', 'Launcher'],
  ['heavy', 'Heavy'], ['shield', 'Shield'], ['melee', 'Melee'], ['thrown', 'Thrown'],
];

/** The kit's list (.ar__list): the weapons by family, each with its glyph. */
export function weaponList(weapons: Readonly<Record<string, { name: string; family: string }>>): string {
  const groups = new Map<string, [string, { name: string; family: string }][]>();
  for (const [id, w] of Object.entries(weapons)) groups.set(w.family, [...(groups.get(w.family) ?? []), [id, w]]);
  const order = [...FAMILIES.map(([f]) => f), ...[...groups.keys()].filter((f) => !FAMILIES.some(([k]) => k === f))];
  return `<ul>${order
    .filter((f) => groups.has(f))
    .map((f) => {
      const label = FAMILIES.find(([k]) => k === f)?.[1] ?? f;
      const items = groups.get(f)!.map(([id, w]) => {
        const glyph = weaponIcon(id);
        return `<li><button type="button" class="ar__item m-p8" data-weapon="${id}" aria-pressed="false">${glyph ? ic(glyph, 'ic--kf') : ''}<span>${escapeHtml(w.name)}</span></button></li>`;
      });
      return `<li><span class="label">${escapeHtml(label)}</span><ul>${items.join('')}</ul></li>`;
    })
    .join('')}</ul>`;
}

/** An attachment's glyph by what it is (its id) or where it mounts. */
export function attachIcon(id: string, mount: string): string {
  if (/suppress|silenc/.test(id) || mount === 'muzzle') return 'att-suppressor';
  if (/laser/.test(id)) return 'att-laser';
  if (/grip/.test(id)) return 'att-foregrip';
  if (/mag/.test(id) || mount === 'mag') return 'att-extmag';
  if (mount === 'rail_bottom') return 'att-foregrip';
  return 'att-scope';
}

/** Training with this gun in hand (main.ts reads ?try=). */
function tryInTraining(weaponId: string): void {
  location.assign(`/?app&try=${encodeURIComponent(weaponId)}`);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function mountArmory(container: HTMLElement, options: ArmoryOptions = {}): ArmoryHandle {
  const assets = options.assets ?? 'assets/';
  mountSprite();
  startFitting();
  const style = document.createElement('style');
  style.textContent = css;
  const fit = document.createElement('div');
  fit.className = 'mf mf-fit mf-gear-fit kit-v2';
  fit.innerHTML = `
  <section class="screen screen--menu" data-screen="armory" data-active-state="idle" aria-label="Armory">
    <div class="bg" aria-hidden="true"><div class="bg__scrim"></div><div class="bg__camo"></div><div class="bg__grid"></div><div class="bg__dots"></div><div class="bg__slash"></div><div class="bg__word">ARMORY</div></div>
    <div class="menu mf-armory">
      <header class="menu-top mf-header">
        ${options.onExit ? `<button type="button" class="btn btn--ghost btn--icon btn--sm m-p8" data-action="exit" aria-label="Back">${ic('back')}</button>` : ''}
        <h1 class="menu-top__title">Armory</h1>
        <span class="serial mf-status" aria-live="polite">Weapons bench</span>
      </header>
      <div class="menu-body ar">
        <nav class="ar__list mf-list" aria-label="Weapons"></nav>
        <div class="ar__stage mf-stage">
          <span class="label label--volt mf-ar__kind"></span>
          <h2 class="display display--print ar__name m-p1"></h2>
          <div class="ar__table">
            <div class="ar__disc" aria-hidden="true"><i></i></div>
            <canvas aria-label="The weapon. Drag to turn and tilt, scroll to zoom."></canvas>
            <div class="mf-overlay">Loading…</div>
            <span class="ar__rot label">${ic('rotate', 'ic ic--sm')}Drag to turn · scroll to zoom</span>
          </div>
          <div class="mf-controls">
            <button type="button" class="btn btn--volt btn--sm m-p8 mf-toggle" data-action="fire">${ic('target')}Fire</button>
            <div class="seg" data-group="focus" role="radiogroup" aria-label="View"><button type="button" class="seg__opt" data-focus="whole">Whole</button><button type="button" class="seg__opt" data-focus="muzzle">Muzzle</button></div>
            <div class="seg" data-group="light" role="radiogroup" aria-label="Light"><button type="button" class="seg__opt" data-light="lobby">Lobby</button><button type="button" class="seg__opt" data-light="night">Night</button><button type="button" class="seg__opt" data-light="desert">Desert</button></div>
            <button type="button" class="btn btn--ghost btn--sm m-p8 mf-toggle" data-action="sockets" aria-pressed="true">${ic('eye')}Sockets</button>
          </div>
          <div class="ar__ctrl mf-camo"></div>
        </div>
        <aside class="ar__side mf-side">
          <section class="ticket ar__stats mf-card" aria-live="polite"></section>
          <section class="card ar__att mf-attach"></section>
          <details class="card mf-sockets-box"><summary class="label">Sockets · where parts and effects attach</summary><div class="mf-sockets"></div></details>
          <section class="card mf-equip" aria-label="Equip">
            <span class="label">Your guns · you spawn with these</span>
            <p class="mf-equip__now"></p>
            <div class="seg mf-equip__seg" role="group" aria-label="Equip this gun"><button type="button" class="seg__opt m-p8" data-action="equip" data-slot="0">${ic('check')}Equip as gun 1</button><button type="button" class="seg__opt m-p8" data-action="equip" data-slot="1">${ic('check')}Equip as gun 2</button></div>
          </section>
          <button type="button" class="btn btn--volt btn--xl btn--block m-p8 mf-try" data-action="try">${ic('target')}Try it in training</button>
        </aside>
      </div>
    </div>
  </section>`;
  container.append(style, fit);
  const root = fit.querySelector<HTMLElement>('.mf-armory')!;
  const screen = fit.querySelector<HTMLElement>('.screen')!;

  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const list = $<HTMLElement>('.mf-list');
  const card = $<HTMLElement>('.mf-card');
  const kind = $<HTMLElement>('.mf-ar__kind');
  const nameEl = $<HTMLElement>('.ar__name');
  const tryBtn = $<HTMLButtonElement>('[data-action="try"]');
  const guns = options.guns ?? localGunStore();
  const equipBox = $<HTMLElement>('.mf-equip');
  const equipNow = $<HTMLElement>('.mf-equip__now');
  /** the Equip box: your pair now, and which slot (if any) this gun is in; only for guns a player may choose */
  const renderEquip = () => {
    const def = weaponDef(current);
    equipBox.hidden = !def || !isLoadoutGun(def.id);
    const pair = guns.get();
    equipNow.innerHTML = pair.map((i, n) => `<b>${n + 1}</b> ${escapeHtml(gameWeapons[i]?.name ?? '')}`).join('<span class="sep">·</span>');
    for (const b of equipBox.querySelectorAll<HTMLElement>('[data-action="equip"]')) {
      const inSlot = !!def && pair[Number(b.dataset.slot)] === def.index;
      b.setAttribute('aria-pressed', String(inSlot));
      b.setAttribute('aria-checked', String(inSlot));
    }
  };
  const socketPanel = $<HTMLElement>('.mf-sockets');
  const attachPanel = $<HTMLElement>('.mf-attach');
  const camoPanel = $<HTMLElement>('.mf-camo');
  const status = $<HTMLElement>('.mf-status');
  const overlay = $<HTMLElement>('.mf-overlay');
  const viewer = new ArmoryViewer($<HTMLCanvasElement>('canvas'));
  let alive = true;
  let current = '';
  let weapons: Record<string, WeaponEntry> = {};
  /** `attach`: the rig socket when it isn't the main hand; `frame`: shield space for the riot shield */
  let sockets: Record<string, { attach?: string; frame?: ModelFrame; sockets: Record<string, Socket> }> = {};
  let vfx: VfxManifest | null = null;
  let specials: SpecialsManifest | null = null;
  let socketsOn = true;
  let camoSheet: CamoSheet | null = null;
  let camoTex: Texture | null = null;
  let camo = '';
  let fireTint = 'classic';

  const renderCamo = () => {
    if (!camoSheet) return;
    const dot = (p: string[]) => `<i class="mf-sw">${p.slice(0, 2).map((c) => `<b style="background:${c}"></b>`).join('')}</i>`;
    const opt = ([id, c]: [string, CamoSheet['camos'][string]]) =>
      `<button type="button" class="seg__opt" role="radio" data-camo="${id}" aria-checked="${camo === id}" aria-pressed="${camo === id}"${camoFits(c, current) ? '' : ' disabled title="Not for this weapon"'}>${dot(c.palette)}${escapeHtml(c.name)}</button>`;
    const all = Object.entries(camoSheet.camos);
    const finishes = all.filter(([, c]) => c.kind === 'finish');
    const camos = all.filter(([, c]) => c.kind !== 'finish');
    const tints = vfx?.fireTints?.tints;
    const factory = `<button type="button" class="seg__opt" role="radio" data-camo="" aria-checked="${camo === ''}" aria-pressed="${camo === ''}">Factory</button>`;
    // no camo panels (the riot shield, the grenades): no camo or finish to offer (review L12)
    const paintable = viewer.hasCamoPanels();
    camoPanel.innerHTML = `${
      paintable
        ? `<div><span class="label">Finish</span><div class="seg" role="radiogroup" aria-label="Finish">${factory}${finishes.map(opt).join('')}</div></div>${
            camos.length ? `<div><span class="label">Camo · body panels</span><div class="seg" role="radiogroup" aria-label="Camo">${camos.map(opt).join('')}</div></div>` : ''
          }`
        : ''
    }${
      tints && vfx?.weapons[current]?.flash
        ? `<div><span class="label">Muzzle fire</span><div class="seg" role="radiogroup" aria-label="Muzzle fire">${Object.entries(tints)
            .map(([id, t]) => `<button type="button" class="seg__opt" role="radio" data-tint="${id}" aria-checked="${fireTint === id}" aria-pressed="${fireTint === id}">${t.flash ? dot([t.flash, t.tracer ?? t.flash]) : ''}${escapeHtml(t.name)}</button>`)
            .join('')}</div></div>`
        : ''
    }`;
  };
  const setState = () => {
    const finish = camoSheet?.camos[camo]?.name.toLowerCase().replace(/\s+/g, '-') ?? 'factory';
    screen.setAttribute('data-active-state', [current, finish, mounted.length ? 'attachment' : 'no-attachment'].filter(Boolean).join(' '));
  };
  const applyCamo = () => {
    const def = camoSheet?.camos[camo];
    const env = def?.kind === 'finish' ? viewer.environment() : null;
    viewer.setCamo(def && camoTex && camoSheet ? (m) => camoMaterial(m, camoTex!, camoSheet!, def, env) : null);
    renderCamo();
    setState();
  };
  let attachIndex: Record<string, AttachmentEntry & { fits: string[] }> = {};
  /** mounted attachment ids on the current weapon */
  let mounted: string[] = [];

  const fitting = (id: string) => Object.keys(attachIndex).filter((a) => attachIndex[a]!.fits.includes(id));
  const renderAttach = () => {
    const list = fitting(current);
    attachPanel.hidden = list.length === 0;
    attachPanel.innerHTML = list.length
      ? `<span class="label">Attachments · preview</span><div class="ar__atts">${list
          .map((a) => {
            const name = getAttachment(a)?.name ?? a;
            return `<button type="button" class="attb m-p8" data-attach="${a}" aria-pressed="${mounted.includes(a)}" title="${escapeHtml(name)} · ${attachIndex[a]!.mount.replace('_', ' ')}">${ic(attachIcon(a, attachIndex[a]!.mount))}<span>${escapeHtml(name)}</span></button>`;
          })
          .join('')}</div><p class="mf-ar__note">In-match pickups: shown here on the gun.</p>`
      : '';
  };
  const applyAttach = async () => {
    renderAttach();
    setState();
    const failed = await viewer.setAttachments(mounted.map((a) => ({ id: a, url: `${assets}attachments/${attachIndex[a]!.file}`, entry: attachIndex[a]! })));
    if (failed.length) {
      // a part that didn't load isn't mounted: un-press it
      mounted = mounted.filter((m) => !failed.includes(m));
      renderAttach();
    }
  };
  /** one part per mount, except the bottom rail, which takes a foregrip and a laser together */
  const toggleAttach = (a: string) => {
    if (mounted.includes(a)) mounted = mounted.filter((m) => m !== a);
    else {
      const mount = attachIndex[a]!.mount;
      if (mount !== 'rail_bottom') mounted = mounted.filter((m) => attachIndex[m]!.mount !== mount);
      mounted.push(a);
    }
    void applyAttach();
  };

  const press = (group: string, attr: string, value: string) => {
    for (const b of root.querySelectorAll<HTMLElement>(`[data-group="${group}"] button`)) {
      b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
      b.setAttribute('aria-checked', String(b.dataset[attr] === value));
    }
  };

  const renderCard = (id: string) => {
    const w = weapons[id]!;
    const c = statsCard(id);
    kind.textContent = c?.subtitle ?? w.family;
    nameEl.textContent = c?.title ?? w.name;
    nameEl.classList.remove('m-p1');
    void nameEl.offsetWidth; // restart the focus pull for the new name
    nameEl.classList.add('m-p1');
    card.innerHTML = c
      ? `<span class="label">Stat card</span><ul>${c.rows
          .map((r) => `<li><span>${escapeHtml(r.label)}</span><b class="num">${escapeHtml(r.value)}</b>${r.bar === undefined ? '' : `<span class="bar" style="--x:${r.bar.toFixed(3)}"><i></i></span>`}</li>`)
          .join('')}</ul>`
      : '<span class="label">Stat card</span><p class="mf-ar__note">Art only so far: the model is ready, its stats come with the arsenal.</p>';
    tryBtn.hidden = !c || !weaponDef(id);
    renderEquip();
    const ss = sockets[id]?.sockets ?? {};
    const offHand = sockets[id]?.frame === 'shield';
    socketPanel.innerHTML = `<ul>${Object.keys(ss)
      .map(
        (name) =>
          `<li><button type="button" data-socket="${name}"><span class="mf-dot" style="background:${SOCKET_COLOURS[name] ?? 'var(--c-text)'}"></span>${name}<small>${name === 'grip' && offHand ? 'off hand' : (SOCKET_NOTES[name] ?? '')}${ss[name]!.occupied ? ` · ${escapeHtml(ss[name]!.occupied!)} built in` : ''}</small></button></li>`,
      )
      .join('')}</ul>`;
  };

  const select = async (id: string) => {
    if (!weapons[id]) return;
    current = id;
    for (const b of list.querySelectorAll<HTMLElement>('[data-weapon]')) {
      b.setAttribute('aria-pressed', String(b.dataset.weapon === id));
      b.classList.toggle('is-sel', b.dataset.weapon === id);
    }
    renderCard(id);
    press('focus', 'focus', 'whole');
    const hook = vfx?.weapons[id];
    $<HTMLButtonElement>('[data-action="fire"]').disabled = !hook?.flash && !(hook?.special && specials?.styles[hook.special]);
    $<HTMLButtonElement>('[data-focus="muzzle"]').disabled = !sockets[id]?.sockets.muzzle;
    overlay.hidden = false;
    overlay.textContent = `Loading ${weapons[id]!.name}…`;
    mounted = [];
    renderAttach();
    try {
      const shown = await viewer.setWeapon(`${assets}weapons/${id}.glb`, sockets[id]?.sockets ?? {}, sockets[id]?.frame ?? 'weapon');
      if (alive && shown) {
        overlay.hidden = true;
        // a finish made for another weapon (the Hawk's gold) goes back to factory
        const def = camoSheet?.camos[camo];
        if (def && !camoFits(def, id)) camo = '';
        if (camo) applyCamo();
        else renderCamo();
      }
    } catch {
      if (alive) overlay.textContent = `Couldn't load ${weapons[id]!.name}.`;
    }
  };

  root.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    const d = t.dataset;
    if (d.action === 'exit') options.onExit?.();
    else if (d.action === 'try') (options.onTry ?? tryInTraining)(current);
    else if (d.action === 'equip') {
      // this gun in that slot; if it was already the other one, the two swap
      const def = weaponDef(current);
      if (!def || !isLoadoutGun(def.id)) return;
      const slot = Number(d.slot) as 0 | 1;
      const pair = guns.get();
      const next: [number, number] = [pair[0], pair[1]];
      if (pair[1 - slot] === def.index) next[1 - slot] = pair[slot];
      next[slot] = def.index;
      guns.set(next);
      status.textContent = `${def.name}: your gun ${slot + 1}`;
      renderEquip();
    }
    else if (d.weapon) void select(d.weapon);
    else if (d.attach) toggleAttach(d.attach);
    else if (d.camo !== undefined) {
      camo = d.camo;
      applyCamo();
    } else if (d.tint) {
      fireTint = d.tint;
      renderCamo();
    }
    else if (d.focus) {
      viewer.setFocus(d.focus);
      press('focus', 'focus', d.focus);
    } else if (d.socket) {
      viewer.setFocus(d.socket);
      press('focus', 'focus', '');
    } else if (d.light) {
      viewer.setLighting(d.light as LightPreset);
      press('light', 'light', d.light);
    } else if (d.action === 'sockets') {
      socketsOn = !socketsOn;
      viewer.setSocketsVisible(socketsOn);
      t.setAttribute('aria-pressed', String(socketsOn));
    } else if (d.action === 'fire' && vfx) {
      const hook = vfx.weapons[current];
      const tint = vfx.fireTints?.tints[fireTint]?.flash ?? null;
      const atlas = tint ? vfx.fireTints!.monoAtlas : vfx.flash.atlas;
      if (hook?.flash) void viewer.fire(vfx.flash, hook.flash, `${assets}vfx/${atlas}`, hook.flashScale ?? 1, options.flashHoldMs, tint);
      if (hook?.special && specials?.styles[hook.special]) {
        void viewer.fireSpecial(`${assets}vfx/`, specials, hook.special, options.flashHoldMs, options.fxFreezeS);
      }
    }
  });
  press('light', 'light', 'lobby');

  void (async () => {
    try {
      const [w, s, v, cs, att, sp] = await Promise.all([
        fetch(`${assets}weapons/weapons.json`).then((r) => r.json() as Promise<{ weapons: Record<string, WeaponEntry> }>),
        fetch(`${assets}weapons/sockets.json`).then((r) => r.json() as Promise<{ weapons: Record<string, { frame?: ModelFrame; sockets: Record<string, Socket> }> }>),
        fetch(`${assets}vfx/weapons.vfx.json`).then((r) => (r.ok ? (r.json() as Promise<VfxManifest>) : null)).catch(() => null),
        fetch(`${assets}weapons/camos.json`).then((r) => (r.ok ? (r.json() as Promise<CamoSheet>) : null)).catch(() => null),
        fetch(`${assets}attachments/attachments.json`)
          .then((r) => (r.ok ? (r.json() as Promise<{ attachments: Record<string, AttachmentEntry & { fits: string[] }> }>) : null))
          .catch(() => null),
        fetch(`${assets}vfx/specials.vfx.json`).then((r) => (r.ok ? (r.json() as Promise<SpecialsManifest>) : null)).catch(() => null),
      ]);
      if (!alive) return;
      weapons = w.weapons;
      sockets = s.weapons;
      vfx = v;
      specials = sp;
      attachIndex = att?.attachments ?? {};
      camoSheet = cs;
      if (cs) camoTex = prepareCamoPatterns(await new TextureLoader().loadAsync(`${assets}weapons/${cs.patterns}`));
      if (options.camo && cs?.camos[options.camo]) camo = options.camo;
      if (options.fireTint && v?.fireTints?.tints[options.fireTint]) fireTint = options.fireTint;
      renderCamo();
      list.innerHTML = weaponList(weapons);
      status.textContent = `Weapons bench · ${Object.keys(weapons).length} on the rack`;
      await select(options.weapon && weapons[options.weapon] ? options.weapon : Object.keys(weapons)[0]!);
      if (!alive) return;
      for (const a of options.attach ?? []) if (attachIndex[a]?.fits.includes(current)) toggleAttach(a);
      if (options.light) root.querySelector<HTMLElement>(`[data-light="${options.light}"]`)?.click();
      if (options.focus && options.focus !== 'whole') root.querySelector<HTMLElement>(`[data-focus="${options.focus}"], [data-socket="${options.focus}"]`)?.click();
      if (options.fire) root.querySelector<HTMLElement>('[data-action="fire"]')?.click();
    } catch {
      if (alive) overlay.textContent = "Couldn't load the arsenal.";
    }
  })();

  return {
    select,
    unmount() {
      alive = false;
      viewer.dispose();
      fit.remove();
      style.remove();
    },
  };
}
