/**
 * Every gun's reload is heard the first time it happens: the director's steps through the real
 * engine, with the context running, and with it still starting (the first tap after a page reload:
 * on a phone the browser starts the sound only when that finger lifts).
 */
import { NO_WEAPON, weapons, type WeaponDef } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import type { Frame, PlayerView } from '../view';
import { AudioDirector } from './director';
import { AudioEngine, type PlayOptions } from './engine';
import { FakeContext } from './fakeContext.test-util';
import { weaponSounds } from './families';
import { SOUNDS, type SoundId } from './sounds';

const ME = 0;
const FOE = 1;

function soldier(id: number, def: WeaponDef, reloading: boolean): PlayerView {
  return {
    id,
    name: `p${id}`,
    isBot: false,
    isLocal: id === ME,
    alive: true,
    x: id * 8,
    y: 0,
    vx: 0,
    vy: 0,
    grounded: true,
    crouched: false,
    jetting: false,
    aim: 0,
    hp: 100,
    fuel: 196,
    fuelRegenDelay: 0,
    frags: 2,
    active: 0,
    dual: false,
    weapons: [
      { def: def.index, mag: 0, reserve: 90, reloadTicks: reloading ? Math.round(def.reload * 60) : 0 },
      { def: NO_WEAPON, mag: 0, reserve: 0, reloadTicks: 0 },
    ],
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
  };
}

/** The steps a reload of `def` should play (a shotgun: a shell per missing round, then the pump). */
function expected(def: WeaponDef, local: boolean): SoundId[] {
  const ws = weaponSounds(def.index)!;
  if (ws.perRound) {
    const n = Math.max(1, Math.min(6, local ? def.mag : 3));
    return [...Array<SoundId>(n).fill(ws.perRound.id), ws.perRound.end];
  }
  return ws.reload.map((r) => r.id);
}

function rig(state: FakeContext['state']) {
  const ctx = new FakeContext();
  ctx.state = state;
  let wall = 0;
  const engine = new AudioEngine(ctx.asAudioContext(), { render: () => [new Float32Array(64000).fill(0.1)], random: () => 0.5, clock: () => wall });
  const asked: SoundId[] = [];
  const play = engine.play.bind(engine);
  engine.play = (id: SoundId, o?: PlayOptions) => {
    asked.push(id);
    return play(id, o);
  };
  const director = new AudioDirector(engine);
  const step = (players: PlayerView[]) => {
    const f: Frame = { tick: 0, localId: ME, players, grenades: [] };
    ctx.currentTime += 1 / 60;
    wall += 1000 / 60;
    // as AudioRuntime.onFrame does: what waited for the context plays once it runs
    if (engine.waiting) engine.wake();
    director.onFrame(f, 1 / 60, { fuelMax: 196, fireHeld: false });
  };
  /** the sounds actually started on the context */
  const started = () => ctx.started.filter((s) => s.buffer && s.buffer.length > 1).length;
  return { ctx, engine, asked, step, started, later: (ms: number) => (wall += ms) };
}

const reloadable = weapons.filter((w) => w.reload > 0);

describe('reload sounds', () => {
  it('every gun that reloads has reload sounds, and each is a sound the bank has', () => {
    expect(reloadable.length).toBeGreaterThan(10);
    for (const def of reloadable) {
      const ids = expected(def, true);
      expect(ids.length, def.id).toBeGreaterThan(0);
      for (const id of ids) expect(id in SOUNDS, `${def.id}: ${id}`).toBe(true);
    }
  });

  it.each(reloadable.map((w) => [w.id, w] as const))('%s: the first reload plays every step (yours, the context running)', (_, def) => {
    const r = rig('running');
    r.step([soldier(ME, def, false)]);
    r.asked.length = 0;
    r.step([soldier(ME, def, true)]);
    const want = expected(def, true);
    expect(r.asked.filter((id) => want.includes(id))).toEqual(want);
    // started, none refused by a cooldown or a limit
    expect(r.started()).toBe(want.length);
    expect(r.engine.counters.cooled + r.engine.counters.refused).toBe(0);
  });

  it.each(reloadable.map((w) => [w.id, w] as const))('%s: the first reload after a page reload, the context still starting, plays every step once it runs', (_, def) => {
    const r = rig('suspended');
    r.step([soldier(ME, def, false)]);
    r.step([soldier(ME, def, true)]);
    const want = expected(def, true);
    expect(r.started()).toBe(0);
    expect(r.engine.waiting).toBe(want.length);
    // the finger lifts a moment later: the browser starts the context
    r.later(120);
    r.ctx.state = 'running';
    r.step([soldier(ME, def, true)]);
    expect(r.started()).toBe(want.length);
    expect(r.engine.counters.late).toBe(0);
  });

  it.each(reloadable.map((w) => [w.id, w] as const))('%s: another player\'s reload close by is heard too', (_, def) => {
    const r = rig('running');
    r.step([soldier(ME, def, false), soldier(FOE, def, false)]);
    r.step([soldier(ME, def, false), soldier(FOE, def, true)]);
    expect(r.started()).toBe(expected(def, false).length);
  });
});
