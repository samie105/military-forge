/**
 * Kill effects (docs/17 §3.7, docs/04 §7): a skin line's top tier (the K-47 Galaxy Relic's "stardust") plays where
 * the victim falls, on kills with that gun, for everyone who can see the spot. Nothing on the wire: the death event
 * names the killer and the weapon, and the killer's look (the ROSTER's) says whether that gun carries an effect.
 *
 * What it draws, inside the victim's body envelope (the base body box +10%) and for ≤ 1 s (the Galaxy Relic's
 * "Stardust Shatter", owner 28 Oct: the body breaks into glowing crystal shards that drift into a stardust swirl):
 * - the body: its colour mixes toward the effect's tint as it collapses, and it dissolves over `dissolveS` (by
 *   0.32 s, sooner than a plain death's fade) as the shards take its place (uniforms on the soldier's own material:
 *   no draw call, no light; avatar.ts killEffect);
 * - the shards: crystal cubes (atlas Cell.Shard) over the standing body's outline, just behind it. As the body goes
 *   they're left where it stood, so it reads as breaking up, then crumble outward a little, tumble and shrink away;
 * - the sparkles: small stars twinkling over the body in two waves;
 * - the swirl: from `swirl.atS`, motes rising in a two-strand spiral over the spot, fading as they go.
 * All of it is ≤ 80 quads from the shared VFX atlas in one instanced, alpha-blended, depth-tested layer set just
 * behind the body, so the dropped weapon, pickups, players and tracers (and the HUD and nameplates, which are on top
 * of the canvas) all draw over it at full brightness. No flash, no shake, no light, no sound of its own.
 *
 * The still variant (Reduce flashes, Reduce motion, the Low preset, or a fifth effect at once): the body's flat
 * tint over a plain death's collapse and fade, no particles. "Show other players' kill effects" off: only your own kills play one.
 */
import { KILL_EFFECT_LIMITS, killEffectOf, killEffects, weapons, type CosmeticLoadout, type KillEffectDef, type KillEffectPhase } from '@military-forge/content';
import { DamageSource, type SimEvent } from '@military-forge/sim';
import { Color } from 'three';
import { reduceFlashes } from '../../fx';
import type { Frame } from '../../view';
import { ATLAS_GRID, Cell, vfxAtlas } from './atlas';
import type { VfxContext, VfxModule } from './index';
import { ParticleLayer } from './particles';
import { F, ParticlePool, STRIDE, particleSpec, type ParticleSpec } from './pool';
import { Ramp } from './ramps';

/** The base body's box (docs/04 §1.2; packages/content hitboxes): 1.5 m tall to the top of the helmet, ±0.3 m wide. */
const BODY_HEIGHT = 1.5;
const BODY_HALF_WIDTH = 0.3;
/** the stardust sits this far behind the gameplay plane: inside the envelope's depth, behind the body and the items */
const DUST_Z = -0.3;

/** What the effects need from the renderer. */
export interface KillEffectHost {
  /** a player's look (the ROSTER's; the local player's own), or null */
  lookOf(id: number): CosmeticLoadout | null;
  /** a player's team, −1 for none (a free-for-all) */
  teamOf(id: number): number;
  /** the local player (the viewer's own kills always play), −1 for none */
  viewer(): number;
  /** the victim's drawn body: where its feet are, and the hook that tints it (and, for a shatter, dissolves it sooner) */
  body(id: number): { x: number; y: number; killEffect(colour: Color, seconds: number, dissolve?: readonly [number, number] | null): void } | null;
}

/** One effect playing: when it ends, and whether it drew particles. */
interface Live {
  until: number;
  particles: boolean;
}

/** A later phase of a playing effect: the second wave of sparkles, the swirl. */
interface Pending {
  at: number;
  effect: KillEffectDef;
  x: number;
  y: number;
  phase: 'sparkles' | 'swirl';
}

/** What a quad is (its pool tag, + 4 × the effect's index in `killEffects`): swirl motes are moved every frame. */
const SHARD = 0;
const SPARKLE = 1;
const SWIRL = 2;
/** the standing body's half width at a height above its feet (legs, torso, head), for where the shards start */
const halfWidthAt = (h: number) => (h < 0.7 ? 0.14 : h < 1.22 ? 0.21 : 0.13);
/** shards slow to a stop: their burst carries them at most burst / drag metres */
const SHARD_DRAG = 3.2;

/**
 * Whether a death plays a kill effect, and which (docs/17 §3.7 "Trigger"): a kill by another player, with a gun
 * (not a grenade, mine, gas, melee or the world), not a team kill, by a killer whose look wears that gun's
 * kill-effect tier. Null = the default death.
 */
export function killEffectFor(e: { victim: number; killer: number; source: number }, host: Pick<KillEffectHost, 'lookOf' | 'teamOf'>): KillEffectDef | null {
  if (e.killer < 0 || e.killer === e.victim) return null;
  if (e.source >= DamageSource.Mine) return null;
  const gun = weapons[e.source];
  if (!gun || gun.class === 'melee') return null;
  const team = host.teamOf(e.killer);
  if (team >= 0 && team === host.teamOf(e.victim)) return null;
  return killEffectOf(host.lookOf(e.killer), gun.id);
}

export class KillEffects implements VfxModule {
  /** Settings → Graphics → "Show other players' kill effects" (on by default; off: only your own kills) */
  showOthers = true;
  /** the Low preset plays the still variant */
  low = false;
  private readonly pool = new ParticlePool(KILL_EFFECT_LIMITS.maxParticles * KILL_EFFECT_LIMITS.maxLive, true);
  private layer: ParticleLayer | null = null;
  private readonly live: Live[] = [];
  private readonly pending: Pending[] = [];
  private time = 0;
  private seed = 0x5d1a;
  private readonly spec: ParticleSpec = particleSpec();
  private readonly base: ParticleSpec = particleSpec();
  private readonly colours = new Map<string, Color>();

  constructor(private readonly host: KillEffectHost) {}

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private range([lo, hi]: readonly [number, number]): number {
    return lo + (hi - lo) * this.rand();
  }

  private colour(hex: string): Color {
    let c = this.colours.get(hex);
    if (!c) this.colours.set(hex, (c = new Color(hex)));
    return c;
  }

  /** effects playing now (tests, the 4-at-once cap) */
  get playing(): number {
    return this.live.filter((l) => l.until > this.time).length;
  }

  /** particles alive now (tests) */
  get particles(): number {
    return this.pool.count;
  }

  onEvents(events: readonly SimEvent[], fx: VfxContext): void {
    for (const e of events) {
      if (e.type !== 'death') continue;
      const effect = killEffectFor(e, this.host);
      if (!effect) continue;
      if (!this.showOthers && e.killer !== this.host.viewer()) continue;
      const body = this.host.body(e.victim);
      if (!body) continue;
      const still = fx.reducedMotion || reduceFlashes() || this.low || this.playing >= KILL_EFFECT_LIMITS.maxLive;
      if (still) body.killEffect(this.colour(effect.still.tint), effect.still.durationS);
      else body.killEffect(this.colour(effect.bodyTint), effect.durationS, effect.dissolveS);
      this.live.push({ until: this.time + effect.durationS, particles: !still });
      if (still) continue;
      this.ensureLayer(fx);
      this.shards(effect, body.x, body.y);
      this.sparkles(effect, body.x, body.y, Math.ceil(effect.sparkles.count / 2));
      this.pending.push({ at: this.time + effect.sparkles.secondWaveS, effect, x: body.x, y: body.y, phase: 'sparkles' });
      this.pending.push({ at: this.time + effect.swirl.atS, effect, x: body.x, y: body.y, phase: 'swirl' });
    }
  }

  /** A fresh quad of `phase`'s look: its size, life and a colour from its palette. */
  private quad(phase: KillEffectPhase): ParticleSpec {
    const p = Object.assign(this.spec, this.base);
    p.life = this.range(phase.lifeS);
    p.size0 = this.range(phase.sizeM);
    p.ramp = Ramp.Book;
    const c = this.colour(phase.palette[Math.floor(this.rand() * phase.palette.length)]!);
    p.tr = c.r;
    p.tg = c.g;
    p.tb = c.b;
    p.z = DUST_Z;
    return p;
  }

  /**
   * Crystal cubes over the standing body's outline (legs, torso, head), each bursting out from the body's middle
   * and slowing to a stop: where it starts is clamped so that the whole drift (and the quad's half size) stays
   * inside the envelope.
   */
  private shards(effect: KillEffectDef, x: number, y: number): void {
    const half = BODY_HALF_WIDTH * KILL_EFFECT_LIMITS.envelopeMul;
    const top = y + BODY_HEIGHT * KILL_EFFECT_LIMITS.envelopeMul;
    const { shards } = effect;
    const tag = SHARD + 4 * killEffects.indexOf(effect);
    for (let i = 0; i < shards.count; i++) {
      const p = this.quad(shards);
      const h = 0.06 + this.rand() * (BODY_HEIGHT - 0.12);
      const r0 = this.rand() * 2 - 1;
      const side = Math.sign(r0) * Math.sqrt(Math.abs(r0)); // more towards the outline than the middle
      const speed = shards.burstMps * (0.3 + 0.7 * this.rand());
      const up = (this.rand() - 0.45) * 0.8;
      p.vx = (side >= 0 ? 1 : -1) * speed;
      p.vy = up * speed;
      const r = p.size0 / 2;
      const dx = Math.abs(p.vx) / SHARD_DRAG;
      const dy = p.vy / SHARD_DRAG;
      p.x = x + Math.max(-(half - r - dx), Math.min(half - r - dx, side * halfWidthAt(h)));
      p.y = Math.max(y + r - Math.min(0, dy), Math.min(top - r - Math.max(0, dy), y + h));
      p.drag = SHARD_DRAG;
      p.size1 = p.size0 * 0.3;
      p.ease = 3; // holds its size, then shrinks away
      p.rot = this.rand() * Math.PI * 2;
      p.spin = (this.rand() * 2 - 1) * 4;
      p.fadeIn = 0.1;
      p.cell = Cell.Shard;
      this.pool.emit(p, tag);
    }
  }

  /** `count` stars twinkling over the body: in, held a moment, out. */
  private sparkles(effect: KillEffectDef, x: number, y: number, count: number): void {
    const half = BODY_HALF_WIDTH * KILL_EFFECT_LIMITS.envelopeMul;
    const tag = SPARKLE + 4 * killEffects.indexOf(effect);
    for (let i = 0; i < count; i++) {
      const p = this.quad(effect.sparkles);
      const r = p.size0 / 2;
      const h = 0.1 + this.rand() * (BODY_HEIGHT - 0.1);
      p.x = x + (this.rand() * 2 - 1) * Math.min(half - r, halfWidthAt(h) + 0.06);
      p.y = Math.max(y + r, Math.min(y + BODY_HEIGHT * KILL_EFFECT_LIMITS.envelopeMul - r, y + h));
      p.size1 = p.size0 * 0.2;
      p.spin = (this.rand() * 2 - 1) * 1.5;
      p.fadeIn = 0.45;
      p.alpha = 0.9;
      p.cell = Cell.Star;
      this.pool.emit(p, tag);
    }
  }

  /**
   * The stardust swirl: motes on two strands of a spiral round the spot's centre line, rising `riseM` over their
   * life. A mote keeps its centre line in `nx` and its phase in `ny` (unused by a quad in the camera plane, orient 0);
   * update() sets its x on the spiral every frame.
   */
  private swirl(effect: KillEffectDef, x: number, y: number): void {
    const { swirl } = effect;
    const top = y + BODY_HEIGHT * KILL_EFFECT_LIMITS.envelopeMul;
    const tag = SWIRL + 4 * killEffects.indexOf(effect);
    for (let i = 0; i < swirl.count; i++) {
      const p = this.quad(swirl);
      const r = p.size0 / 2;
      const h = 0.25 + (i / swirl.count) * 0.85 + this.rand() * 0.05;
      p.y = Math.min(y + h, top - r - swirl.riseM);
      p.vy = swirl.riseM / p.life;
      p.nx = x;
      p.ny = (i % 2) * Math.PI + h * ((Math.PI * 2) / 0.9);
      p.x = x + swirl.radiusM * Math.sin(p.ny);
      p.size1 = p.size0 * 0.5;
      p.fadeIn = 0.3;
      p.alpha = 0.85;
      p.cell = i % 4 === 0 ? Cell.Star : Cell.Dot;
      this.pool.emit(p, tag);
    }
  }

  private ensureLayer(fx: VfxContext): void {
    if (this.layer) return;
    // alpha (paint, not light) and depth-tested, under the glow layer (12): tracers and sparks draw over it
    this.layer = new ParticleLayer(this.pool.capacity, { texture: vfxAtlas(), grid: [ATLAS_GRID, ATLAS_GRID], blend: 'alpha', depthTest: true, renderOrder: 9 });
    this.layer.mesh.name = 'vfx-kill-effects';
    this.layer.mesh.visible = false;
    fx.scene.add(this.layer.mesh);
  }

  update(_frame: Frame, dt: number): void {
    this.time += dt;
    for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i]!.until <= this.time) this.live.splice(i, 1);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i]!;
      if (q.at > this.time) continue;
      this.pending.splice(i, 1);
      if (q.phase === 'swirl') this.swirl(q.effect, q.x, q.y);
      else this.sparkles(q.effect, q.x, q.y, Math.floor(q.effect.sparkles.count / 2));
    }
    if (!this.layer) return;
    this.pool.update(dt);
    // the swirl's motes round their spiral, widening a little as they rise
    const d = this.pool.data;
    const tags = this.pool.tags!;
    for (let i = 0; i < this.pool.count; i++) {
      if (tags[i]! % 4 !== SWIRL) continue;
      const effect = killEffects[tags[i]! >> 2];
      if (!effect) continue;
      const o = i * STRIDE;
      const age = d[o + F.age]!;
      const life = d[o + F.life]!;
      const turn = (Math.PI * 2 * effect.swirl.turns * age) / life;
      d[o + F.x] = d[o + F.nx]! + effect.swirl.radiusM * (0.7 + 0.3 * (age / life)) * Math.sin(d[o + F.ny]! + turn);
    }
    this.layer.begin();
    this.layer.addPool(this.pool);
    this.layer.end();
    this.layer.mesh.visible = this.pool.count > 0;
  }

  /** A new map: nothing carries over. */
  clear(): void {
    this.pool.clear();
    this.live.length = 0;
    this.pending.length = 0;
  }

  dispose(): void {
    if (!this.layer) return;
    this.layer.mesh.removeFromParent();
    this.layer.dispose();
  }
}
