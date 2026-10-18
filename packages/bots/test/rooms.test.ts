/**
 * What rooms need from the bots (bots-interfaces.md, review L3 and L6): bots that come and go
 * mid-game are recorded with their seed serial and their join and leave ticks, so a replay puts
 * each back as it was; nav graphs are kept for several tunings per map and can be built up front.
 */
import { getMap } from '@military-forge/content';
import { Game, hashGame, runReplay, type ReplayFile } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { addBot, addBots, botReplaySetup, botSpecs, navGraphFor, removeBot, warmNavGraphs } from '../src';
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
});
