/**
 * Generates the scripted golden-replay scenarios (docs/02 §19.3) into test/replays/.
 * Run: pnpm replays:generate   (then pnpm golden:update to record their hashes)
 *
 * Recorded playtests (from the web client's "Record" button) can be dropped into the same folder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREACHER, K47, MACHETE, WIDOW } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import {
  Btn,
  Match,
  MatchPhase,
  applyMatchCommand,
  createReplayGame,
  encodeRuns,
  type Input,
  type MatchCommand,
  type MatchCommandKind,
  type MatchRules,
  type ReplayFile,
} from '../src';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'replays');

/** [ticks, buttons, aimDegrees] */
type Step = [number, number, number?];

const R = Btn.Right;
const J = Btn.Jet;
const D = Btn.Down;
const F = Btn.Fire;
const M = Btn.Melee;
const Q = Btn.Swap;

function script(steps: Step[]): Input[] {
  const out: Input[] = [];
  for (const [n, buttons, aimDeg = 0] of steps) {
    for (let i = 0; i < n; i++) out.push({ buttons, aim: angleToU16((aimDeg * Math.PI) / 180), weaponSelect: 0, throwStrength: 7 });
  }
  return out;
}

function scenario(name: string, start: { x: number; y: number }, steps: Step[], loadout?: [number, number]): ReplayFile {
  const inputs = script(steps);
  return {
    version: 1,
    name,
    map: 'movement-test',
    seed: 1234,
    dummies: true,
    ticks: inputs.length,
    starts: [start],
    ...(loadout ? { loadouts: [loadout] } : {}),
    players: [encodeRuns(inputs)],
  };
}

const scenarios: ReplayFile[] = [
  scenario('ledges', { x: 2, y: 0 }, [
    [30, 0],
    [90, R], // walk over the 0.2 m step, into the 0.5 m ledge
    [12, R | J],
    [60, R],
    [20, R | J],
    [60, R],
    [36, R | J], // 2 m
    [60, R],
    [66, R | J], // 4 m (a full held burst; before the corner-teleport fix 45 ticks sufficed)
    [90, R],
    [60, 0],
  ]),
  scenario('slopes', { x: 33, y: 0 }, [
    [240, R], // over the 30° and 45° hills
    [60, R], // up the 50° hill
    [40, R],
    [60, R], // 55°: blocked
    [40, R | J],
    [120, R],
    [60, 0],
  ]),
  scenario('wedge', { x: 81.4, y: 3 }, [
    [120, 0],
    [60, R], // can't walk out of a 60° wedge
    [30, R | J],
    [90, R],
  ]),
  scenario('corridors', { x: 85, y: 0 }, [
    [60, R], // bonk into the crouch corridor standing
    [150, R | D], // crouch through
    [40, R],
    [90, R], // 2 m corridor
    [25, J], // jet into the overhang corner
    [30, J | R],
    [60, 0],
  ]),
  scenario('oneway', { x: 122, y: 0 }, [
    [20, R],
    [70, J], // through the platforms
    [90, 0],
    [20, D], // drop through
    [60, 0],
    [30, J | R],
    [90, R],
    [60, 0],
  ]),
  scenario('range-combat', { x: 150, y: 0 }, [
    [30, R],
    [1, F, 0],
    [40, 0, 0],
    [1, F, 2],
    [40, 0, 2],
    [1, F, -2],
    [40, 0],
    [1, Btn.Swap],
    [20, 0],
    [90, F, 1], // Buzz burst at the dummies
    [1, Btn.Dual],
    [30, 0],
    [60, F, 4], // dual-wield
    [1, Btn.Grenade, 20],
    [30, 0],
    [1, Btn.Grenade, 35],
    [120, 0],
    [1, Btn.Reload],
    [150, 0],
    [40, J | F, -10], // air spray
    [120, 0],
  ]),
  // Arsenal: between the Jetter (x 163, hops) and the Idle dummy (x 165.5); the Croucher is at 168.
  scenario(
    'arsenal-guns',
    { x: 164.3, y: 0 },
    [
      [5, 0],
      [1, M, 180], // shotgun bash at the landed Jetter (lunge left)
      [40, 0, 180],
      [1, F, -18], // Breacher at the Idle dummy, point blank: all 5 pellets
      [60, 0, -18],
      [1, F, -5], // at the Croucher: some pellets go over a crouched target
      [50, 0, -5],
      [30, J],
      [1, J | F, -30], // airborne blast: recoil push
      [60, 0],
      [1, Q],
      [25, 0],
      [60, F, -6], // K-47 spray (the air blast pushed us back to the thin wall)
      [1, Btn.Reload],
      [130, 0],
      [40, R], // weight: rifle speed caps
      [40, R | J],
      [60, 0],
    ],
    [BREACHER.index, K47.index],
  ),
  scenario(
    'arsenal-melee-sniper',
    { x: 164.3, y: 0 },
    [
      [5, 0],
      [1, F, 0], // Machete swing (fire) at the Idle dummy: one hit
      [134, 0],
      [1, M, 180], // melee button (the held Machete) at the landed Jetter
      [40, 0, 180],
      [1, Q],
      [25, 0],
      [1, F, 2], // Widow body shot at the Croucher
      [60, 0],
      [40, J],
      [1, J | F, -6], // air shot (minimum air spread)
      [90, 0],
      [60, Btn.Left], // weight: sniper speed caps
      [60, 0],
    ],
    [MACHETE.index, WIDOW.index],
  ),
  scenario('muzzle-guard', { x: 158, y: 0 }, [
    [60, R], // walk into the thin wall
    [1, F, 0],
    [40, 0],
    [1, F, 10],
    [60, 0],
  ]),
];

/**
 * A whole deathmatch through the Match lifecycle (match.ts), recorded by playing it: 4 humans and the
 * range dummies. P4 hunts the Strafer, P2 kills himself with two frags at his feet, the second after the first's grenade jump (−1), P1 and P3
 * stand still. Match 1 ends on the kill limit; P1–P3 vote for a rematch and P4 readies up late in
 * the lobby; in match 2 P4 stops after one kill, so it ends on the time limit; nobody votes, so the
 * room closes.
 */
function matchScenario(): ReplayFile {
  const rules: Partial<MatchRules> = { killLimit: 2, timeLimit: 15, countdown: 1, ending: 2, postgame: 2, onNoRematch: 'close' };
  const meta = { version: 1, name: 'match-dm', map: 'movement-test', seed: 1234, dummies: true, match: rules } as const;
  const game = createReplayGame({ ...meta, ticks: 0, players: [[], [], [], []] });
  const match = new Match(game, rules);
  const humans = game.players.filter((p) => p && !p.isBot).map((p) => p!);
  const streams: Input[][] = humans.map(() => []);
  const commands: MatchCommand[] = [];
  const issue = (tick: number, player: number, kind: MatchCommandKind) => {
    commands.push([tick, player, kind]);
    applyMatchCommand(match, humans[player]!.id, kind);
  };
  const input = (buttons: number, aimDeg: number): Input => ({ buttons, aim: angleToU16((aimDeg * Math.PI) / 180), weaponSelect: 0, throwStrength: 7 });

  let tick = 0;
  for (let closedFor = 0; closedFor < 60; tick++) {
    if (tick > 10_000) throw new Error('match-dm never closed');
    const t = match.phaseTick;
    if (tick === 0) humans.forEach((_, i) => issue(tick, i, 'ready'));
    if (match.phase === MatchPhase.Ending && match.number === 1 && t === 10) [0, 1, 2].forEach((i) => issue(tick, i, 'rematch'));
    if (match.phase === MatchPhase.Waiting && match.number === 1 && t === 60) issue(tick, 3, 'ready');

    const playing = match.phase === MatchPhase.InProgress;
    const p4Hunting = match.number === 1 || (match.players[humans[3]!.id]?.score ?? 0) < 1;
    const inputs = [
      input(0, 0),
      // the first frag grenade-jumps P2 (~6 m up); the second, thrown after he lands, finishes him
      input(playing && match.number === 1 && (t === 30 || t === 230) ? Btn.Grenade : 0, -90),
      input(0, 0),
      input(!playing ? 0 : t < 20 ? R : t % 40 === 10 && p4Hunting ? F : 0, 3),
    ];
    const byId: (Input | undefined)[] = [];
    humans.forEach((p, i) => {
      streams[i]!.push(inputs[i]!);
      byId[p.id] = inputs[i];
    });
    match.step(byId);
    if (match.phase === MatchPhase.Closed) closedFor++;
  }
  return { ...meta, ticks: tick, players: streams.map(encodeRuns), commands };
}
scenarios.push(matchScenario());

mkdirSync(OUT, { recursive: true });
for (const s of scenarios) {
  writeFileSync(join(OUT, `${s.name}.replay.json`), JSON.stringify(s) + '\n');
  console.log(`wrote ${s.name} (${s.ticks} ticks)`);
}
