/**
 * Animation lab (dev only, /animlab.html): the real 3D renderer, one scripted player on the flat floor and a
 * close-up camera that follows it, so locomotion and motion can be looked at frame by frame at exact speeds the controls can't
 * hold (a sustained 0.4 m/s walk, a blast launch, each dash direction). `window.__lab.strip(name)` renders a
 * scenario at 60 Hz and returns a labelled frame strip (PNG data URL); scripts/animation-shots.mjs saves them.
 * Nothing here ships in the game bundle (it isn't imported by main.ts).
 */
import { BREACHER, HAMMER, HitZone, K47, WIDOW, getMap } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';
import type { Frame, PlayerView } from '../view';
import { PlaneCamera, Renderer3D, softwareGl } from './index';
import { parsePreset } from './presets';

const DT = 1 / 60;
/** the movement-test map's long flat floor (x 116–142, y 0): the player really moves, so planted feet stay put */
const START_X = 124;

/** A scripted player: the view fields at time t (s); the rest stay at an idle default. */
type Script = (t: number) => Partial<PlayerView>;

interface Scenario {
  title: string;
  /** seconds to run before the first capture (the gait settles) */
  lead: number;
  /** capture times after the lead, with captions */
  shots: readonly (readonly [number, string])[];
  script: Script;
  /** height (m) of the region each frame shows around the player (default 1.95 m: the body and a margin) */
  crop?: number;
  /** sim events fired at times after the lead (hits on the player), built from the player's view then */
  events?: readonly (readonly [number, (p: PlayerView) => SimEvent[]])[];
}

/** a shooter off screen, `side` × 6 m to the right of the player (−1: left), hitting it at `height` m in `zone` */
const SHOOTER = 99;
function hits(p: PlayerView, weapon: { index: number; damage: number }, side: 1 | -1, zone: number, height: number, pellets = 1): SimEvent[] {
  return Array.from({ length: pellets }, (_, i): SimEvent[] => {
    const y = p.y + height + (i - (pellets - 1) / 2) * 0.08;
    return [
      { type: 'shot', shooter: SHOOTER, weapon: weapon.index, ox: p.x + 6 * side, oy: y + 0.05 * side, ex: p.x + 0.12 * side, ey: y, hit: 2, target: p.id, zone },
      { type: 'hit', attacker: SHOOTER, target: p.id, damage: weapon.damage, zone, source: weapon.index },
    ];
  }).flat();
}
/** captures through a hit reaction landing at t = 0 */
const REACTION = [[-0.03, 'before'], [0.03, '+30 ms'], [0.06, '+60 ms'], [0.1, '+100 ms'], [0.15, '+150 ms'], [0.22, '+220 ms'], [0.32, '+320 ms'], [0.5, '+500 ms']] as const;

const GRAVITY = 20;
/** a ballistic hop: airborne from t0 with (vx, vy), landing back on y = 0 */
function flight(t: number, t0: number, vx: number, vy: number, drag = 0.3): Partial<PlayerView> {
  const s = t - t0;
  const land = (2 * vy) / GRAVITY;
  if (s < 0) return { grounded: true };
  if (s >= land) return { grounded: true, vx: 0, vy: 0, y: 0 };
  return { grounded: false, vx: vx * Math.exp(-drag * s), vy: vy - GRAVITY * s, y: vy * s - (GRAVITY * s * s) / 2 };
}

const aimRight = 0.15;
const aimLeft = Math.PI - 0.15;

/** One gait cycle, sampled evenly: captures at cycle fractions. */
const cycle = (seconds: number, n = 8) => Array.from({ length: n }, (_, i) => [(i * seconds) / n, `${Math.round((i * 100) / n)}%`] as const);

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'hit-pistol': {
    title: 'Hit: Hammer .44 to the chest, from the front (a twitch)',
    lead: 1,
    shots: REACTION,
    script: () => ({ aim: aimRight }),
    events: [[0, (p) => hits(p, HAMMER, 1, HitZone.Torso, 1.0)]],
  },
  'hit-shotgun': {
    title: 'Hit: Breacher, five pellets, from the front (a stagger)',
    lead: 1,
    shots: REACTION,
    script: () => ({ aim: aimRight }),
    events: [[0, (p) => hits(p, BREACHER, 1, HitZone.Torso, 1.0, BREACHER.pellets)]],
  },
  'hit-headshot': {
    title: 'Hit: Widow headshot from the front (the head snaps)',
    lead: 1,
    shots: REACTION,
    script: () => ({ aim: aimRight }),
    events: [[0, (p) => hits(p, WIDOW, 1, HitZone.Head, 1.35)]],
  },
  'hit-behind': {
    title: 'Hit: K-47 burst from behind (the torso twists)',
    lead: 1,
    shots: REACTION,
    script: () => ({ aim: aimRight }),
    events: [0, 0.1, 0.2].map((at) => [at, (p: PlayerView) => hits(p, K47, -1, HitZone.Torso, 1.0)] as const),
  },
  'hit-air': {
    title: 'Hit: Breacher while hovering (the whole body takes it)',
    lead: 1,
    shots: REACTION,
    // a low hover, under the movement-test map's one-way platforms
    script: () => ({ aim: aimRight, grounded: false, jetting: true, y: 0.6, vy: 0 }),
    events: [[0, (p) => hits(p, BREACHER, 1, HitZone.Torso, 1.0, BREACHER.pellets)]],
  },
  'hit-run': {
    title: 'Hit: K-47 burst while running at 5 m/s (control stays)',
    lead: 1.5,
    shots: REACTION,
    script: () => ({ vx: 5, aim: aimRight }),
    events: [0, 0.1, 0.2].map((at) => [at, (p: PlayerView) => hits(p, K47, 1, HitZone.Torso, 1.0)] as const),
  },
  // one gait cycle each, at the cadence the gait gives that speed
  'slow-walk': { title: 'Careful steps: 0.4 m/s (walk_slow)', lead: 1.5, shots: cycle(0.7), script: () => ({ vx: 0.4, aim: aimRight }) },
  walk: { title: 'Walk: 1.2 m/s (heavy weapon, mud)', lead: 1.5, shots: cycle(0.41), script: () => ({ vx: 1.2, aim: aimRight }) },
  'fast-run': { title: 'Run: 5 m/s', lead: 1.5, shots: cycle(0.29), script: () => ({ vx: 5, aim: aimRight }) },
  backpedal: { title: 'Backpedal: moving right at 2.5 m/s, aiming left', lead: 1.5, shots: cycle(0.44), script: () => ({ vx: 2.5, aim: aimLeft }) },
  crouch: { title: 'Crouch walk: 2.2 m/s (crouch_walk over crouch_idle)', lead: 1.5, shots: cycle(0.35), script: () => ({ vx: 2.2, crouched: true, aim: aimRight }) },
  brake: {
    title: 'Brake: 5 m/s → 0 (ground decel 55 m/s²)',
    lead: 1.2,
    shots: [[-0.05, 'running'], [0.04, '+40 ms'], [0.08, '+80 ms'], [0.12, '+120 ms'], [0.18, '+180 ms'], [0.26, '+260 ms'], [0.4, '+400 ms'], [0.7, '+700 ms']],
    script: (t) => ({ vx: Math.max(0, 5 - 55 * Math.max(0, t - 1.2)), aim: aimRight }),
  },
  reverse: {
    title: 'Reverse: +5 → −5 m/s, turning to face the new way',
    lead: 1.2,
    shots: [[-0.05, 'running'], [0.04, '+40 ms'], [0.08, '+80 ms'], [0.12, '+120 ms'], [0.16, '+160 ms'], [0.22, '+220 ms'], [0.32, '+320 ms'], [0.6, '+600 ms']],
    script: (t) => {
      const s = Math.max(0, t - 1.2);
      return { vx: Math.max(-5, 5 - 80 * s), aim: s > 0.05 ? aimLeft : aimRight };
    },
  },
  launch: {
    title: 'Blast launch: 16 m/s sideways, 9 m/s up; flail, tumble, land',
    lead: 0.5,
    shots: [[-0.05, 'before'], [0.06, '+60 ms'], [0.15, '+150 ms'], [0.3, '+300 ms'], [0.5, '+500 ms'], [0.75, '+750 ms'], [0.92, 'landing'], [1.15, '+250 ms']],
    script: (t) => ({ ...flight(t, 0.5, 16, 9), aim: aimRight }),
    crop: 2.4,
  },
  land: {
    title: 'Landing from 4 m (8.9 m/s): land clip + squash',
    // touch-down at t = √(2·4/20) = 0.632 s
    lead: 0.632,
    shots: [[-0.12, 'falling'], [0.01, 'touch'], [0.03, '+30 ms'], [0.06, '+60 ms'], [0.1, '+100 ms'], [0.16, '+160 ms'], [0.25, '+250 ms'], [0.45, '+450 ms']],
    script: (t) => {
      const h = 4 - (GRAVITY * t * t) / 2;
      return h > 0 ? { grounded: false, y: h, vy: -GRAVITY * t, aim: aimRight } : { grounded: true, y: 0, vy: 0, aim: aimRight };
    },
  },
  jet: {
    title: 'Jet: ascend, hover, fall',
    lead: 0.3,
    shots: [[0, 'ground'], [0.25, 'ascend'], [0.6, 'ascend'], [1.0, 'hover'], [1.3, 'hover'], [1.7, 'fall'], [2.0, 'fall'], [2.4, 'landed']],
    script: (t) => {
      if (t < 0.3) return { aim: aimRight };
      const s = t - 0.3;
      if (s < 1.0) return { grounded: false, jetting: true, vy: Math.min(4, 6 * s), y: 1.6 * s * s, aim: aimRight };
      if (s < 1.4) return { grounded: false, jetting: true, vy: 0, y: 1.6, aim: aimRight };
      const f = s - 1.4;
      const y = 1.6 - (GRAVITY * f * f) / 2;
      return y > 0 ? { grounded: false, vy: -GRAVITY * f, y, aim: aimRight } : { aim: aimRight };
    },
  },
  dash: {
    title: 'Dash poses, 8 directions (14 m/s bursts)',
    lead: 0.4,
    shots: Array.from({ length: 8 }, (_, i) => [i * 0.6 + 0.07, ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'][i]!] as const),
    script: (t) => {
      const s = t - 0.4;
      const i = Math.floor(s / 0.6);
      const into = s - i * 0.6;
      if (s < 0 || i > 7 || into > 8 / 60) return { aim: aimRight, grounded: i < 0 || ![1, 2, 3, 5, 6, 7].includes(i) };
      const a = (i * Math.PI) / 4;
      return { aim: aimRight, dashing: true, grounded: false, vx: 14 * Math.cos(a), vy: 14 * Math.sin(a), y: 1 } as Partial<PlayerView>;
    },
    crop: 2.3,
  },
};

const baseView = (id: number): PlayerView => ({
  id,
  name: 'lab',
  isBot: false,
  isLocal: true,
  alive: true,
  x: START_X,
  y: 0,
  vx: 0,
  vy: 0,
  grounded: true,
  crouched: false,
  jetting: false,
  aim: aimRight,
  hp: 100,
  fuel: 100,
  fuelRegenDelay: 0,
  frags: 0,
  active: 0,
  dual: false,
  weapons: [{ def: 0, mag: 6, reserve: 30, reloadTicks: 0 }],
  respawnTicks: 0,
  kills: 0,
  deaths: 0,
});

/** A fixed close-up: 4 m across the 800×600 lab canvas (the zoom table only pulls back). */
class LabCamera extends PlaneCamera {
  override get viewWidth(): number {
    return 4;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view3d') as HTMLCanvasElement;
  const camera = new LabCamera();
  const map = getMap('movement-test');
  const params = new URLSearchParams(location.search);
  // the strips are shot in headless Chrome on SwiftShader: accept software WebGL there (softwareGl), as the game does
  const view = new Renderer3D(canvas, camera, map, parsePreset(params.get('gfx') ?? 'high'), false, undefined, softwareGl(params));
  const resize = () => {
    camera.resize(canvas.clientWidth, canvas.clientHeight);
    view.resize();
  };
  resize();
  await view.load({ x: START_X, y: 0 });
  view.pinScale(1);
  // the close-up camera sits between the foreground railings and the player: they would dither over the legs
  const foreground = view.scene.getObjectByName('foreground');
  if (foreground) foreground.visible = false;
  let nextId = 1;

  const frameOf = (p: PlayerView): Frame => ({ tick: 0, localId: p.id, players: [p], grenades: [] });

  async function strip(name: string, columns = 8): Promise<string> {
    const sc = SCENARIOS[name];
    if (!sc) throw new Error(`no scenario ${name}`);
    resize();
    const id = nextId++;
    // the player moves with its velocity (the camera follows), as in game
    let x = START_X;
    let last = 0;
    const at = (t: number): PlayerView => {
      const p = { ...baseView(id), ...sc.script(t) };
      x += p.vx * Math.max(0, t - last);
      last = t;
      p.x = x;
      camera.x = p.x;
      camera.y = p.y + 0.75;
      return p;
    };
    // the avatar loads asynchronously: render until it exists
    for (let i = 0; i < 600 && view.stats().avatars < 1; i++) {
      view.render(frameOf(at(0)), DT);
      await new Promise((r) => setTimeout(r, 10));
    }
    const shots = [...sc.shots].sort((a, b) => a[0] - b[0]);
    const cell = { w: 230, h: 300 };
    const out = document.createElement('canvas');
    out.width = cell.w * Math.min(columns, shots.length);
    out.height = (cell.h + 22) * Math.ceil(shots.length / columns) + 30;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(sc.title, 8, 20);
    let t = 0;
    const end = sc.lead + shots[shots.length - 1]![0] + 1.5 * DT;
    let k = 0;
    const fire = [...(sc.events ?? [])].sort((a, b) => a[0] - b[0]);
    let e = 0;
    while (t <= end && k < shots.length) {
      const p = at(t);
      // the scenario's hits land as the game's would: through the renderer's event path
      while (e < fire.length && t + 1e-9 >= sc.lead + fire[e]![0]) view.onEvents(fire[e++]![1](p));
      view.render(frameOf(p), DT);
      while (k < shots.length && t + 1e-9 >= sc.lead + shots[k]![0]) {
        const col = k % columns;
        const row = Math.floor(k / columns);
        // the camera puts (p.x, p.y + 0.75) at the centre: crop `crop` metres of height around it
        const ppm = canvas.width / camera.viewWidth;
        const sh = (sc.crop ?? 1.95) * ppm;
        const sw = (sh * cell.w) / cell.h;
        const sx = (canvas.width - sw) / 2;
        const sy = (canvas.height - sh) / 2;
        ctx.drawImage(canvas, sx, sy, sw, sh, col * cell.w, 30 + row * (cell.h + 22), cell.w, cell.h);
        ctx.fillStyle = '#9aa4ad';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText(shots[k]![1], col * cell.w + 8, 30 + row * (cell.h + 22) + cell.h + 16);
        k++;
      }
      t += DT;
    }
    // let the avatar go
    view.render({ tick: 0, localId: -1, players: [], grenades: [] }, DT);
    return out.toDataURL('image/png');
  }

  Object.assign(window, { __lab: { ready: true, strip, scenarios: Object.keys(SCENARIOS), view, camera } });
}

void main();
