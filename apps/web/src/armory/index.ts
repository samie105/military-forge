/**
 * The Armory: every weapon model in 3D with its sockets and its stats from packages/content.
 * A self-contained module like the Locker: mountArmory() builds the screen inside any element and
 * unmount() removes every trace (DOM, styles, WebGL, listeners), so W4's shell can host it as a
 * route: `registerRoute({ id: 'armory', title: 'Armory', mount: (el) => mountArmoryRoute(el) })`.
 */
import type { LightPreset } from '../locker/turntable';
import css from './armory.css?inline';
import { statsCard } from './stats';
import { getAttachment } from '@military-forge/content';
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function mountArmory(container: HTMLElement, options: ArmoryOptions = {}): ArmoryHandle {
  const assets = options.assets ?? 'assets/';
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  root.className = 'mf-armory';
  root.innerHTML = `
    <header class="mf-header">
      ${options.onExit ? '<button type="button" class="mf-button" data-action="exit">&larr; Back</button>' : ''}
      <h1>Armory</h1>
      <span class="mf-status" aria-live="polite"></span>
    </header>
    <nav class="mf-list" aria-label="Weapons"></nav>
    <div class="mf-stage">
      <canvas aria-label="The weapon. Drag to rotate and tilt, scroll to zoom."></canvas>
      <div class="mf-overlay">Loading…</div>
      <div class="mf-controls">
        <div class="mf-seg" data-group="focus"><button data-focus="whole">Whole</button><button data-focus="muzzle">Muzzle</button></div>
        <button type="button" class="mf-toggle" data-action="sockets" aria-pressed="true">Sockets</button>
        <button type="button" class="mf-toggle" data-action="fire">Fire</button>
        <div class="mf-seg" data-group="light"><button data-light="lobby">Lobby</button><button data-light="night">Night</button><button data-light="desert">Desert</button></div>
      </div>
    </div>
    <aside class="mf-side">
      <section class="mf-card" aria-live="polite"></section>
      <section class="mf-camo"></section>
      <section class="mf-attach"></section>
      <section class="mf-sockets"></section>
    </aside>`;
  container.append(style, root);

  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const list = $<HTMLElement>('.mf-list');
  const card = $<HTMLElement>('.mf-card');
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
    const chips = (p: string[]) => `<span class="mf-chips">${p.map((c) => `<i style="background:${c}"></i>`).join('')}</span>`;
    const button = ([id, c]: [string, CamoSheet['camos'][string]]) =>
      `<button type="button" data-camo="${id}" aria-pressed="${camo === id}"${camoFits(c, current) ? '' : ' disabled title="not for this weapon"'}>${chips(c.palette)}${escapeHtml(c.name)}</button>`;
    const all = Object.entries(camoSheet.camos);
    const finishes = all.filter(([, c]) => c.kind === 'finish');
    const tints = vfx?.fireTints?.tints;
    camoPanel.innerHTML = `<h3>Camo <small>body panels only</small></h3><div class="mf-camos">
      <button type="button" data-camo="" aria-pressed="${camo === ''}">Factory</button>
      ${all.filter(([, c]) => c.kind !== 'finish').map(button).join('')}
    </div>${finishes.length ? `<h3>Finish <small>cosmetic</small></h3><div class="mf-camos">${finishes.map(button).join('')}</div>` : ''}${
      tints && vfx?.weapons[current]?.flash
        ? `<h3>Fire colour <small>cosmetic</small></h3><div class="mf-camos">${Object.entries(tints).map(([id, t]) =>
          `<button type="button" data-tint="${id}" aria-pressed="${fireTint === id}">${t.flash ? chips([t.flash, t.tracer ?? t.flash]) : ''}${escapeHtml(t.name)}</button>`).join('')}</div>`
        : ''
    }`;
  };
  const applyCamo = () => {
    const def = camoSheet?.camos[camo];
    const env = def?.kind === 'finish' ? viewer.environment() : null;
    viewer.setCamo(def && camoTex && camoSheet ? (m) => camoMaterial(m, camoTex!, camoSheet!, def, env) : null);
    renderCamo();
  };
  let attachIndex: Record<string, AttachmentEntry & { fits: string[] }> = {};
  /** mounted attachment ids on the current weapon */
  let mounted: string[] = [];

  const fitting = (id: string) => Object.keys(attachIndex).filter((a) => attachIndex[a]!.fits.includes(id));
  const renderAttach = () => {
    const list = fitting(current);
    attachPanel.innerHTML = list.length
      ? `<h3>Attachments <small>in-match pickups</small></h3><ul>${list.map((a) =>
        `<li><button type="button" data-attach="${a}" aria-pressed="${mounted.includes(a)}">${escapeHtml(getAttachment(a)?.name ?? a)}<small>${attachIndex[a]!.mount.replace('_', ' ')}</small></button></li>`).join('')}</ul>`
      : '';
  };
  const applyAttach = async () => {
    renderAttach();
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
    for (const b of root.querySelectorAll<HTMLElement>(`[data-group="${group}"] button`)) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  };

  const renderCard = (id: string) => {
    const w = weapons[id]!;
    const c = statsCard(id);
    const head = `<h2>${escapeHtml(c?.title ?? w.name)}</h2><p class="mf-sub">${escapeHtml(c?.subtitle ?? w.family)} · ${w.tris} tris · ${w.lengthM.toFixed(2)} m</p>`;
    card.innerHTML = c
      ? head + `<dl>${c.rows.map((r) => `<div><dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}</dd>${r.bar === undefined ? '' : `<span class="mf-bar" style="--fill:${(r.bar * 100).toFixed(0)}%"></span>`}</div>`).join('')}</dl>`
      : head + '<p class="mf-note">Not in packages/content yet: the model is ready, the stats come with the arsenal stream.</p>';
    const ss = sockets[id]?.sockets ?? {};
    const offHand = sockets[id]?.frame === 'shield';
    socketPanel.innerHTML = `<h3>Sockets</h3><ul>${Object.keys(ss).map((name) =>
      `<li><button type="button" data-socket="${name}"><span class="mf-dot" style="background:${SOCKET_COLOURS[name] ?? '#fff'}"></span>${name}<small>${name === 'grip' && offHand ? 'off hand' : (SOCKET_NOTES[name] ?? '')}${ss[name]!.occupied ? ` · ${escapeHtml(ss[name]!.occupied!)} built in` : ''}</small></button></li>`).join('')}</ul>`;
  };

  const select = async (id: string) => {
    if (!weapons[id]) return;
    current = id;
    for (const b of list.querySelectorAll<HTMLElement>('[data-weapon]')) b.setAttribute('aria-current', String(b.dataset.weapon === id));
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
      list.innerHTML = Object.entries(weapons).map(([id, e]) =>
        `<button type="button" data-weapon="${id}"><strong>${escapeHtml(e.name)}</strong><small>${escapeHtml(e.family)}${statsCard(id) ? '' : ' · art only'}</small></button>`).join('');
      status.textContent = `${Object.keys(weapons).length} weapons`;
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
      root.remove();
      style.remove();
    },
  };
}
