/**
 * What rooms need from the bots (bots-interfaces.md, review L3 and L6): bots that come and go
 * mid-game are recorded with their seed serial and their join and leave ticks, so a replay puts
 * each back as it was; nav graphs are kept for several tunings per map (keyed on the movement
 * fields), can be built up front, and build in small steps for a server to run between ticks.
 */
import { createTuning, getMap } from '@military-forge/content';
import { CollisionWorld, Game, hashGame, runReplay, type ReplayFile } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import {
  addBot,
  addBots,
  botReplaySetup,
  botSpecs,
  buildNavGraph,
  latestNavGraph,
  navBuildsQueued,
  navGraphFor,
  navGraphSteps,
  navKey,
  readyNavGraph,
  removeBot,
  requestNavGraph,
  warmNavGraphs,
  workNavBuilds,
  type NavGraph,
} from '../src';
import { BotBrain } from '../src/brain';

describe('bots that come and go (rooms)', () => {
  it('a game whose bots join and leave part-way replays exactly from what botSpecs records', () => {
    const game = new Game({ mapId: 'movement-test', seed: 5, dummies: false });
    const bots = addBots(game, 3, 'normal');
    const hashes: number[] = [];
    for (let t = 0; t < 900; t++) {
      // as a room does it, before the tick's step: leaves first, then joins
      if (t === 200) removeBot(game, bots[1]!); // a human took its place
      if (t === 400) addBot(game, { level: 'hard' });
      if (t === 600) {
        removeBot(game, bots[0]!);
        addBot(game);
      }
      game.step([]);
      hashes.push(hashGame(game));
    }
    const specs = botSpecs(game);
    expect(specs.map((b) => [b.name, b.serial, b.joinTick, b.leaveTick])).toEqual([
      ['[BOT] Badger', 0, 0, 600],
      ['[BOT] Kestrel', 1, 0, 200],
      ['[BOT] Mantis', 2, 0, undefined],
      ['[BOT] Jackal', 3, 400, undefined],
      ['[BOT] Osprey', 4, 600, undefined],
    ]);
    const replay: ReplayFile = { version: 1, name: 'bots-come-and-go', map: 'movement-test', seed: 5, dummies: false, ticks: 900, players: [], bots: specs };
    const replayed = runReplay(JSON.parse(JSON.stringify(replay)) as ReplayFile, undefined, botReplaySetup(replay)).hashes;
    expect(replayed.findIndex((h, i) => h !== hashes[i])).toBe(-1);
  });

  it('a bot put back with its serial gets that serial’s seed and name', () => {
    const game = new Game({ mapId: 'movement-test', seed: 5, dummies: false });
    const p = addBot(game, { serial: 7 });
    expect(p.name).toBe('[BOT] Gecko');
    expect((p.brain as BotBrain).serial).toBe(7);
    expect((addBot(game).brain as BotBrain).serial).toBe(8); // the next one carries on from there
  });
});

describe('nav graphs for rooms', () => {
  it('keeps several tunings per map (rooms on their own tunings don’t rebuild in turn), and builds them up front', () => {
    const map = getMap('lunar-outpost');
    warmNavGraphs([map]);
    const plain = new Game({ map, dummies: false });
    const built = navGraphFor(plain);
    expect(navGraphFor(new Game({ map, dummies: false }))).toBe(built); // warmed: no build on the first bot
    const floaty = new Game({ map, dummies: false, tuning: { jetThrust: 30 } });
    const other = navGraphFor(floaty);
    expect(other).not.toBe(built);
    expect(navGraphFor(plain)).toBe(built);
    expect(navGraphFor(floaty)).toBe(other);
  });

  /** what a graph is, to compare two builds */
  const shape = (g: NavGraph) => JSON.stringify([g.nodes, g.links]);

  it('a graph depends on the movement tuning only: health, respawns, the aim origin, grenades and blasts change nothing', () => {
    const map = getMap('lunar-outpost');
    const world = new CollisionWorld(map);
    const plain = buildNavGraph(map, world, createTuning());
    // every field the key leaves out, far from its default
    const other = createTuning({ healthMax: 40, healthRegen: 90, healthRegenDelay: 0.1, respawnDelay: 9, shoulderStand: 0.3, shoulderCrouch: 0.2, shoulderForward: 0.9, grenadeThrowScale: 2.5, blastImpulseScale: 3, dashFlickFull: 1 });
    expect(navKey(other)).toBe(navKey(createTuning()));
    expect(shape(buildNavGraph(map, world, other))).toBe(shape(plain));
    // and a movement field is in the key
    expect(navKey(createTuning({ jetThrust: 37.5 }))).not.toBe(navKey(createTuning()));
  }, 30_000);

  it("a build in steps (a server's, between ticks) makes the same graph as one all at once", () => {
    const map = getMap('mechanics-test');
    const world = new CollisionWorld(map);
    const t = createTuning();
    const steps = navGraphSteps(map, world, t);
    let n = 0;
    let r = steps.next();
    while (!r.done) {
      n++;
      r = steps.next();
    }
    expect(n).toBeGreaterThan(500); // small steps
    expect(shape(r.value)).toBe(shape(buildNavGraph(map, world, t)));
  }, 30_000);

  it('requests queue builds (nothing built on the call); the newest asked for is built first; the queue is bounded', () => {
    const map = getMap('storm-front');
    const world = new CollisionWorld(map);
    const a = createTuning({ gravity: 19 });
    const b = createTuning({ gravity: 21 });
    expect(requestNavGraph(map, world, a)).toBeNull();
    expect(requestNavGraph(map, world, b)).toBeNull();
    expect(requestNavGraph(map, world, b)).toBeNull(); // asked again: still one build
    expect(navBuildsQueued()).toBe(2);
    expect(latestNavGraph(map)).toBeNull();
    // a step at a time until b is done: a is untouched meanwhile
    let steps = 0;
    while (!readyNavGraph(map, b)) {
      workNavBuilds(() => true);
      steps++;
    }
    expect(steps).toBeGreaterThan(100);
    expect(readyNavGraph(map, a)).toBeNull();
    expect(latestNavGraph(map)).toBe(readyNavGraph(map, b));
    // navGraphFor finishes a queued build instead of starting another
    const game = new Game({ map, dummies: false, tuning: { gravity: 19 } });
    const ga = navGraphFor(game);
    expect(navBuildsQueued()).toBe(0);
    expect(readyNavGraph(map, a)).toBe(ga);
  }, 30_000);

  it('at most 8 builds queue: the least recently asked for goes (a room that still wants it asks again)', () => {
    const map = getMap('lunar-outpost');
    const world = new CollisionWorld(map);
    for (let i = 0; i < 9; i++) requestNavGraph(map, world, createTuning({ gravity: 10 + i }));
    expect(navBuildsQueued()).toBe(8);
    const done: number[] = [];
    while (navBuildsQueued()) {
      const before = navBuildsQueued();
      workNavBuilds(() => true);
      if (navBuildsQueued() < before) done.push([18, 17, 16, 15, 14, 13, 12, 11, 10].find((g) => !done.includes(g) && readyNavGraph(map, createTuning({ gravity: g })))!);
    }
    expect(done).toEqual([18, 17, 16, 15, 14, 13, 12, 11]); // newest first; gravity 10 was dropped
  }, 30_000);
});
