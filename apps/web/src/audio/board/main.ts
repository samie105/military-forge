/**
 * The sound board (sounds.html; /sounds.html on the playtest): every sound in the game with a play
 * button and a button per take, grouped as the game uses them. The bar sets the buses' volumes,
 * "Soften loud bursts", headphones (HRTF), under cover or in the open, walls in between, where world
 * sounds come from (left/right, above/below and distance from you), the music bed, and runs tests: a
 * rifle sweeping round you and away: eight players in a firefight (voice limits), a blast over gunfire
 * (ducking). Counters show voices playing, refused and cut, and the memory rendered so far.
 */
import { DEFAULT_AUDIO } from '../../shell/store';
import { variantsOf } from '../bank';
import { AudioEngine, type Volumes } from '../engine';
import { MusicBed, type MusicMode } from '../music';
import { SOUNDS, SOUND_IDS, type SoundId } from '../sounds';
import { makeAudioContext, playSilence } from '../unlock';
import { loadRecordings } from '../recordings/banks';

const root = document.getElementById('board')!;
let engine: AudioEngine | null = null;
let music: MusicBed | null = null;
const volumes: Volumes = { master: DEFAULT_AUDIO.master, sfx: DEFAULT_AUDIO.effects, music: DEFAULT_AUDIO.music, ui: DEFAULT_AUDIO.ui, voice: DEFAULT_AUDIO.voice };
/** where world sounds play from, relative to you (m) */
const place = { x: 0, y: 0 };
/** "Behind a wall": the board's stand-in for the map's occlusion (0, 1 or 2 walls) */
let walls = 0;
let headphones = false;
let covered = false;
let status: HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

/** The engine, made on the first press (browsers allow sound only after one). */
function audio(): AudioEngine | null {
  if (engine) {
    if (engine.ctx.state !== 'running') void engine.ctx.resume();
    return engine;
  }
  const ctx = makeAudioContext();
  if (!ctx) {
    status.textContent = 'This browser has no Web Audio.';
    return null;
  }
  playSilence(ctx);
  void ctx.resume();
  engine = new AudioEngine(ctx);
  engine.listener = { x: 0, y: 0 };
  engine.setVolumes(volumes);
  engine.setHrtf(headphones);
  engine.setEnclosure(covered ? 1 : 0);
  engine.occluder = () => walls;
  music = new MusicBed(engine);
  document.addEventListener('visibilitychange', () => engine?.setHidden(document.hidden));
  return engine;
}

const isWorld = (id: SoundId) => SOUNDS[id].bus === 'sfx' || SOUNDS[id].bus === 'big';
const at = (id: SoundId) => (isWorld(id) && (place.x !== 0 || place.y !== 0) ? { x: place.x, y: place.y } : {});

function play(id: SoundId, variant?: number): void {
  const e = audio();
  if (!e) return;
  if (SOUNDS[id].loop) {
    const key = `board:${id}`;
    if (e.loopKeys().includes(key)) e.stopLoop(key);
    else e.loop(key, id, at(id));
    return;
  }
  e.play(id, { ...at(id), ...(variant !== undefined ? { variant } : {}) });
}

function slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, on: (v: number) => void): HTMLElement {
  const out = el('output', {}, fmt(value));
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    on(v);
  });
  return el('label', { class: 'board__ctl' }, el('span', {}, label, out), input);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Eight players trading fire for three seconds around you: the voice limits at work. */
function firefight(withBlast: boolean): void {
  const e = audio();
  if (!e) return;
  const guns: SoundId[] = ['smg.fire', 'rifle.fire', 'pistol.fire', 'lmg.fire', 'smg.fire', 'rifle.fire', 'shotgun.fire', 'sniper.fire'];
  const shooters = guns.map((g, i) => ({ g, x: (i - 3.5) * 6, rate: g === 'smg.fire' || g === 'lmg.fire' ? 0.07 : g === 'rifle.fire' ? 0.1 : 0.45 }));
  const t0 = performance.now();
  const next = shooters.map(() => 0);
  const timer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    if (t > 3) return clearInterval(timer);
    shooters.forEach((s, i) => {
      if (t >= next[i]!) {
        e.play(s.g, { x: s.x, y: 0 });
        if (Math.random() < 0.3) e.play('impact.wall', { x: s.x + 5, y: 0 });
        next[i] = t + s.rate * (0.8 + Math.random() * 0.4);
      }
    });
    if (withBlast && t > 1.2 && t < 1.25) {
      e.play('frag.explode', { x: 3, y: 0 });
      e.duck(0.7 * 0.95, 0.25);
    }
  }, 16);
}

function render(): void {
  status = el('span', { class: 'board__status' }, `${SOUND_IDS.length} sounds, ${SOUND_IDS.reduce((n, id) => n + variantsOf(id), 0)} takes · press anything to start`);
  const mix = el(
    'div',
    { class: 'board__mix' },
    ...(
      [
        ['Master', 'master'],
        ['Effects', 'sfx'],
        ['Music', 'music'],
        ['Interface', 'ui'],
        ['Voices', 'voice'],
      ] as const
    ).map(([label, k]) =>
      slider(label, volumes[k], 0, 1, 0.01, pct, (v) => {
        volumes[k] = v;
        engine?.setVolumes(volumes);
      }),
    ),
    slider('From you: left ↔ right', 0, -40, 40, 1, (v) => (v === 0 ? 'centre (yours)' : `${v > 0 ? 'right' : 'left'} ${Math.abs(v)} m`), (v) => (place.x = v)),
    slider('From you: below ↔ above', 0, -20, 20, 1, (v) => `${v} m`, (v) => (place.y = v)),
  );
  const soft = el('input', { type: 'checkbox' });
  soft.addEventListener('change', () => audio()?.setSoft(soft.checked));
  const phones = el('input', { type: 'checkbox' });
  phones.addEventListener('change', () => {
    headphones = phones.checked;
    audio()?.setHrtf(headphones);
  });
  const cover = el('input', { type: 'checkbox' });
  cover.addEventListener('change', () => {
    covered = cover.checked;
    audio()?.setEnclosure(covered ? 1 : 0);
  });
  const wallSel = el('select', { 'aria-label': 'Walls between you and the sound', class: 'board__search' }, el('option', { value: '0' }, 'No wall'), el('option', { value: '1' }, 'Behind a wall'), el('option', { value: '2' }, 'Behind two walls'));
  wallSel.style.flex = '0 0 auto';
  wallSel.addEventListener('change', () => (walls = Number(wallSel.value)));
  const sweep = el('button', { type: 'button', class: 'btn btn--paper btn--sm' }, 'Sweep around you');
  sweep.addEventListener('click', () => {
    // a rifle walking round you: left, above, right, below, then far away (headphones on to place it)
    const e = audio();
    if (!e) return;
    const pts: [number, number][] = [
      [-14, 0],
      [-10, 8],
      [0, 12],
      [10, 8],
      [14, 0],
      [10, -8],
      [0, -12],
      [-10, -8],
      [0, 45],
      [0, 90],
    ];
    pts.forEach(([x, y], i) => setTimeout(() => e.play('rifle.fire', { x, y }), i * 450));
  });
  const musicButtons = (['menu', 'lobby', 'off'] as MusicMode[]).map((m) => {
    const b = el('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, m === 'off' ? 'Music off' : `Music: ${m}`);
    b.addEventListener('click', () => {
      audio();
      music?.setMode(m);
    });
    return b;
  });
  const fight = el('button', { type: 'button', class: 'btn btn--paper btn--sm' }, 'Firefight ×8');
  fight.addEventListener('click', () => firefight(false));
  const blast = el('button', { type: 'button', class: 'btn btn--paper btn--sm' }, 'Blast over gunfire');
  blast.addEventListener('click', () => firefight(true));
  const stop = el('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Stop all');
  stop.addEventListener('click', () => {
    engine?.stopAll();
    music?.setMode('off');
  });
  const search = el('input', { type: 'search', class: 'board__search', placeholder: 'Find a sound', 'aria-label': 'Find a sound' });
  const bar = el(
    'div',
    { class: 'board__bar' },
    el('div', { class: 'board__head' }, el('h1', { class: 'board__title' }, 'Sound board', el('small', {}, 'every sound, made in code')), status),
    mix,
    el('div', { class: 'board__tools' }, el('label', {}, soft, 'Soften loud bursts'), el('label', {}, phones, 'Headphones (3D)'), el('label', {}, cover, 'Under cover'), wallSel, ...musicButtons, sweep, fight, blast, stop, search),
  );

  const groups = new Map<string, SoundId[]>();
  for (const id of SOUND_IDS) {
    const g = SOUNDS[id].group;
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const rows = new Map<SoundId, HTMLElement>();
  const sections = [...groups].map(([name, ids]) => {
    const list = el('div', { class: 'board__list' });
    for (const id of ids) {
      const def = SOUNDS[id];
      const n = variantsOf(id);
      const btn = el('button', { type: 'button', class: def.loop ? 'snd__play is-loop' : 'snd__play', 'aria-label': `Play ${def.label}` }, def.loop ? '⟳' : '▶');
      btn.addEventListener('click', () => {
        play(id);
        if (def.loop) row.classList.toggle('is-playing');
      });
      const vars = el('div', { class: 'snd__vars' });
      if (n > 1 && !def.loop)
        for (let v = 0; v < n; v++) {
          const b = el('button', { type: 'button', 'aria-label': `${def.label}, take ${v + 1}` }, String(v + 1));
          b.addEventListener('click', () => play(id, v));
          vars.append(b);
        }
      const row = el('div', { class: 'snd', 'data-id': id }, btn, el('div', { class: 'snd__txt' }, el('b', {}, def.label), el('code', {}, id), el('span', { class: 'snd__bus' }, def.bus === 'big' ? 'effects · blast' : def.bus === 'sfx' ? 'effects' : def.bus === 'ui' ? 'interface' : def.bus)), vars);
      rows.set(id, row);
      list.append(row);
    }
    return el('section', { class: 'board__group', 'data-group': name }, el('h2', {}, name, el('small', {}, `${ids.length}`)), list);
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const [id, row] of rows) row.hidden = q !== '' && !`${id} ${SOUNDS[id].label}`.toLowerCase().includes(q);
    for (const s of sections) s.hidden = [...s.querySelectorAll<HTMLElement>('.snd')].every((r) => r.hidden);
  });
  root.replaceChildren(bar, ...sections);
  root.removeAttribute('aria-busy');

  // live counters
  setInterval(() => {
    if (!engine) return;
    const m = engine.memory();
    const c = engine.counters;
    status.textContent = `${engine.activeVoices()} playing · ${c.played} played, ${c.stolen} cut, ${c.refused} refused, ${c.cooled} in cooldown · ${m.buffers} takes rendered, ${(m.bytes / 1048576).toFixed(1)} MB`;
    status.classList.toggle('is-live', engine.activeVoices() > 0);
  }, 200);
}

// the recorded takes' banks first (recordings/banks.ts): every sound that uses one renders from them
loadRecordings().then(render, (e: unknown) => {
  root.textContent = `The recorded sounds didn't load (${(e as Error)?.message ?? e}). Reload to try again.`;
  root.removeAttribute('aria-busy');
});
