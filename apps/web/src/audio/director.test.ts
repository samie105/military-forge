/** The director: which sounds the game's events and frames call for, and from where. */
import { BREACHER, BUZZ, HitZone, K47, NO_WEAPON, PROJECTILE_TYPE_BASE, THUMPER, weapons } from '@military-forge/content';
import { MatchPhase, type SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import type { MatchView } from '../shell/matchView';
import type { ShellState } from '../shell/store';
import type { Frame, GrenadeView, PlayerView } from '../view';
import { AudioDirector, segmentDistance, type FrameExtras, type Sink } from './director';
import type { PlayOptions, Voice } from './engine';
import type { SoundId } from './sounds';
import { clickSound, musicFor, shellCues } from './ui';

class Recorder implements Sink {
  now = 0;
  listener: { x: number; y: number } | null = null;
  soft = false;
  readonly plays: { id: SoundId; o: PlayOptions; voice: Voice & { stopped: boolean } }[] = [];
  readonly loops = new Map<string, SoundId>();
  readonly stoppedLoops: string[] = [];
  readonly ducks: number[] = [];
  readonly muffles: number[] = [];
  readonly ownDucks: number[] = [];
  duckOwn(d = 0.35) {
    this.ownDucks.push(d);
  }
  play(id: SoundId, o: PlayOptions = {}) {
    const voice = { id, priority: 50, startedAt: this.now + (o.delay ?? 0), ended: false, stopped: false, stop: () => (voice.stopped = true) };
    this.plays.push({ id, o, voice });
    return voice;
  }
  loop(key: string, id: SoundId) {
    this.loops.set(key, id);
  }
  stopLoop(key: string) {
    if (this.loops.delete(key)) this.stoppedLoops.push(key);
  }
  loopKeys() {
    return [...this.loops.keys()];
  }
  duck(d: number) {
    this.ducks.push(d);
  }
  muffle(a: number) {
    this.muffles.push(a);
  }
  ids() {
    return this.plays.map((p) => p.id);
  }
  clear() {
    this.plays.length = 0;
  }
}

const ME = 0;
const FOE = 1;

function player(id: number, over: Partial<PlayerView> = {}): PlayerView {
  return {
    id,
    name: `p${id}`,
    isBot: false,
    isLocal: id === ME,
    alive: true,
    x: id * 10,
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
      { def: K47.index, mag: 30, reserve: 90, reloadTicks: 0 },
      { def: BUZZ.index, mag: 30, reserve: 90, reloadTicks: 0 },
    ],
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
    ...over,
  };
}

const frame = (players: PlayerView[], grenades: GrenadeView[] = [], extra: Partial<Frame> = {}): Frame => ({ tick: 0, localId: ME, players, grenades, ...extra });
const X: FrameExtras = { fuelMax: 196, fireHeld: false };

function setup() {
  const sink = new Recorder();
  const d = new AudioDirector(sink);
  const step = (f: Frame, x: FrameExtras = X, dt = 1 / 60) => {
    sink.now += dt;
    d.onFrame(f, dt, x);
  };
  const events = (es: SimEvent[]) => d.onEvents(es, ME);
  return { sink, d, step, events };
}

const shot = (shooter: number, weapon: number, over: Partial<Extract<SimEvent, { type: 'shot' }>> = {}): SimEvent => ({ type: 'shot', shooter, weapon, ox: shooter * 10, oy: 1, ex: shooter * 10 + 5, ey: 1, hit: 0, target: -1, zone: 0, ...over });

describe('gunfire', () => {
  it('your own gun plays centred and up front; another\'s from where it is', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME), player(FOE)]));
    events([shot(ME, K47.index), shot(FOE, BUZZ.index)]);
    const mine = sink.plays.find((p) => p.id === 'rifle.fire');
    const theirs = sink.plays.find((p) => p.id === 'smg.fire');
    expect(mine!.id).toBe('rifle.fire');
    expect(mine!.o.x).toBeUndefined();
    expect(mine!.o.priority).toBeGreaterThan(0);
    expect(theirs!.id).toBe('smg.fire');
    expect(theirs!.o.x).toBe(10);
  });

  it('a shotgun\'s pellets are one bang, then the pump', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME)]));
    events(Array.from({ length: 5 }, () => shot(ME, BREACHER.index)));
    expect(sink.ids().filter((i) => i === 'shotgun.fire')).toHaveLength(1);
    const pump = sink.plays.find((p) => p.id === 'shotgun.pump')!;
    expect(pump.o.delay).toBeGreaterThan(0.2);
  });

  it('where bullets land: a wall, a body, a riot shield; a near miss cracks past you', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME), player(FOE)]));
    events([shot(FOE, K47.index, { hit: 1, ex: 3, ey: 1 })]);
    expect(sink.ids()).toContain('impact.wall');
    // the bullet flew from x=10 to x=3 past us at x=0..: it passes within reach of the listener at (0, 1)? no: it stops at 3
    sink.clear();
    events([shot(FOE, K47.index, { ox: 10, oy: 1, ex: -20, ey: 1.5 })]);
    expect(sink.ids()).toContain('whiz');
    sink.clear();
    events([shot(FOE, K47.index, { hit: 3, target: 2 })]);
    expect(sink.ids()).toContain('shield.hit');
    expect(segmentDistance(0, 1, -5, 0, 5, 0)).toBeCloseTo(1);
  });
});

describe('hits and kills', () => {
  it('being hit pans toward whoever shot you', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME), player(FOE, { x: 8 })]));
    events([{ type: 'hit', attacker: FOE, target: ME, damage: 25, zone: HitZone.Torso, source: K47.index }]);
    const hit = sink.plays.find((p) => p.id === 'hit.taken')!;
    expect(hit.o.pan).toBeGreaterThan(0.5);
    // Hurt vocals vary and are intentionally omitted on some hits to avoid repetition.
  });

  it('your headshot dings, and the kill after it is a headshot kill', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME), player(FOE)]));
    events([{ type: 'hit', attacker: ME, target: FOE, damage: 60, zone: HitZone.Head, source: K47.index }]);
    events([{ type: 'death', victim: FOE, killer: ME, source: K47.index }]);
    expect(sink.ids()).toEqual(expect.arrayContaining(['hit.head', 'kill.head', 'voice.death']));
    sink.clear();
    events([{ type: 'hit', attacker: ME, target: 2, damage: 10, zone: HitZone.Torso, source: K47.index }]);
    events([{ type: 'death', victim: 2, killer: ME, source: K47.index }]);
    expect(sink.ids()).toEqual(expect.arrayContaining(['hit.marker', 'kill.confirm']));
  });
});

describe('threats and cues', () => {
  it('incoming fire: a near miss cracks past from its side and your own gun dips', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME), player(FOE)]));
    events([shot(FOE, K47.index, { ox: 10, oy: 1, ex: -20, ey: 1.5 })]);
    const whiz = sink.plays.find((p) => p.id === 'whiz')!;
    expect(whiz.o.x).toBeGreaterThan(0); // from the shooter's side
    expect(sink.ownDucks.length).toBeGreaterThan(0);
  });

  it('an enemy close by is lifted in the mix; a far one isn\'t', () => {
    const { sink, step } = setup();
    let x = 5;
    for (let i = 0; i < 40; i++) step(frame([player(ME), player(FOE, { x: (x += 0.08) })]));
    const near = sink.plays.filter((p) => p.id === 'step');
    expect(near.length).toBeGreaterThan(0);
    expect(near[0]!.o.gain).toBeGreaterThan(1);
    expect(near[0]!.o.priority).toBeGreaterThan(0);
  });

  it('your own sounds are marked as yours (they dip under threats)', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME)]));
    events([shot(ME, K47.index)]);
    expect(sink.plays.find((p) => p.id === 'rifle.fire')!.o.own).toBe(true);
  });
});

describe('map events', () => {
  it("the warning's last three seconds tick once each, in step with the HUD's countdown; nothing while it runs", () => {
    const { sink, step } = setup();
    const ev = (phase: 'warning' | 'active', secondsLeft: number, occurrence = 1) => ({ mapEvent: { id: 'surge', kind: 'gravitySurge', name: 'GRAVITY SURGE', description: '', phase, secondsLeft, progress: 0, color: 0, zones: [], occurrence, bulletRangeMul: 1 } });
    const ticks = () => sink.plays.filter((p) => p.id === 'ui.count').length;
    for (const left of [4.5, 3.9, 3.4, 2.9, 2.5, 2.1, 1.6, 0.9, 0.2]) step(frame([player(ME)], [], ev('warning', left)));
    expect(ticks()).toBe(3);
    for (const left of [14.9, 2.5, 1.2]) step(frame([player(ME)], [], ev('active', left)));
    expect(ticks()).toBe(3);
    // the next occurrence counts again
    step(frame([player(ME)], [], ev('warning', 2.2, 2)));
    expect(ticks()).toBe(4);
  });
});

describe('blasts', () => {
  it('each grenade type has its own blast, and big ones duck the rest', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME)]));
    events([
      { type: 'explosion', x: 2, y: 0, radius: 4, owner: FOE },
      { type: 'explosion', x: 2, y: 0, radius: 3, owner: FOE, grenade: 1 },
      { type: 'explosion', x: 2, y: 0, radius: 3, owner: FOE, grenade: 3 },
      { type: 'explosion', x: 2, y: 0, radius: 3, owner: FOE, grenade: 5 },
      { type: 'explosion', x: 2, y: 0, radius: 3, owner: FOE, grenade: PROJECTILE_TYPE_BASE },
    ]);
    expect(sink.ids().filter((i) => i !== 'blast.ring')).toEqual(['frag.explode', 'smoke.pop', 'flash.bang', 'emp.burst', 'rocket.explode']);
    // right on top of us: the ears ring and the world goes dull
    expect(sink.ids()).toContain('blast.ring');
    expect(sink.muffles.length).toBeGreaterThan(0);
    expect(sink.ducks.length).toBe(4); // smoke doesn't duck
    expect(Math.max(...sink.ducks)).toBeGreaterThan(0.5);
  });
});

describe('movement', () => {
  it('footsteps while walking, a landing after a fall, the jetpack start, loop and stop', () => {
    const { sink, step } = setup();
    let x = 0;
    for (let i = 0; i < 60; i++) step(frame([player(ME, { x: (x += 0.08) })])); // 4.8 m/s for 1 s
    expect(sink.ids().filter((i) => i === 'step').length).toBeGreaterThanOrEqual(3);
    sink.clear();
    // jet up, fall, land
    step(frame([player(ME, { x, jetting: true, grounded: false, y: 0.2 })]));
    expect(sink.ids()).toContain('jet.start');
    expect(sink.loops.get('jet:0')).toBe('jet.loop');
    // a short gap (feathering) doesn't stop it; a longer one does
    step(frame([player(ME, { x, jetting: false, grounded: false, y: 3 })]));
    expect(sink.ids()).not.toContain('jet.stop');
    for (let i = 0; i < 12; i++) step(frame([player(ME, { x, jetting: false, grounded: false, y: 3 })]));
    expect(sink.ids()).toContain('jet.stop');
    expect(sink.loops.has('jet:0')).toBe(false);
    step(frame([player(ME, { x, grounded: false, y: 2.7 })]));
    step(frame([player(ME, { x, grounded: true, y: 0 })])); // 2.7 m in a frame: a hard fall
    expect(sink.ids().some((i) => i === 'land' || i === 'land.hard')).toBe(true);
  });

  it('a dash, and a quick second one chains (higher)', () => {
    const { sink, step, events } = setup();
    step(frame([player(ME)]));
    events([{ type: 'dash', player: ME, x: 0, y: 0, dir: 0 }]);
    step(frame([player(ME)]));
    events([{ type: 'dash', player: ME, x: 0, y: 0, dir: 2 }]);
    expect(sink.ids()).toEqual(['dash', 'dash.chain']);
    expect(sink.plays[1]!.o.rate).toBeGreaterThan(1);
  });

  it('low fuel beeps while jetting on the last fifth of the tank', () => {
    const { sink, step } = setup();
    step(frame([player(ME, { jetting: true, grounded: false, fuel: 20 })]));
    expect(sink.ids()).toContain('jet.lowfuel');
  });
});

describe('the gun in hand', () => {
  it('a reload plays its steps over the reload time; a swap cuts what hasn\'t played and draws the new gun', () => {
    const { sink, step } = setup();
    const base = player(ME);
    step(frame([base]));
    const reloading = { ...base, weapons: [{ ...base.weapons[0]!, mag: 0, reloadTicks: 100 }, base.weapons[1]!] };
    step(frame([reloading]));
    const steps = sink.plays.filter((p) => p.id.startsWith('rifle.'));
    expect(steps.map((p) => p.id)).toEqual(['rifle.magout', 'rifle.magin', 'rifle.bolt']);
    expect(steps[2]!.o.delay).toBeCloseTo(K47.reload * 0.82);
    // swap to the Buzz half-way
    step(frame([{ ...reloading, active: 1, weapons: [{ ...reloading.weapons[0]!, reloadTicks: 0 }, base.weapons[1]!] }]));
    expect(steps[2]!.voice.stopped).toBe(true);
    expect(sink.ids()).toContain('smg.draw');
  });

  it('the dry click: the trigger on an empty gun with nothing to reload', () => {
    const { sink, step } = setup();
    const empty = player(ME, { weapons: [{ def: K47.index, mag: 0, reserve: 0, reloadTicks: 0 }, { def: NO_WEAPON, mag: 0, reserve: 0, reloadTicks: 0 }] });
    step(frame([empty]), { ...X, fireHeld: true });
    expect(sink.ids()).toContain('rifle.empty');
    for (let i = 0; i < 60; i++) step(frame([empty]), { ...X, fireHeld: true });
    expect(sink.ids().filter((id) => id === 'rifle.empty')).toHaveLength(1);
    step(frame([empty]), { ...X, fireHeld: false });
    step(frame([empty]), { ...X, fireHeld: true });
    expect(sink.ids().filter((id) => id === 'rifle.empty')).toHaveLength(2);
  });

  it('a melee swing whooshes once per swing (its ticks count up)', () => {
    const { sink, step } = setup();
    step(frame([player(ME)]));
    for (let t = 1; t <= 20; t++) step(frame([player(ME, { meleeTicks: t })]));
    step(frame([player(ME, { meleeTicks: 2 })])); // the next swing, the 0 between them not drawn
    expect(sink.ids().filter((i) => i === 'melee.swing')).toHaveLength(2);
  });

  it('a feathered jet key is one jetpack sound, not a stutter', () => {
    const { sink, step } = setup();
    for (let i = 0; i < 60; i++) step(frame([player(ME, { jetting: i % 3 === 0, grounded: false })]));
    expect(sink.ids().filter((i) => i === 'jet.start')).toHaveLength(1);
    expect(sink.ids()).not.toContain('jet.stop');
  });
});

describe('grenades and projectiles', () => {
  it('a bounce clanks; a mine arms, beeps and triggers', () => {
    const { sink, step } = setup();
    const g = (over: Partial<GrenadeView>): GrenadeView => ({ id: 3, x: 2, y: 1, fuse: 60, type: 0, state: 0, vx: 3, vy: -8, ...over });
    step(frame([player(ME)], [g({})]));
    step(frame([player(ME)], [g({ vy: 5 })]));
    expect(sink.ids()).toContain('grenade.bounce');
    const m = (state: number): GrenadeView => ({ id: 4, x: 1, y: 0, fuse: 0, type: 4, state, vx: 0, vy: 0 });
    step(frame([player(ME)], [m(0)]));
    step(frame([player(ME)], [m(1)]));
    step(frame([player(ME)], [m(2)]));
    step(frame([player(ME)], [m(3)]));
    expect(sink.ids()).toEqual(expect.arrayContaining(['mine.arm', 'mine.armed', 'mine.trigger']));
  });

  it('online: a rocket appearing by someone holding a Thumper is their launch; it hums in flight and stops', () => {
    const { sink, step } = setup();
    const foe = player(FOE, { x: 10, weapons: [{ def: THUMPER.index, mag: 1, reserve: 4, reloadTicks: 0 }] });
    step(frame([player(ME), foe]));
    const rocket: GrenadeView = { id: 7, x: 10.5, y: 1.2, fuse: 0, type: PROJECTILE_TYPE_BASE, state: 0, vx: 20, vy: 0 };
    step(frame([player(ME), foe], [rocket]));
    expect(sink.plays.find((p) => p.id === 'rocket.fire')!.o.x).toBeCloseTo(10.5);
    expect(sink.loops.get('proj:7')).toBe('rocket.flight');
    step(frame([player(ME), foe], []));
    expect(sink.stoppedLoops).toContain('proj:7');
  });

  it('online: our own predicted launch isn\'t heard twice when the server\'s rocket shows up', () => {
    const { sink, step, events } = setup();
    const me = player(ME, { weapons: [{ def: THUMPER.index, mag: 1, reserve: 4, reloadTicks: 0 }] });
    step(frame([me]));
    events([{ type: 'launch', owner: ME, grenade: 99, weapon: THUMPER.index }]);
    step(frame([me], [{ id: 2, x: 0.5, y: 1.2, fuse: 0, type: PROJECTILE_TYPE_BASE, state: 0, vx: 20, vy: 0 }]));
    expect(sink.ids().filter((i) => i === 'rocket.fire')).toHaveLength(1);
  });

  it('the flamethrower is a loop while it keeps firing, with a start and a stop', () => {
    const { sink, step, events } = setup();
    const dragon = weapons.find((w) => w.id === 'dragon')!;
    step(frame([player(ME)]));
    for (let i = 0; i < 5; i++) {
      events([{ type: 'launch', owner: ME, grenade: 20 + i, weapon: dragon.index }]);
      step(frame([player(ME)]), X, 0.15);
    }
    expect(sink.ids().filter((i) => i === 'flame.start')).toHaveLength(1);
    expect(sink.loops.get('fire:0')).toBe('flame.loop');
    step(frame([player(ME)]), X, 0.4);
    expect(sink.ids()).toContain('flame.stop');
  });
});

describe('the shell', () => {
  const match = (over: Partial<MatchView>): MatchView => ({ phase: MatchPhase.Waiting, number: 1, secondsLeft: 0, untimed: false, secondsElapsed: 0, killLimit: 10, timeLimit: 300, countdownTotal: 3, mapName: 'X', localId: ME, myScore: 0, leaderScore: 0, leaderName: '', ready: false, votes: 0, humans: 1, voted: false, results: null, ...over });
  const shell = (over: Partial<ShellState> = {}) => ({ notice: null, tuneNote: null, screen: { name: 'room', code: 'ABCDEF' }, match: null, lobby: null, ...over }) as Pick<ShellState, 'notice' | 'tuneNote' | 'screen' | 'match' | 'lobby'>;

  it('the countdown floods in with the sting, ticks 3-2-1, and GOes', () => {
    const a = shell({ match: match({}) });
    const b = shell({ match: match({ phase: MatchPhase.Countdown, secondsLeft: 3 }) });
    expect(shellCues(a, b)).toEqual(['ui.flood', 'sting.start', 'ui.count']);
    const c = shell({ match: match({ phase: MatchPhase.Countdown, secondsLeft: 2 }) });
    expect(shellCues(b, c)).toEqual(['ui.count']);
    expect(shellCues(c, c)).toEqual([]);
    const go = shell({ match: match({ phase: MatchPhase.InProgress }) });
    expect(shellCues(c, go)).toEqual(['ui.go']);
    const end = shell({ match: match({ phase: MatchPhase.Ending, myScore: 5, leaderScore: 5 }) });
    expect(shellCues(go, end)).toEqual(['ui.win']);
  });

  it('toasts and errors chime; the music plays in the menus and the lobby, not in a match', () => {
    expect(shellCues(shell(), shell({ notice: 'Link copied' }))).toEqual(['ui.toast']);
    expect(shellCues(shell(), shell({ screen: { name: 'error', alert: { kind: 'error', title: '', message: '', code: '', action: null }, retry: null } }))).toEqual(['ui.error']);
    expect(musicFor(false, shell({ screen: { name: 'home' } }))).toBe('menu');
    expect(musicFor(true, shell({ match: match({}) }))).toBe('lobby');
    expect(musicFor(true, shell({ match: match({ phase: MatchPhase.InProgress }) }))).toBe('off');
  });

  it('clicks know a switch from a back button, and skip disabled controls', () => {
    const el = (attrs: Record<string, string>, text = '') =>
      ({
        closest: (sel: string) => (sel.includes('button') ? fake : null),
        getAttribute: (k: string) => attrs[k] ?? null,
        matches: (sel: string) => (sel.includes(':disabled') ? attrs.disabled === '1' : sel.includes('switch') ? attrs.role === 'switch' : false),
        textContent: text,
      }) as unknown as Element;
    let fake = el({ role: 'switch' });
    expect(clickSound(fake)).toBe('ui.toggle');
    fake = el({}, 'Back');
    expect(clickSound(fake)).toBe('ui.back');
    fake = el({}, 'Play');
    expect(clickSound(fake)).toBe('ui.click');
    fake = el({ disabled: '1' }, 'Play');
    expect(clickSound(fake)).toBeNull();
  });
});
