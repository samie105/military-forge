/**
 * Generates the scripted golden-replay scenarios (docs/02 §19.3) into test/replays/.
 * Run: pnpm replays:generate   (then pnpm golden:update to record their hashes)
 *
 * Recorded playtests (from the web client's "Record" button) can be dropped into the same folder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREACHER, BUZZ, EMP, FLASHBANG, FRAG, GAS, GRENADE_TYPES, HAMMER, K47, MACHETE, MINE, RIOT_SHIELD, SMOKE, WIDOW } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import {
  Btn,
  Match,
  MatchPhase,
  applyMatchCommand,
  createReplayGame,
  encodeRuns,
  shieldRaised,
  type Game,
  type Input,
  type MatchCommand,
  type MatchCommandKind,
  type MatchRules,
  type PlayerState,
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
const G = Btn.Grenade;
const T = Btn.CycleGrenade;

function script(steps: Step[]): Input[] {
  const out: Input[] = [];
  for (const [n, buttons, aimDeg = 0] of steps) {
    for (let i = 0; i < n; i++) out.push({ buttons, aim: angleToU16((aimDeg * Math.PI) / 180), weaponSelect: 0, throwStrength: 7 });
  }
  return out;
}

function scenario(name: string, start: { x: number; y: number }, steps: Step[], loadout?: [number, number], grenades?: number[]): ReplayFile {
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
    ...(grenades ? { grenadeLoadouts: [grenades] } : {}),
    players: [encodeRuns(inputs)],
  };
}

/** A grenade belt: counts by grenade type. */
function belt(...pairs: [number, number][]): number[] {
  const out = new Array<number>(GRENADE_TYPES).fill(0);
  for (const [type, n] of pairs) out[type] = n;
  return out;
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
      [60, R], // weight: sniper speed caps (rightwards: the shots' kicks left us by the thin wall)
      [60, 0],
    ],
    [MACHETE.index, WIDOW.index],
  ),
  // Grenade variety, from behind the range's cover, with one of everything (cycling with T, and the
  // next type coming up when one runs out): a smoke that bounces back off the cover, gas against the
  // thin wall where the Strafer paces (pulses, a kill), a flashbang we look at, a mine stuck to the
  // thin wall for the Strafer, a frag into the gas, our own smoke, a walk into our own gas (half
  // damage) and past our mine, a flashbang at our feet while we look away, then an EMP at our feet:
  // our own jetpack dies for 3 s. The clouds age out.
  scenario(
    'grenades-variety',
    { x: 150, y: 0 },
    [
      [10, 0],
      [1, T], // frag → smoke
      [5, 0],
      [1, G, 14], // smoke: bounces back off the cover
      [60, 0, 14],
      [1, T], // smoke → gas
      [5, 0],
      [1, G, 24], // gas by the thin wall, on the Strafer
      [240, 0, 24],
      [1, G, 31], // the last gas: the flashbang comes up
      [60, 0, 31],
      [1, G, 25], // a flashbang at the Strafer: it's blinded, and so are we (we look at it)
      [150, 0, 25],
      [1, T], // flashbang → mine
      [5, 0],
      [1, G, 5], // over the cover, straight: it sticks to the thin wall where the Strafer paces
      [60, 0, 5],
      [1, T], // (the EMP came up) → frag, round the end of the belt
      [5, 0],
      [1, G, 20], // a frag into the gas
      [120, 0],
      [1, T], // frag → smoke
      [5, 0],
      [1, G, -30], // our last smoke, at our own feet: the flashbang comes up
      [100, 0],
      [40, R | J], // over the cover, out of our smoke
      [60, R], // into our own gas, by the thin wall and our mine (ours: it doesn't go off for us)
      [1, G, -80], // the last flashbang at our feet…
      [120, 0, 90], // …while we look up and away (the EMP comes up)
      [20, J], // a hop…
      [1, J | G, -90], // …an EMP at our feet…
      [80, 0], // …we land beside it as it goes off: our own jetpack is dead
      [200, J], // holding jet does nothing for 3 s; the clouds age out
    ],
    undefined,
    belt([FRAG.index, 2], [SMOKE.index, 2], [GAS.index, 2], [FLASHBANG.index, 2], [MINE.index, 1], [EMP.index, 1]),
  ),
  // Recoil push ("rebounds after shots", docs/02 §12), on the open floor past the overhang: a Breacher
  // shotgun jump at the top of a hop, the next shell as soon as it's pumped (falling by then: it
  // catches the fall, a hover), a level air shot (a shotgun dash), a standing shot (a short slide),
  // a flat-out flight with shots the other way (the kick stops short of launch speed), then the
  // Widow standing (kicked back), crouched (braced) and at the top of a hop.
  scenario(
    'recoil',
    { x: 119.5, y: 0 },
    [
      [10, 0],
      [12, J], // a hop
      [15, 0, -90],
      [1, F, -90], // Breacher straight down at its top: a shotgun jump
      [44, 0, -90],
      [1, F, -90], // the next shell as soon as it's pumped: it catches the fall
      [90, 0, -90],
      [12, J], // a hop
      [15, 0, 180],
      [1, F, 180], // fired level to the left at its top: knocked right
      [90, 0, 180],
      [1, F, 180], // standing: a short slide right
      [60, 0, 180],
      [30, J | Btn.Left, 180], // flying left flat out…
      [1, J | Btn.Left | F, 0], // …and firing right: kicked left, but never to launch speed
      [45, J | Btn.Left, 0],
      [1, J | Btn.Left | F, 0],
      [90, 0, 0],
      [1, Q], // the Widow
      [25, 0],
      [1, F, 0], // standing: kicked back ~0.7 m
      [60, 0],
      [10, D],
      [1, D | F, 0], // crouched: braced
      [60, D],
      [10, 0],
      [12, J], // a hop
      [6, 0],
      [1, F, 0], // near its top: knocked back
      [90, 0],
    ],
    [BREACHER.index, WIDOW.index],
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

/**
 * Records a closed-loop scenario on one map: `control` picks each tick's input for the one human
 * from the live game (positions, timers), and the inputs become the replay.
 */
function recorded(
  name: string,
  meta: Pick<ReplayFile, 'map' | 'seed' | 'dummies' | 'starts' | 'loadouts'>,
  ticks: number,
  control: (game: ReturnType<typeof createReplayGame>, me: ReturnType<typeof createReplayGame>['players'][number] & object, tick: number) => Input,
): ReplayFile {
  const replay: ReplayFile = { version: 1, name, ...meta, ticks: 0, players: [[]] };
  const game = createReplayGame(replay);
  const me = game.players.find((p) => p && !p.isBot)!;
  const inputs: Input[] = [];
  const byId: (Input | undefined)[] = [];
  for (let t = 0; t < ticks; t++) {
    const input = control(game, me, t);
    inputs.push(input);
    byId[me.id] = input;
    game.step(byId);
  }
  return { ...replay, ticks, players: [encodeRuns(inputs)] };
}

const deg = (d: number) => angleToU16((d * Math.PI) / 180);
const act = (buttons: number, aimDeg = 0, throwStrength = 7): Input => ({ buttons, aim: deg(aimDeg), weaponSelect: 0, throwStrength });

/**
 * Dash (docs/02 §21) on the movement-test map, driven by the player's state so every case happens:
 * a ground dash, an up-dash, a drop-through dash on a one-way platform, the one air dash (and a
 * refused second one), a refused straight-down dash on solid floor, a wall stop at the 12 m tower,
 * a slam, a down-left dash along the floor, and a press inside the cooldown.
 */
{
  let phase = 0;
  let since = 0;
  const next = (to = phase + 1) => {
    phase = to;
    since = 0;
  };
  scenarios.push(
    recorded('dash', { map: 'movement-test', seed: 1234, dummies: true, starts: [{ x: 127, y: 0 }] }, 60 * 22, (_g, me) => {
      since++;
      const ready = me.dashCooldown === 0 && me.dashTicks === 0;
      const settled = me.grounded && since > 10;
      switch (phase) {
        case 0: // ground dash along the facing
          if (since < 10) return act(0);
          next();
          return act(Btn.Dash);
        case 1: // up from the floor
          if (!ready || !settled) return act(0);
          next();
          return act(Btn.Dash | J);
        case 2: // back down
          if (!settled) return act(0);
          next();
          return act(J);
        case 3: // jet up past the 2.5 m one-way platform
          if (me.y < 2.9) return act(J);
          next();
          return act(0);
        case 4: // land on it, then dash straight down through it
          if (!settled || !ready) return act(0);
          next();
          return act(Btn.Dash | D);
        case 5: // on the floor again
          if (!(me.grounded && me.y < 0.1) || since < 10) return act(0);
          next();
          return act(J);
        case 6: // fly up, then the air dash
          if (me.y < 4 || !ready) return act(J);
          next();
          return act(Btn.Dash | R);
        case 7: // a second air dash: refused
          if (since < 12) return act(J);
          next();
          return act(Btn.Dash | Btn.Left);
        case 8: // land, walk to the tower, then straight down on solid floor: refused
          if (!settled) return act(0);
          if (me.x < 140.5) return act(R);
          if (!ready || since < 20) return act(0);
          next();
          return act(Btn.Dash | D);
        case 9: // into the tower's wall
          if (since < 3) return act(0);
          next();
          return act(Btn.Dash | R);
        case 10: // up the wall, then a slam
          if (!ready) return act(0);
          if (me.y < 4) return act(J);
          next();
          return act(Btn.Dash | D);
        case 11: // down-left on the floor: along it; then a press inside the cooldown
          if (!settled || !ready) return act(0);
          next();
          return act(Btn.Dash | D | Btn.Left);
        case 12:
          if (since < 4) return act(0);
          next();
          return act(Btn.Dash | Btn.Left);
        default:
          return act(0);
      }
    }),
  );
}

// Map mechanics (docs/02 §20) on the mechanics-test map: every zone and every event.
const MECH = { map: 'mechanics-test', seed: 1234, dummies: true } as const;

// A walk across the whole strip: hops every 1.5 s, dives now and then, a grenade forward every 4 s.
scenarios.push(
  recorded('mech-zones', { ...MECH, starts: [{ x: 2, y: 0 }] }, 60 * 46, (_g, me, t) => {
    const k = t % 90;
    let b = me.x < 168 ? R : 0;
    if (k < 18) b |= J;
    if (k > 60 && k < 75) b |= D;
    if (t % 240 === 120) b |= Btn.Grenade;
    return act(b, t % 240 === 120 ? 40 : 0);
  }),
);

/**
 * Bullets: from the gallery spawn (x 172) at the dummy behind the fog (x 194). The Hammer's 26 m
 * run out inside the fog; the Widow gets through, except while the fog event runs (21 s). Between
 * Widow shots we walk back to the spot its recoil slides us off.
 */
scenarios.push(
  recorded('mech-bullets', { ...MECH, starts: [{ x: 172, y: 0 }], loadouts: [[HAMMER.index, WIDOW.index]] }, 60 * 34, (g, me, t) => {
    const target = g.players.find((p) => p?.name === 'Behind fog')!;
    const aim = Math.atan2(target.y + 0.8 - me.shoulderY(g.tuning), target.x - me.shoulderX(g.tuning)) * (180 / Math.PI);
    if (t < 600) return act(t % 40 === 0 ? F : 0, aim); // Hammer: never reaches
    if (t === 600) return act(Q, aim); // swap to the Widow
    // the Widow's kick slides us back ~0.6 m a shot (docs/02 §12): walk back to the spot between shots
    const back = me.x < 171.85 ? R : 0;
    if (t < 2400 && t > 640) return act(t % 75 === 0 ? F : back, aim); // through the fog, then the fog event
    return act(back, aim);
  }),
);

/**
 * A whole event loop next to the knockback ×2 pit: hops (surge, low gravity, EMP, gusts, molasses),
 * Hammer shots at the Heavy dummy (the fog event's falloff), frags into the pit, and a stand in
 * pocket site A (picked for this seed).
 */
scenarios.push(
  recorded('mech-events', { ...MECH, starts: [{ x: 216, y: 0 }] }, 60 * 52, (g, me, t) => {
    const heavy = g.players.find((p) => p?.name === 'Heavy')!;
    const aim = Math.atan2(heavy.y + 0.8 - me.shoulderY(g.tuning), heavy.x - me.shoulderX(g.tuning)) * (180 / Math.PI);
    const inPocketWindow = t > 60 * 37 && t < 60 * 44;
    let b = 0;
    if (inPocketWindow && me.x < 222) b |= R;
    else if (!inPocketWindow && me.x > 216.5) b |= Btn.Left;
    if (t % 120 < 20) b |= J;
    if (t % 60 === 30) b |= F;
    // a soft lob into the pit (~8 m) during the surge, the gusts and the molasses (3 frags, no pickups)
    if (t === 300 || t === 2000 || t === 2750) return act(b | Btn.Grenade, 135, 3);
    return act(b, aim);
  }),
);

/**
 * The riot shield, played on the movement-test map with pickups on (closed loop: inputs react to
 * the game, then the replay only stores them). P1 (Hammer + K-47) takes the shield that spawns in
 * front of the range and holds it up facing P2 (Breacher + Buzz, 2.5 m away); P3 (Hammer + Buzz)
 * stands behind P2. The Breacher's pellets ricochet one by one, back past P2 and into P3. Slung,
 * the shield lets the Buzz through from the front. Up again but turned away, P1 dies to the Breacher
 * and drops the shield; P3 takes it, slings it and turns its back (the pellets ricochet off the back
 * guard), raises it again, shield-bashes P2, and P2 breaks it point-blank.
 */
function shieldScenario(): ReplayFile {
  const meta: Omit<ReplayFile, 'ticks' | 'players'> = {
    version: 1,
    name: 'shield',
    map: 'movement-test',
    seed: 1234,
    dummies: false,
    pickups: true,
    // right of the 12 m tower (x 142–144)
    starts: [
      { x: 152, y: 0 },
      { x: 148, y: 0 },
      { x: 146.4, y: 0 },
    ],
    loadouts: [
      [HAMMER.index, K47.index],
      [BREACHER.index, BUZZ.index],
      [HAMMER.index, BUZZ.index],
    ],
  };
  const game: Game = createReplayGame({ ...meta, ticks: 0, players: [[], [], []] });
  const [p1, p2, p3] = game.players.filter((p): p is PlayerState => p !== null);
  const streams: Input[][] = [[], [], []];
  const t = game.tuning;
  const aimAt = (p: PlayerState, x: number, y: number) => {
    const sx = p.x + (x >= p.x ? 1 : -1) * t.shoulderForward;
    return angleToU16(Math.atan2(y - p.shoulderY(t), x - sx));
  };
  const toward = (p: PlayerState, x: number) => (x > p.x + 0.15 ? Btn.Right : x < p.x - 0.15 ? Btn.Left : 0);
  const item = () => game.pickups.find((k) => k.alive);
  const left = angleToU16(Math.PI);

  // beats: each sets this tick's inputs and returns true when it's done (it then gets no more ticks)
  type Beat = (n: number, inputs: [Input, Input, Input]) => boolean;
  const fire = (who: PlayerState, i: 0 | 1 | 2, tx: () => number, ty: () => number, shots: number, every = 50): Beat => (n, inputs) => {
    inputs[i] = { ...inputs[i], aim: aimAt(who, tx(), ty()), buttons: n % every === 0 && n < shots * every ? Btn.Fire : 0 };
    return n >= shots * every - 1;
  };
  const press = (i: 0 | 1 | 2, button: number, wait: number): Beat => (n, inputs) => {
    inputs[i] = { ...inputs[i], buttons: n === 0 ? button : 0 };
    return n >= wait;
  };
  const wait = (ticks: number): Beat => (n) => n >= ticks;
  const shieldFace = (p: PlayerState) => p.x + p.facing * RIOT_SHIELD.forward;
  const beats: Beat[] = [
    (_, inputs) => {
      inputs[0] = { ...inputs[0], aim: left };
      return item() !== undefined;
    },
    // P1 walks onto it, then back to x 151, facing P2
    (_, inputs) => {
      const k = item();
      inputs[0] = { ...inputs[0], buttons: k ? toward(p1!, k.x) : 0, aim: left };
      return p1!.shieldHp > 0;
    },
    (n, inputs) => {
      inputs[0] = { ...inputs[0], buttons: toward(p1!, 151), aim: left };
      return n > 40 && shieldRaised(p1!) && Math.abs(p1!.vx) < 0.01;
    },
    // a Breacher shot into the shield: five ricochets
    fire(p2!, 1, () => shieldFace(p1!), () => 0.8, 1),
    // slung: P2's Buzz gets through
    press(0, Btn.Shield, 20),
    press(1, Btn.Swap, 30),
    (n, inputs) => {
      inputs[1] = { ...inputs[1], aim: aimAt(p2!, p1!.x, p1!.y + 0.7), buttons: n < 30 ? Btn.Fire : 0 };
      return n >= 40;
    },
    // up again, but P1 turns its back on P2: the Breacher kills it and the shield drops
    press(0, Btn.Shield, 30),
    (n, inputs) => {
      inputs[0] = { ...inputs[0], aim: 0 };
      return n >= 10;
    },
    press(1, Btn.Swap, 30),
    (n, inputs) => {
      inputs[1] = { ...inputs[1], aim: aimAt(p2!, p1!.x, p1!.y + 0.7), buttons: n % 50 === 0 && p1!.alive ? Btn.Fire : 0 };
      return !p1!.alive || n >= 250;
    },
    // P3 picks the dropped shield up and faces P2 with it
    (_, inputs) => {
      const k = game.pickups.find((x) => x.alive && x.spawner < 0);
      inputs[2] = { ...inputs[2], buttons: k ? toward(p3!, k.x) : 0, aim: left };
      return p3!.shieldHp > 0 || !k;
    },
    (n, inputs) => {
      inputs[2] = { ...inputs[2], buttons: 0, aim: left };
      return n >= 30;
    },
    // P3 slings it and turns its back on P2: the Breacher's pellets ricochet off the back guard
    press(2, Btn.Shield, 20),
    (n, inputs) => {
      inputs[2] = { ...inputs[2], aim: 0 };
      return n >= 10;
    },
    fire(p2!, 1, () => p3!.x - RIOT_SHIELD.backOffset, () => 0.8, 1),
    // facing P2 again, shield up
    (n, inputs) => {
      inputs[2] = { ...inputs[2], aim: left };
      return n >= 5;
    },
    press(2, Btn.Shield, 30),
    // shield bash: P3 walks up to P2 and swings
    (_, inputs) => {
      inputs[2] = { ...inputs[2], buttons: toward(p3!, p2!.x + 1), aim: left };
      return Math.abs(p3!.x - (p2!.x + 1)) < 0.2;
    },
    press(2, Btn.Melee, 50),
    // P2 breaks it point-blank
    (n, inputs) => {
      inputs[1] = { ...inputs[1], aim: aimAt(p2!, shieldFace(p3!), 0.8), buttons: n % 50 === 0 && p3!.shieldHp > 0 ? Btn.Fire : 0 };
      return p3!.shieldHp === 0 || n >= 300;
    },
    wait(60),
  ];

  let beat = 0;
  let n = 0;
  const held: [Input, Input, Input] = [
    { buttons: 0, aim: left, weaponSelect: 0, throwStrength: 7 },
    { buttons: 0, aim: 0, weaponSelect: 0, throwStrength: 7 },
    { buttons: 0, aim: 0, weaponSelect: 0, throwStrength: 7 },
  ];
  while (beat < beats.length) {
    if (game.tick > 3000) throw new Error(`shield scenario stuck in beat ${beat}`);
    const inputs: [Input, Input, Input] = [{ ...held[0], buttons: 0 }, { ...held[1], buttons: 0 }, { ...held[2], buttons: 0 }];
    const done = beats[beat]!(n, inputs);
    for (let i = 0; i < 3; i++) {
      held[i] = inputs[i]!;
      streams[i]!.push(inputs[i]!);
    }
    const byId: (Input | undefined)[] = [];
    [p1!, p2!, p3!].forEach((p, i) => (byId[p.id] = inputs[i]));
    game.step(byId);
    n++;
    if (done) {
      beat++;
      n = 0;
    }
  }
  return { ...meta, ticks: game.tick, players: streams.map(encodeRuns) };
}
scenarios.push(shieldScenario());

mkdirSync(OUT, { recursive: true });
for (const s of scenarios) {
  writeFileSync(join(OUT, `${s.name}.replay.json`), JSON.stringify(s) + '\n');
  console.log(`wrote ${s.name} (${s.ticks} ticks)`);
}
