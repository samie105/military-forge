import { BREACHER, BUZZ, HAMMER, HitZone, K47, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld, DamageSource, type SimEvent } from '@military-forge/sim';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { HIT, LEAN, MotionLayer, SQUASH, airLean, groundLean, hitReactions, hitSize, squashDepth, type MotionInput } from '../motion';
import type { PlayerView } from '../../view';
import { playerView } from './helpers';
import { rookieRig } from './rookieRig';

const DEG = Math.PI / 180;
const world = new CollisionWorld(movementTestMap);
/** whole-skeleton runs: generous under a loaded CI machine */
const SLOW = { timeout: 60_000 };
const still = { landing: 0, phase: 0, gait: { amplitude: 0, run: 0, warp: 1, cadence: 1.25, stride: 0.5 }, walk: { sweep: 0.29, leftFront: 0 }, groundWeight: 1 };
const input = (over: Partial<MotionInput> = {}): MotionInput => ({ grounded: true, crouched: false, jetting: false, vx: 0, vy: 0, aim: 0.1, ...over });

describe('lean ("how he should bend")', SLOW, () => {
  it('a fast run leans 10–15° forward, a slow walk stays nearly upright, and faster always leans more', () => {
    expect(groundLean(5, 0, 1) / DEG).toBeGreaterThanOrEqual(10);
    expect(groundLean(5, 0, 1) / DEG).toBeLessThanOrEqual(15);
    expect(Math.abs(groundLean(0.8, 0, 1)) / DEG).toBeLessThan(1);
    let last = -Infinity;
    for (const v of [0, 0.5, 1, 2, 3, 4, 5]) {
      expect(groundLean(v, 0, 1)).toBeGreaterThanOrEqual(last);
      last = groundLean(v, 0, 1);
    }
    expect(groundLean(-5, 0, -1)).toBeCloseTo(-groundLean(5, 0, 1), 9); // mirrored running left
    expect(Math.abs(groundLean(5, 0, -1))).toBeLessThan(groundLean(5, 0, 1)); // backpedalling leans less
  });

  it('braking or reversing leans back briefly, then settles upright (critically damped, no jitter)', async () => {
    const inst = await rookieRig();
    const m = new MotionLayer(inst);
    const leans: number[] = [];
    for (let i = 0; i < 150; i++) {
      const t = i / 60;
      const vx = t < 1 ? 5 : Math.max(0, 5 - 55 * (t - 1)); // the sim's ground deceleration
      m.update(input({ vx }), 1 / 60, 1.047, still);
      leans.push(m.lean);
    }
    expect(leans[59]! / DEG).toBeGreaterThan(10); // running: forward
    const back = Math.min(...leans.slice(60, 100));
    expect(back / DEG).toBeLessThan(-6); // the brake tips him back
    expect(Math.abs(leans[149]!) / DEG).toBeLessThan(1); // and he's upright again
    // smooth: no frame-to-frame jumps
    for (let i = 1; i < leans.length; i++) expect(Math.abs(leans[i]! - leans[i - 1]!) / DEG).toBeLessThan(3);
  });

  it('the run’s spine lean gives way to a hold’s lean into the gun: the larger shows, not the sum (review L6)', async () => {
    const spineTurn = async (holdLean: number) => {
      const inst = await rookieRig();
      const m = new MotionLayer(inst);
      const rest = inst.bone('spine2')!.quaternion.clone();
      const restRoot = inst.bone('root')!.quaternion.clone();
      for (let i = 0; i < 120; i++) {
        // the avatar restores the animation pose before each update; the rig here holds its rest pose
        inst.bone('spine1')!.quaternion.identity();
        inst.bone('spine2')!.quaternion.copy(rest);
        inst.bone('root')!.quaternion.copy(restRoot);
        m.update(input({ vx: 5 }), 1 / 60, Math.PI / 2 - (30 * Math.PI) / 180, still, holdLean);
      }
      return { spine: inst.bone('spine2')!.quaternion.angleTo(rest), root: inst.bone('root')!.quaternion.angleTo(restRoot) };
    };
    const bare = await spineTurn(0);
    const sniper = await spineTurn(0.12);
    expect(bare.spine).toBeGreaterThan(0.02); // a run leans the spine on its own
    expect(sniper.spine).toBeLessThan(0.2 * bare.spine); // the sniper's hunch (0.12 rad) already covers it
    expect(sniper.root).toBeCloseTo(bare.root, 6); // the whole body still leans into the run
  });

  it('in the air it leans with the velocity, a little more into the jet direction', () => {
    expect(airLean(6, false)).toBeGreaterThan(airLean(2, false));
    expect(airLean(-4, false)).toBeLessThan(0);
    expect(airLean(3, true)).toBeGreaterThan(airLean(3, false));
    expect(Math.abs(airLean(40, false))).toBeLessThanOrEqual(LEAN.airMax + 1e-9);
  });

  it('tilts the body in the gameplay plane: the head moves ahead of the feet when running', async () => {
    const inst = await rookieRig();
    const a = new Avatar(inst, 0, new AvatarKit(toonRamp()), 1);
    const headX = (vx: number) => {
      for (let i = 0; i < 120; i++) a.update(playerView({ x: 20, vx, aim: 0.1 }), 1 / 60, world, false);
      return inst.bone('head')!.getWorldPosition(new Vector3()).x - 20;
    };
    const standing = headX(0);
    expect(headX(5) - standing).toBeGreaterThan(0.12);
  });
});

describe('landing squash', SLOW, () => {
  it('scales with impact speed: none for a soft landing, deepest at the hardest', () => {
    expect(squashDepth(2)).toBe(0);
    let last = 0;
    for (const v of [3, 6, 9, 12, 16, 30]) {
      expect(squashDepth(v)).toBeGreaterThanOrEqual(last);
      last = squashDepth(v);
    }
    expect(squashDepth(16)).toBeCloseTo(SQUASH.max, 9);
  });

  it('squashes to about that depth on touch-down, stretches back a little, and settles to exactly 0', async () => {
    const inst = await rookieRig();
    const m = new MotionLayer(inst);
    const squash: number[] = [];
    m.update(input({ grounded: false, vy: -12 }), 1 / 60, 1.047, still);
    m.update(input(), 1 / 60, 1.047, { ...still, landing: 12 });
    for (let i = 0; i < 90; i++) {
      m.update(input(), 1 / 60, 1.047, still);
      squash.push(m.squash);
    }
    // the bounce is integrated in 4 ms steps: within 10 % of the target depth
    expect(-Math.min(...squash)).toBeGreaterThan(0.9 * squashDepth(12));
    expect(-Math.min(...squash)).toBeLessThan(1.1 * squashDepth(12));
    expect(Math.max(...squash)).toBeGreaterThan(0); // the rebound
    expect(m.squash).toBe(0);
    expect(m.drop).toBe(0);
  });

  it('a hard landing bends the knees, never scales the body, and the gun stays on the aim (review M1)', async () => {
    const kit = new AvatarKit(toonRamp());
    const rest = 0.12; // the rest pose's ankle height
    for (const aim of [0, 0.8, -0.8, Math.PI - 0.6, -Math.PI + 0.4]) {
      const inst = await rookieRig();
      const a = new Avatar(inst, 0, kit, 1);
      const gun = inst.bone('socket_weapon_R')!.children.find((c) => c.type === 'Mesh')!;
      const dir = new Vector3(Math.cos(aim), Math.sin(aim), 0);
      for (let i = 0; i < 20; i++) a.update(playerView({ x: 20, y: 2 - i * 0.1, vy: -16, grounded: false, aim }), 1 / 60, world, false);
      let worst = 0;
      let deepest = 0;
      let lowestFoot = Infinity;
      for (let f = 0; f < 40; f++) {
        a.update(playerView({ x: 20, y: 0, aim }), 1 / 60, world, false);
        expect(inst.root.scale.toArray()).toEqual([1, 1, 1]);
        // the barrel as drawn: through the gun's whole world matrix (a skew would show here, not in its quaternion)
        worst = Math.max(worst, new Vector3(0, 1, 0).transformDirection(gun.matrixWorld).angleTo(dir));
        deepest = Math.max(deepest, a.motion.drop);
        for (const s of ['L', 'R']) lowestFoot = Math.min(lowestFoot, inst.bone(`foot_${s}`)!.getWorldPosition(new Vector3()).y);
      }
      expect(deepest, 'hip drop at a 16 m/s landing (m)').toBeGreaterThan(0.1);
      expect(worst / DEG, `aim ${aim}`).toBeLessThan(0.5); // the scaled squash skewed it by up to 9.2°
      expect(lowestFoot, 'feet stay on the floor').toBeGreaterThan(rest - 0.01);
    }
  });
});

describe('launch flail', SLOW, () => {
  const fly = (m: MotionLayer, vx: number, frames: number, grounded = false) => {
    for (let i = 0; i < frames; i++) m.update(input({ grounded, vx, vy: grounded ? 0 : 2 }), 1 / 60, 1.047, still);
    return m.flail;
  };

  it('starts only above launchSpeedX in the air', async () => {
    const m = new MotionLayer(await rookieRig());
    expect(fly(m, m.launchSpeedX - 0.1, 30)).toBe(0);
    expect(fly(new MotionLayer(await rookieRig()), 20, 30, true)).toBe(0); // sliding on the ground isn't a launch
    expect(fly(m, m.launchSpeedX + 0.5, 20)).toBeGreaterThan(0.8);
  });

  it('a sideways air dash is the player’s own move, not a launch: no flail during it or on its way out (review M2)', async () => {
    const m = new MotionLayer(await rookieRig());
    fly(m, 3, 10);
    // the sim's burst: 14 m/s for 8 ticks, then the exit capped at launchSpeedX and slowing in the air
    for (let i = 0; i < 8; i++) m.update(input({ grounded: false, vx: 14, dashing: true }), 1 / 60, 1.047, still);
    for (let i = 0; i < 30; i++) m.update(input({ grounded: false, vx: Math.max(6, 12.5 - i * 0.4) }), 1 / 60, 1.047, still);
    expect(m.flail).toBe(0);
    // a blast after the dash is a launch again
    expect(fly(m, 16, 20)).toBeGreaterThan(0.8);
  });

  it('a respawn starts every motion afresh (review L5)', async () => {
    const m = new MotionLayer(await rookieRig());
    m.update(input({ grounded: false, vy: 2, deaths: 0 }), 1 / 60, 1.047, still);
    for (let i = 0; i < 30; i++) m.update(input({ grounded: false, vx: 16, vy: 2, deaths: 0 }), 1 / 60, 1.047, still);
    expect(m.flail).toBeGreaterThan(0.8);
    m.update(input({ deaths: 1 }), 1 / 60, 1.047, still);
    expect(m.flail).toBe(0);
    expect(m.lean).toBe(0);
    expect(m.squash).toBe(0);
  });

  it('recovers on landing, and the arms are out while it lasts', async () => {
    const inst = await rookieRig();
    const m = new MotionLayer(inst);
    // how far the left arm points along the body's up axis (−1 hanging … +1 straight up); the tumble turns the
    // whole body, so measure in the body's frame
    const raised = () => {
      const at = (n: string) => inst.bone(n)!.getWorldPosition(new Vector3());
      const arm = at('forearm_L').sub(at('upperarm_L')).normalize();
      return arm.dot(at('neck').sub(at('pelvis')).normalize());
    };
    m.update(input({ grounded: false, vy: 2 }), 1 / 60, 1.047, still);
    const hanging = raised();
    fly(m, 16, 30);
    expect(raised()).toBeGreaterThan(hanging + 0.4);
    expect(fly(m, 9, 40, true)).toBeLessThan(0.01);
  });
});

describe('dash pose (8-way, docs/02 §21)', SLOW, () => {
  /** limb positions relative to the feet after 5 frames of a dash in direction `deg` (0 = right, CCW) */
  async function pose(deg: number) {
    const inst = await rookieRig();
    const a = new Avatar(inst, 0, new AvatarKit(toonRamp()), 1);
    for (let i = 0; i < 20; i++) a.update(playerView({ x: 20, y: 1, grounded: false, aim: 0.1 }), 1 / 60, world, false);
    const v = { vx: 14 * Math.cos(deg * DEG), vy: 14 * Math.sin(deg * DEG) };
    for (let i = 0; i < 5; i++) a.update({ ...playerView({ x: 20, y: 1, grounded: false, aim: 0.1, ...v }), dashing: true } as never, 1 / 60, world, false);
    const at = (n: string) => inst.bone(n)!.getWorldPosition(new Vector3()).sub(new Vector3(20, 1, 0));
    return { a, head: at('head'), pelvis: at('pelvis'), knee: at('calf_L'), foot: at('foot_L'), hand: at('hand_L') };
  }

  it('sideways: stretched along the dash, the head leading', async () => {
    const fwd = await pose(0);
    const back = await pose(180);
    expect(fwd.head.x - fwd.pelvis.x).toBeGreaterThan(0.2);
    expect(back.head.x - back.pelvis.x).toBeLessThan(-0.2);
    expect(fwd.foot.x).toBeLessThan(fwd.pelvis.x); // legs trail
  });

  it('up: tucked, knees pulled up', async () => {
    const up = await pose(90);
    expect(up.knee.y - up.pelvis.y).toBeGreaterThan(-0.12); // a hanging knee sits 0.17 m below the hip
    expect(up.foot.y).toBeGreaterThan(0.18);
  });

  it('down: a slam, body upright and legs straight down, the free fist driving down in front', async () => {
    const down = await pose(270);
    expect(Math.abs(down.head.x - down.pelvis.x)).toBeLessThan(0.08);
    expect(down.pelvis.y - down.foot.y).toBeGreaterThan(0.3); // a straight leg is 0.34 m hip to ankle
    expect(down.hand.y).toBeLessThan(0.75);
  });

  it('diagonals mix both: up-forward leans forward with the knees up, down-forward leans forward legs straight', async () => {
    const upFwd = await pose(45);
    const downFwd = await pose(-45);
    expect(upFwd.head.x - upFwd.pelvis.x).toBeGreaterThan(0.1);
    expect(upFwd.foot.y).toBeGreaterThan(0.15);
    expect(downFwd.head.x - downFwd.pelvis.x).toBeGreaterThan(0.1);
    expect(downFwd.pelvis.y - downFwd.foot.y).toBeGreaterThan(0.25);
  });
});

describe('the gun arm through the motion (review of #85: the aim pose owns it)', SLOW, () => {
  const DEG_ = 180 / Math.PI;
  const kit = new AvatarKit(toonRamp());
  const gunOf = (av: Avatar, side: 'R' | 'L') => av.inst.bone(`socket_weapon_${side}`)!.children.find((c) => c.type === 'Mesh')!;
  /** the hand from its shoulder, in the body's yawed frame (the pivot) */
  const handFromShoulder = (av: Avatar, side: 'R' | 'L') =>
    av.pivot.worldToLocal(av.inst.bone(`hand_${side}`)!.getWorldPosition(new Vector3())).sub(av.pivot.worldToLocal(av.inst.bone(`upperarm_${side}`)!.getWorldPosition(new Vector3())));
  /** the wrist: the forearm's line against the barrel */
  const wrist = (av: Avatar, side: 'R' | 'L') => {
    const f = av.inst.bone(`forearm_${side}`)!.getWorldPosition(new Vector3());
    const h = av.inst.bone(`hand_${side}`)!.getWorldPosition(new Vector3());
    return h.sub(f).normalize().angleTo(new Vector3(0, 1, 0).transformDirection(gunOf(av, side).matrixWorld)) * DEG_;
  };
  const cases: [string, (i: number) => Partial<PlayerView>][] = [
    ['a 5 m/s run', () => ({ vx: 5, y: 0, grounded: true })],
    ['a sideways air dash', (i) => (i < 8 ? { vx: 14, dashing: true, grounded: false } : { vx: 6, grounded: false })],
    ['an up dash', (i) => (i < 8 ? { vy: 14, dashing: true, grounded: false } : { vy: 2, grounded: false })],
    ['a down dash', (i) => (i < 8 ? { vy: -14, dashing: true, grounded: false } : { vy: -2, grounded: false })],
    ['a blast launch', () => ({ vx: 16, vy: 4, grounded: false })],
  ];
  for (const [name, script] of cases)
    for (const dual of [false, true])
      it(`${name}${dual ? ', dual-wielding' : ''}: the gun stays in the hand the aim pose holds it in, on the aim`, async () => {
        const aim = 0.2;
        const dir = new Vector3(Math.cos(aim), Math.sin(aim), 0);
        const moving = new Avatar(await rookieRig(), 0, kit, 1);
        const standing = new Avatar(await rookieRig(), 0, kit, 1);
        const still = () => playerView({ x: 20, y: 2, grounded: false, aim, dual });
        for (let i = 0; i < 30; i++) for (const av of [moving, standing]) av.update(still(), 1 / 60, world, false);
        let hand = 0;
        let barrel = 0;
        let bend = 0;
        for (let i = 0; i < 30; i++) {
          moving.update({ ...playerView({ x: 20 + i * 0.1, y: 2, aim, dual }), ...script(i) } as PlayerView, 1 / 60, world, false);
          standing.update(still(), 1 / 60, world, false);
          for (const side of dual ? (['R', 'L'] as const) : (['R'] as const)) {
            hand = Math.max(hand, handFromShoulder(moving, side).distanceTo(handFromShoulder(standing, side)) * 100);
            barrel = Math.max(barrel, new Vector3(0, 1, 0).transformDirection(gunOf(moving, side).matrixWorld).angleTo(dir) * DEG_);
            bend = Math.max(bend, wrist(moving, side) - wrist(standing, side));
          }
        }
        expect(hand, 'gun hand moved from the armed stand (cm)').toBeLessThan(3);
        expect(barrel, 'barrel off the aim (°)').toBeLessThan(0.5);
        expect(bend, 'wrist bent past the armed stand (°)').toBeLessThan(5);
      });
});

describe('hit reactions (the owner: "the movement when receiving bullets")', SLOW, () => {
  const kit = new AvatarKit(toonRamp());
  const DEG_ = 180 / Math.PI;
  const shot = (shooter: number, target: number, ox: number, ex: number, y = 1): SimEvent => ({ type: 'shot', shooter, weapon: 0, ox, oy: y, ex, ey: y, hit: 2, target, zone: HitZone.Torso });
  const hitEv = (attacker: number, target: number, damage: number, source: number, zone: number = HitZone.Torso): SimEvent => ({ type: 'hit', attacker, target, damage, zone, source });

  it('a pistol is a twitch, a rifle a jolt, a shotgun or a sniper a real stagger', () => {
    expect(hitSize(BUZZ.damage, BUZZ.index)).toBeLessThan(0.15);
    expect(hitSize(HAMMER.damage, HAMMER.index)).toBeLessThan(0.4);
    expect(hitSize(K47.damage, K47.index)).toBeLessThan(hitSize(HAMMER.damage, HAMMER.index));
    expect(Math.min(HIT.max, BREACHER.pellets * hitSize(BREACHER.damage, BREACHER.index))).toBeGreaterThan(1.2);
    expect(hitSize(WIDOW.damage, WIDOW.index)).toBeGreaterThan(1.2);
    expect(hitSize(1000, WIDOW.index)).toBe(HIT.max);
  });

  it('takes the way each hit travelled from its bullet, the blast, or the attacker', () => {
    const chest = (id: number) => ({ 1: { x: 10, y: 1 }, 2: { x: 4, y: 1 } })[id as 1 | 2] ?? null;
    // a bullet from the right travels −x; five pellets map to five hits
    const pellets = [...Array(5)].flatMap(() => [shot(2, 1, 16, 10), hitEv(2, 1, 20, BREACHER.index)]);
    const r = hitReactions(pellets, chest);
    expect(r).toHaveLength(5);
    for (const h of r) expect(h.dirX).toBeCloseTo(-1, 6);
    // a blast to the left pushes +x; a machete from the attacker at x 4 too
    expect(hitReactions([{ type: 'explosion', x: 8, y: 1, radius: 4, owner: 2 }, hitEv(2, 1, 40, DamageSource.Grenade)], chest)[0]!.dirX).toBeCloseTo(1, 6);
    expect(hitReactions([hitEv(2, 1, 40, DamageSource.Melee)], chest)[0]!.dirX).toBeCloseTo(1, 6);
    // gas has no direction
    const gas = hitReactions([hitEv(-1, 1, 5, DamageSource.Gas)], chest)[0]!;
    expect([gas.dirX, gas.dirY]).toEqual([0, 0]);
  });

  /** how far (°) a bone turns away from an un-hit twin's after `hits` land at frame 10, frame by frame */
  async function reaction(bone: string, hits: (a: Avatar) => void, over: Partial<PlayerView> = {}): Promise<number[]> {
    const A = new Avatar(await rookieRig(), 0, kit, 1);
    const B = new Avatar(await rookieRig(), 0, kit, 1);
    const view = () => playerView({ x: 20, aim: 0.2, ...over });
    for (let i = 0; i < 40; i++) for (const av of [A, B]) av.update(view(), 1 / 60, world, false);
    const out: number[] = [];
    for (let i = 0; i < 40; i++) {
      if (i === 10) hits(A);
      for (const av of [A, B]) av.update(view(), 1 / 60, world, false);
      const qa = A.inst.bone(bone)!.getWorldQuaternion(new Quaternion());
      out.push(qa.angleTo(B.inst.bone(bone)!.getWorldQuaternion(new Quaternion())) * DEG_);
    }
    return out;
  }
  const peak = (xs: number[]) => Math.max(...xs);

  it('flinches away from the shot by the hit’s size, and is over within a quarter of a second', async () => {
    const pistol = await reaction('spine2', (a) => a.hit(-1, 0, hitSize(HAMMER.damage, HAMMER.index), HitZone.Torso));
    const sniper = await reaction('spine2', (a) => a.hit(-1, 0, hitSize(WIDOW.damage, WIDOW.index), HitZone.Torso));
    expect(peak(pistol)).toBeGreaterThan(1);
    expect(peak(pistol)).toBeLessThan(8); // a twitch
    expect(peak(sniper)).toBeGreaterThan(15); // a stagger
    // short: the hit lands at frame 10; 0.3 s later it has all but gone
    expect(sniper[10 + 18]!).toBeLessThan(0.25 * peak(sniper));
    expect(sniper[39]!).toBeLessThan(1);
  });

  it('a headshot snaps the head; a hit from behind twists the torso', async () => {
    const torso = await reaction('head', (a) => a.hit(-1, 0, 1, HitZone.Torso));
    const head = await reaction('head', (a) => a.hit(-1, 0, 1, HitZone.Head));
    expect(peak(head)).toBeGreaterThan(peak(torso) + 15);
    // facing right (aim 0.2): a shot travelling +x came from behind
    const front = await reaction('spine2', (a) => a.hit(-1, 0, 1, HitZone.Torso));
    const behind = await reaction('spine2', (a) => a.hit(1, 0, 1, HitZone.Torso));
    expect(peak(behind)).toBeGreaterThan(peak(front) + 5);
  });

  it('a hit in the air throws the whole body further', async () => {
    const ground = await reaction('root', (a) => a.hit(-1, 0, 1, HitZone.Torso));
    const air = await reaction('root', (a) => a.hit(-1, 0, 1, HitZone.Torso), { y: 2, grounded: false });
    expect(peak(air)).toBeGreaterThan(2 * peak(ground));
  });

  it('keeps the gun hand on the aim through a stagger (the same rule as the dash and the flail)', async () => {
    const aim = 0.2;
    const dir = new Vector3(Math.cos(aim), Math.sin(aim), 0);
    const A = new Avatar(await rookieRig(), 0, kit, 1);
    const B = new Avatar(await rookieRig(), 0, kit, 1);
    const view = () => playerView({ x: 20, aim });
    const handFromShoulder = (av: Avatar) => av.pivot.worldToLocal(av.inst.bone('hand_R')!.getWorldPosition(new Vector3())).sub(av.pivot.worldToLocal(av.inst.bone('upperarm_R')!.getWorldPosition(new Vector3())));
    const gun = (av: Avatar) => av.inst.bone('socket_weapon_R')!.children.find((c) => c.type === 'Mesh')!;
    for (let i = 0; i < 40; i++) for (const av of [A, B]) av.update(view(), 1 / 60, world, false);
    let hand = 0;
    let barrel = 0;
    for (let i = 0; i < 30; i++) {
      if (i % 6 === 0) A.hit(i % 12 ? 1 : -1, 0.2, HIT.max, i % 18 ? HitZone.Torso : HitZone.Head);
      for (const av of [A, B]) av.update(view(), 1 / 60, world, false);
      hand = Math.max(hand, handFromShoulder(A).distanceTo(handFromShoulder(B)) * 100);
      barrel = Math.max(barrel, new Vector3(0, 1, 0).transformDirection(gun(A).matrixWorld).angleTo(dir) * DEG_);
    }
    expect(hand, 'gun hand moved (cm)').toBeLessThan(3);
    expect(barrel, 'barrel off the aim (°)').toBeLessThan(0.5);
  });

  it('Reduce motion plays reactions at a fraction of their size', async () => {
    const full = await reaction('spine2', (a) => a.hit(-1, 0, 1, HitZone.Torso));
    const reduced = await reaction('spine2', (a) => a.hit(-1, 0, 1, HitZone.Torso, HIT.reduced));
    expect(peak(reduced)).toBeLessThan(0.4 * peak(full));
  });
});
