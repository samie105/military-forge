/** The engine: bus volumes, voice limits, cooldowns, positional sound, ducking, the hidden tab, loops. */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUDIO } from '../shell/store';
import { AudioEngine, MAX_PENDING, PAN_SPAN, distanceGain, volumeToGain } from './engine';
import { FakeContext, type FakeGain, type FakeNode, type FakeParam, type FakeSource } from './fakeContext.test-util';
import { volumesFrom } from './runtime';
import { SOUNDS } from './sounds';

/** An engine on a fake context, rendering tiny buffers (the bank has its own tests). */
function setup(maxVoices = 40) {
  const ctx = new FakeContext();
  let r = 0;
  const engine = new AudioEngine(ctx.asAudioContext(), {
    maxVoices,
    render: () => [new Float32Array(64000).fill(0.1)], // 2 s: nothing ends on its own mid-test
    // a fixed sequence: variant picks and pitch jitter are repeatable
    random: () => (r = (r + 0.37) % 1),
  });
  return { ctx, engine };
}

const gainOf = (n: unknown) => (n as FakeGain).gain.value;

describe('buses', () => {
  it('applies Settings → Audio to the five buses, squared, with mutes at zero', () => {
    const { engine } = setup();
    engine.setVolumes(volumesFrom({ ...DEFAULT_AUDIO, master: 0.5, effects: 1, music: 0.4, ui: 0.7, voice: 0.2, voiceMuted: true }));
    expect(gainOf(engine.buses.master)).toBeCloseTo(0.25);
    expect(gainOf(engine.buses.sfx)).toBeCloseTo(1);
    expect(gainOf(engine.buses.music)).toBeCloseTo(0.16);
    expect(gainOf(engine.buses.ui)).toBeCloseTo(0.49);
    expect(gainOf(engine.buses.voice)).toBe(0);
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(2)).toBe(1);
  });

  it('routes each sound to its bus: world sounds through the duck, blasts past it, the interface straight', () => {
    const { ctx, engine } = setup();
    engine.play('rifle.fire');
    engine.play('frag.explode');
    engine.play('ui.click');
    const [gun, blast, click] = ctx.started;
    // source → gain → panner → bus input …
    const end = (s: FakeSource) => ctx.pathOf(s);
    expect(end(gun!)).toEqual(['source', 'gain', 'panner', 'gain', 'filter', 'gain', 'gain', 'compressor', 'gain', 'destination']);
    expect(end(blast!)).toEqual(['source', 'gain', 'panner', 'gain', 'gain', 'gain', 'compressor', 'gain', 'destination']);
    expect(end(click!)).toEqual(['source', 'gain', 'panner', 'gain', 'gain', 'compressor', 'gain', 'destination']);
  });

  it('every sound names a bus the engine has', () => {
    for (const def of Object.values(SOUNDS)) expect(['sfx', 'big', 'ui', 'voice', 'music']).toContain(def.bus);
  });
});

describe('voice limits', () => {
  it('a sound never has more than its own cap playing: the oldest is cut', () => {
    const { ctx, engine } = setup();
    const cap = SOUNDS['smg.fire'].maxVoices!;
    for (let i = 0; i < 20; i++) {
      ctx.currentTime += 0.05; // past the cooldown each time
      engine.play('smg.fire', { x: 0, y: 0 });
    }
    expect(engine.activeVoices('smg.fire')).toBe(cap);
    // the cut ones were stopped
    expect(ctx.started.filter((s) => s.stoppedAt !== null).length).toBe(20 - cap);
    expect(engine.counters.stolen).toBe(20 - cap);
  });

  it('eight players firing at once stay within the engine cap; the least important go first', () => {
    const { ctx, engine } = setup(12);
    engine.listener = { x: 0, y: 0 };
    // footsteps all over (low priority), then a firefight (higher)
    for (let i = 0; i < 6; i++) {
      ctx.currentTime += 0.06;
      engine.play('step', { x: i, y: 0 });
    }
    for (let shooter = 0; shooter < 8; shooter++)
      for (let k = 0; k < 3; k++) {
        ctx.currentTime += 0.016;
        engine.play(k % 2 ? 'rifle.fire' : 'smg.fire', { x: shooter * 3 - 12, y: 0 });
      }
    expect(engine.activeVoices()).toBeLessThanOrEqual(12);
    expect(engine.activeVoices('step')).toBe(0);
    // and a low-priority sound can't push out important ones when the engine is full
    expect(engine.play('step', { x: 3, y: 0 })).toBeNull();
    expect(engine.counters.refused).toBeGreaterThan(0);
  });

  it('the same sound can\'t restart within its cooldown (a shotgun\'s pellets are one bang)', () => {
    const { ctx, engine } = setup();
    expect(engine.play('shotgun.fire')).not.toBeNull();
    expect(engine.play('shotgun.fire')).toBeNull();
    ctx.currentTime += SOUNDS['shotgun.fire'].cooldown! + 0.001;
    expect(engine.play('shotgun.fire')).not.toBeNull();
    expect(engine.counters.cooled).toBe(1);
  });

  it('many of the same at once each play quieter, so a crowd doesn\'t clip', () => {
    const { ctx, engine } = setup();
    const gains: number[] = [];
    for (let i = 0; i < 5; i++) {
      ctx.currentTime += 0.05;
      engine.play('smg.fire');
      gains.push(gainOf(ctx.started.at(-1)!.outputs[0]));
    }
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeLessThan(gains[i - 1]!);
  });

  it('a stopped scheduled voice frees its slot', () => {
    const { engine } = setup();
    const v = engine.play('rifle.magin', { delay: 1 })!;
    expect(engine.activeVoices('rifle.magin')).toBe(1);
    v.stop();
    expect(engine.activeVoices('rifle.magin')).toBe(0);
  });
});

describe('positional sound', () => {
  it('pans by where a sound is across the screen and fades with distance', () => {
    const { ctx, engine } = setup();
    engine.listener = { x: 0, y: 0 };
    engine.play('rifle.fire', { x: PAN_SPAN, y: 0 });
    const pan = ctx.nodes.filter((n) => n.kind === 'panner').at(-1) as FakeNode & { pan: FakeParam };
    expect(pan.pan.value).toBeCloseTo(0.85);
    ctx.currentTime += 1;
    engine.play('rifle.fire', { x: -40, y: 0 });
    const left = ctx.nodes.filter((n) => n.kind === 'panner').at(-1) as FakeNode & { pan: FakeParam };
    expect(left.pan.value).toBeCloseTo(-0.85);
    // far away: quieter and darker (a low-pass on it)
    const filter = ctx.nodes.filter((n) => n.kind === 'filter').at(-1) as FakeNode & { frequency: FakeParam };
    expect(filter.frequency.value).toBeLessThan(5000);
    expect(distanceGain(3, 50)).toBe(1);
    expect(distanceGain(30, 50)).toBeLessThan(0.4);
    expect(distanceGain(60, 50)).toBe(0);
  });

  it('a world sound beyond its range isn\'t played at all', () => {
    const { engine } = setup();
    engine.listener = { x: 0, y: 0 };
    expect(engine.play('step', { x: SOUNDS.step.range! + 1, y: 0 })).toBeNull();
    expect(engine.play('step', { x: 2, y: 0 })).not.toBeNull();
  });
});

describe('ducking, softening and the hidden tab', () => {
  it('a blast ducks the world and the music, not itself; it comes back', () => {
    const { ctx, engine } = setup();
    engine.duck(0.8, 0.2);
    // the duck nodes are the first gains made after the five buses
    const params = ctx.nodes.filter((n) => n.kind === 'gain').slice(5, 8) as FakeGain[];
    for (const p of params) {
      const down = p.gain.events.find((e) => e.kind === 'target')!;
      expect(down.value).toBeLessThan(1);
      expect(p.gain.events.at(-1)!.value).toBe(1); // and back up after the hold
    }
  });

  it('"Soften loud bursts" quietens blasts and hardens the limiter', () => {
    const { ctx, engine } = setup();
    engine.play('frag.explode');
    const loud = gainOf(ctx.started.at(-1)!.outputs[0]);
    engine.setSoft(true);
    ctx.currentTime += 1;
    engine.play('frag.explode');
    const soft = gainOf(ctx.started.at(-1)!.outputs[0]);
    expect(soft).toBeLessThan(loud * 0.6);
    expect((engine.limiter as unknown as { threshold: FakeParam }).threshold.value).toBeLessThan(-15);
  });

  it('mutes and suspends when the tab is hidden, and resumes when it\'s back', () => {
    vi.useFakeTimers();
    const { ctx, engine } = setup();
    engine.setHidden(true);
    vi.advanceTimersByTime(300);
    expect(ctx.suspends).toBe(1);
    expect(engine.play('ui.click')).toBeNull(); // nothing plays while suspended
    engine.setHidden(false);
    expect(ctx.resumes).toBe(1);
    vi.useRealTimers();
  });
});

describe('loops', () => {
  it('start once, update in place, and stop by key', () => {
    const { ctx, engine } = setup();
    engine.listener = { x: 0, y: 0 };
    engine.loop('jet:1', 'jet.loop', { x: 2, y: 0 });
    engine.loop('jet:1', 'jet.loop', { x: 5, y: 0 });
    expect(ctx.started.filter((s) => s.loop).length).toBe(1);
    expect(engine.loopKeys()).toEqual(['jet:1']);
    engine.stopLoop('jet:1');
    expect(engine.loopKeys()).toEqual([]);
    expect(ctx.started[0]!.stoppedAt).not.toBeNull();
  });
});

describe('spatial: distance, occlusion, headphones, threats', () => {
  it('a far shot arrives late (the speed of sound, capped)', () => {
    const { ctx, engine } = setup();
    engine.listener = { x: 0, y: 0 };
    engine.play('rifle.fire', { x: 34.3, y: 0 });
    const near = ctx.started.find((s) => s.startedAt !== null)!;
    expect(near.startedAt).toBeCloseTo(0.1, 2);
    ctx.currentTime = 5;
    engine.play('sniper.fire', { x: 80, y: 0 });
    expect(Math.max(...ctx.started.map((s) => s.startedAt!)) - 5).toBeCloseTo(0.15, 2);
  });

  it('far away, a gun layers in its distant report and a blast its rumble', () => {
    const { engine } = setup();
    engine.listener = { x: 0, y: 0 };
    engine.play('rifle.fire', { x: 10, y: 0 });
    expect(engine.activeVoices('distant.gun')).toBe(0);
    engine.play('rifle.fire', { x: 0, y: 60 });
    expect(engine.activeVoices('distant.gun')).toBe(1);
    engine.play('frag.explode', { x: 90, y: 0 });
    expect(engine.activeVoices('distant.boom')).toBe(1);
  });

  it('behind a wall: quieter and muffled', () => {
    const { ctx, engine } = setup();
    engine.listener = { x: 0, y: 0 };
    engine.play('step', { x: 4, y: 0 });
    const open = gainOf(ctx.started.at(-1)!.outputs[0]);
    engine.occluder = () => 1;
    ctx.currentTime += 1;
    engine.play('step', { x: 4, y: 0 });
    const src = ctx.started.at(-1)!;
    expect(gainOf(src.outputs[0])).toBeLessThan(open * 0.65);
    const filter = src.outputs[0]!.outputs[0] as FakeNode & { kind: string; frequency: FakeParam };
    expect(filter.kind).toBe('filter');
    expect(filter.frequency.value).toBeLessThanOrEqual(1100);
  });

  it('headphones place a sound in 3D (HRTF); speakers pan in stereo', () => {
    const { ctx, engine } = setup();
    engine.listener = { x: 0, y: 0 };
    engine.setHrtf(true);
    engine.play('step', { x: -8, y: 4 });
    const hrtf = ctx.nodes.filter((n) => n.kind === 'hrtf').at(-1) as FakeNode & Record<'positionX' | 'positionY' | 'panningModel', FakeParam & string>;
    expect(hrtf).toBeDefined();
    expect((hrtf as unknown as { panningModel: string }).panningModel).toBe('HRTF');
    expect(hrtf.positionX.value).toBeLessThan(0); // left
    expect(hrtf.positionY.value).toBeGreaterThan(0); // above
    engine.setHrtf(false);
    ctx.currentTime += 1;
    engine.play('step', { x: -8, y: 4 });
    expect(ctx.pathOf(ctx.started.at(-1)!)).toContain('panner');
  });

  it('your own gun dips under an incoming threat, and comes back', () => {
    const { ctx, engine } = setup();
    engine.play('rifle.fire', { own: true });
    const own = ctx.started.at(-1)!;
    // source → gain → panner → own gain
    const ownGain = own.outputs[0]!.outputs[0]!.outputs[0] as FakeGain;
    engine.duckOwn(0.4, 0.2);
    const down = ownGain.gain.events.find((e) => e.kind === 'target')!;
    expect(down.value).toBeCloseTo(0.6);
    expect(ownGain.gain.events.at(-1)!.value).toBe(1);
  });

  it('under cover the space turns from the open street to close walls', () => {
    const { ctx, engine } = setup();
    engine.setEnclosure(1);
    const conv = ctx.nodes.filter((n) => n.kind === 'convolver');
    expect(conv).toHaveLength(2);
    const [openRet, coverRet] = conv.map((c) => c.outputs[0] as FakeGain);
    expect(coverRet!.gain.value).toBeGreaterThan(openRet!.gain.value);
  });
});


describe('before the context runs (the first tap, a resume, a stopped output)', () => {
  /** an engine whose context hasn't started yet, with a wall clock the test moves */
  function waiting() {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    let wall = 0;
    const engine = new AudioEngine(ctx.asAudioContext(), { render: () => [new Float32Array(64000).fill(0.1)], random: () => 0.5, clock: () => wall });
    return { ctx, engine, later: (ms: number) => (wall += ms) };
  }
  /** the sounds started (not the convolvers' or the unlock's one-sample buffers) */
  const ids = (ctx: FakeContext) => ctx.started.filter((s) => s.buffer && s.buffer.length > 1);

  it('a sound asked for while it starts waits, and plays the moment it runs', () => {
    const { ctx, engine, later } = waiting();
    const v = engine.play('rifle.magout');
    expect(v).not.toBeNull();
    expect(ids(ctx)).toHaveLength(0);
    expect(engine.waiting).toBe(1);
    later(80);
    ctx.state = 'running';
    engine.wake();
    expect(ids(ctx)).toHaveLength(1);
    expect(engine.waiting).toBe(0);
  });

  it('a delayed step keeps its place: the time it waited comes off its delay', () => {
    const { ctx, engine, later } = waiting();
    engine.play('rifle.magin', { delay: 1.1 });
    later(300);
    ctx.state = 'running';
    engine.wake();
    expect(ids(ctx)[0]!.startedAt).toBeCloseTo(0.8, 3);
  });

  it('too late is dropped: no burst of stale shots when it finally runs', () => {
    const { ctx, engine, later } = waiting();
    engine.play('rifle.fire');
    engine.play('rifle.bolt', { delay: 2 });
    later(1000);
    ctx.state = 'running';
    engine.wake();
    // the shot was due a second ago; the bolt is still a second ahead
    expect(ids(ctx)).toHaveLength(1);
    expect(engine.counters.late).toBe(1);
  });

  it('stopped before it played (a reload cut short by a swap): it never plays', () => {
    const { ctx, engine } = waiting();
    const v = engine.play('rifle.bolt', { delay: 1 })!;
    v.stop();
    ctx.state = 'running';
    engine.wake();
    expect(ids(ctx)).toHaveLength(0);
  });

  it('the next play after it runs flushes what waited, even if nobody called wake', () => {
    const { ctx, engine } = waiting();
    engine.play('pistol.magout');
    ctx.state = 'running';
    engine.play('ui.click');
    expect(ids(ctx)).toHaveLength(2);
  });

  it('a hidden tab holds nothing; going hidden forgets what waited', () => {
    const { ctx, engine } = waiting();
    engine.play('rifle.fire');
    engine.setHidden(true);
    expect(engine.waiting).toBe(0);
    expect(engine.play('rifle.fire')).toBeNull();
    engine.setHidden(false);
    ctx.state = 'running';
    engine.wake();
    expect(ids(ctx)).toHaveLength(0);
  });

  it('a stalled output (running, clock stopped) holds sounds rather than scheduling into a clock that doesn\'t move', () => {
    const { ctx, engine } = waiting();
    ctx.state = 'running';
    engine.setStalled(true);
    expect(engine.running).toBe(false);
    engine.play('smg.fire');
    expect(ids(ctx)).toHaveLength(0);
    engine.setStalled(false);
    expect(ids(ctx)).toHaveLength(1);
  });

  it('loops aren\'t held (the director asks for them every frame); a closed context holds nothing', () => {
    const { ctx, engine } = waiting();
    engine.loop('jet:0', 'jet.loop');
    expect(engine.waiting).toBe(0);
    ctx.state = 'closed';
    expect(engine.play('rifle.fire')).toBeNull();
  });

  it('holds at most MAX_PENDING (the oldest go)', () => {
    const { engine } = waiting();
    for (let i = 0; i < MAX_PENDING + 5; i++) engine.play('step');
    expect(engine.waiting).toBe(MAX_PENDING);
  });
});
