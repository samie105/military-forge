/**
 * The bots' nav graphs never build on a tick. QA (23 Oct): a bot added under a tuning the server
 * hadn't seen built its graph inside Room.tick, 90–330 ms, and every room on the box froze with it.
 * A room now queues the build for the time between ticks (the tick loop lends it, loop.ts), and its
 * new bot comes in on the map's newest graph meanwhile, or waits for one.
 */
import { latestNavGraph, navBuildsQueued, navKey, readyNavGraph, warmNavGraphs, workNavBuilds, type BotBrain } from '@military-forge/bots';
import { createTuning, maps } from '@military-forge/content';
import { CmdKind, encodeCmd, encodeHello } from '@military-forge/protocol';
import type { PlayerState } from '@military-forge/sim';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setAdminValues } from '../src/admin';
import { IDLE_MAX_MS } from '../src/loop';
import { Room, type ClientConn } from '../src/room';
import { CUSTOM_ROOM_RULES } from '../src/rooms';

/**
 * No tick may take this much CPU. A build is 90–330 ms of it; a tick here is about 1 ms (QA's bench:
 * 1.1 ms max with 8 humans). CPU time, the thread's own: a busy machine (other test files, other
 * work) stretches the wall clock, not this.
 */
const TICK_BUDGET_MS = 40;

const conn: ClientConn = { send() {}, close() {}, bufferedAmount: () => 0 };
const join = (room: Room, name: string) => {
  const client = room.connect(conn);
  room.receive(client, encodeHello(name, ''));
  return client;
};
const graphOf = (p: PlayerState) => (p.brain as BotBrain).graph;

/** One tick, and the CPU it took (ms). */
function timedTick(room: Room): number {
  const c0 = process.threadCpuUsage();
  room.tick();
  const c = process.threadCpuUsage(c0);
  return (c.user + c.system) / 1000;
}

/**
 * A server's loop, without the waiting: a tick, then the spare time between ticks lent to the
 * builds (IDLE_MAX_MS, as loop.ts does), until `until()` or `max` ticks. Counts the builds a tick
 * finished (it must never: that's the stall) and the most CPU a tick took.
 */
function serve(room: Room, max: number, until: () => boolean = () => false) {
  let maxTickMs = 0;
  let builtOnTicks = 0;
  let ticks = 0;
  while (ticks < max && !until()) {
    const queued = navBuildsQueued();
    maxTickMs = Math.max(maxTickMs, timedTick(room));
    if (navBuildsQueued() < queued) builtOnTicks++;
    const end = performance.now() + IDLE_MAX_MS;
    workNavBuilds(() => performance.now() >= end);
    ticks++;
  }
  return { ticks, maxTickMs, builtOnTicks };
}

beforeAll(() => warmNavGraphs([maps['movement-test']!]), 30_000);
afterEach(() => setAdminValues({}));

describe('nav graphs build between ticks, never on one', () => {
  it('a new movement tuning and a bot to add: every tick stays in budget; the bot comes on the old graph, the new one builds between ticks', () => {
    const room = new Room({ dummies: false, dev: false, seed: 5, fillBots: { target: 3, level: 'normal' } });
    const map = room.game.map;
    join(room, 'Ade');
    room.tick();
    expect(room.bots).toHaveLength(2);
    const old = graphOf(room.bots[0]!);
    expect(old).toBe(readyNavGraph(map, createTuning()));

    // the admin page: a jet-thrust nudge (a graph the server hasn't got) and a bot more
    setAdminValues({ 'tuning.jetThrust': 31.5, 'bots.count': 4 });
    expect(readyNavGraph(map, room.game.tuning)).toBeNull();
    expect(navBuildsQueued()).toBe(1); // queued as the tuning came in
    expect(timedTick(room)).toBeLessThan(TICK_BUDGET_MS);
    expect(readyNavGraph(map, room.game.tuning)).toBeNull(); // not built on the tick
    expect(room.bots).toHaveLength(3);
    expect(graphOf(room.bots[2]!)).toBe(old); // in at once, on the map's newest graph

    // the server's spare time builds it, in slices; no tick waits for it
    const run = serve(room, 600, () => navBuildsQueued() === 0);
    expect(navBuildsQueued()).toBe(0);
    expect(run.ticks).toBeGreaterThan(5); // it took many gaps between ticks, not one
    expect(run.builtOnTicks).toBe(0);
    expect(run.maxTickMs).toBeLessThan(TICK_BUDGET_MS);
    const fresh = readyNavGraph(map, room.game.tuning)!;
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(old);

    // the next bot gets the new graph
    setAdminValues({ 'tuning.jetThrust': 31.5, 'bots.count': 5 });
    room.tick();
    expect(room.bots).toHaveLength(4);
    expect(graphOf(room.bots[3]!)).toBe(fresh);
  }, 30_000);

  it('a change that is not movement (grenade throw, blasts, health) keeps the graph: nothing builds', () => {
    const room = new Room({ dummies: false, dev: false, seed: 6, fillBots: { target: 2, level: 'normal' } });
    join(room, 'Ade');
    room.tick();
    const graph = graphOf(room.bots[0]!);
    setAdminValues({ 'tuning.grenadeThrowScale': 1.3, 'tuning.blastImpulseScale': 1.8, 'tuning.healthRegen': 12, 'tuning.respawnDelay': 1, 'bots.count': 3 });
    expect(navKey(room.game.tuning)).toBe(navKey(createTuning()));
    expect(navBuildsQueued()).toBe(0);
    room.tick();
    expect(room.bots).toHaveLength(2);
    expect(graphOf(room.bots[1]!)).toBe(graph);
  });

  it("a host's switch to a map with no graph yet: the bots wait for it, built between ticks, and come back on it", () => {
    const room = new Room({ dummies: false, dev: false, seed: 7, match: CUSTOM_ROOM_RULES, fillBots: { target: 4, level: 'normal' } });
    const ade = join(room, 'Ade');
    room.tick();
    expect(room.bots).toHaveLength(3);
    const lunar = maps['lunar-outpost']!;
    expect(latestNavGraph(lunar)).toBeNull();

    room.receive(ade, encodeCmd(CmdKind.MatchSettings, JSON.stringify({ mapId: 'lunar-outpost' })));
    expect(room.game.map).toBe(lunar);
    expect(room.bots).toHaveLength(0); // they knew the old map: gone, to come back on the new one
    const run = serve(room, 600, () => room.bots.length === 3);
    expect(room.bots).toHaveLength(3);
    expect(run.ticks).toBeGreaterThan(5);
    expect(run.builtOnTicks).toBe(0);
    expect(run.maxTickMs).toBeLessThan(TICK_BUDGET_MS);
    const graph = readyNavGraph(lunar, room.game.tuning)!;
    expect(graph.map).toBe(lunar);
    for (const b of room.bots) expect(graphOf(b)).toBe(graph);
  }, 30_000);
});
