/**
 * Kill effects (docs/17 §3.7, docs/04 §7): a skin line's top tier (the K-47 Galaxy Relic's "stardust") plays where
 * the victim falls, on kills with that gun, for everyone who can see the spot. Nothing on the wire: the death event
 * names the killer and the weapon, and the killer's look (the ROSTER's) says whether that gun carries an effect.
 *
 * What it draws, inside the victim's body envelope (the base body box +10%) and for ≤ 1 s:
 * - the body: it collapses and dissolves as every death does, its colour mixing toward the effect's tint (a uniform
 *   on the soldier's own material: no draw call, no light; avatar.ts killEffect);
 * - the stardust: up to 80 quads from the shared VFX atlas in one instanced, alpha-blended, depth-tested layer set
 *   just behind the body, so the dropped weapon, pickups, players and tracers (and the HUD and nameplates, which are
 *   on top of the canvas) all draw over it at full brightness. No flash, no shake, no light, no sound of its own.
 *
 * The still variant (Reduce flashes, Reduce motion, the Low preset, or a fifth effect at once): the body's flat
 * tint fade only, no particles. "Show other players' kill effects" off: only your own kills play one.
 */
import { KILL_EFFECT_LIMITS, killEffectOf, weapons, type CosmeticLoadout, type KillEffectDef } from '@military-forge/content';
import { DamageSource, type SimEvent } from '@military-forge/sim';
import { Color } from 'three';
import { reduceFlashes } from '../../fx';
import type { Frame } from '../../view';
import { ATLAS_GRID, Cell, vfxAtlas } from './atlas';
import type { VfxContext, VfxModule } from './index';
import { ParticleLayer } from './particles';
import { ParticlePool, particleSpec, type ParticleSpec } from './pool';
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
  /** the victim's drawn body: where its feet are, and the hook that tints it as it dissolves */
  body(id: number): { x: number; y: number; killEffect(colour: Color, seconds: number): void } | null;
}

/** One effect playing: when it ends, and whether it drew particles. */
interface Live {
  until: number;
  particles: boolean;
}

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
  private readonly pool = new ParticlePool(KILL_EFFECT_LIMITS.maxParticles * KILL_EFFECT_LIMITS.maxLive);
  private layer: ParticleLayer | null = null;
  private readonly live: Live[] = [];
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
      body.killEffect(this.colour(still ? effect.still.tint : effect.bodyTint), still ? effect.still.durationS : effect.durationS);
      this.live.push({ until: this.time + effect.durationS, particles: !still });
      if (!still) this.dust(effect, body.x, body.y, fx);
    }
  }

  /** The stardust: quads through the body's box, fading in as it dissolves and drifting up, all inside the envelope. */
  private dust(effect: KillEffectDef, x: number, y: number, fx: VfxContext): void {
    this.ensureLayer(fx);
    const env = KILL_EFFECT_LIMITS.envelopeMul;
    const half = BODY_HALF_WIDTH * env;
    const top = y + BODY_HEIGHT * env;
    const count = Math.min(KILL_EFFECT_LIMITS.maxParticles, effect.particles);
    for (let i = 0; i < count; i++) {
      const p = Object.assign(this.spec, this.base);
      const life = effect.durationS * (0.55 + 0.45 * this.rand());
      const size = 0.05 + 0.05 * this.rand();
      const rise = effect.rise * (0.5 + 0.5 * this.rand());
      // start low enough that the drift (and the quad's half size) ends under the envelope's top
      p.x = x + (this.rand() * 2 - 1) * (half - size);
      p.y = Math.min(y + 0.1 + this.rand() * BODY_HEIGHT * 0.95, top - rise - size);
      p.z = DUST_Z;
      p.vx = (this.rand() * 2 - 1) * 0.05;
      p.vy = rise / life;
      p.life = life;
      p.size0 = size;
      p.size1 = size * 0.4;
      p.spin = (this.rand() * 2 - 1) * 2;
      p.fadeIn = 0.35;
      p.alpha = 0.9;
      p.ramp = Ramp.Book;
      p.cell = this.rand() < 0.6 ? (effect.atlasCell === 'star' ? Cell.Star : Cell.Dot) : Cell.Dot;
      const c = this.colour(effect.palette[Math.floor(this.rand() * effect.palette.length)]!);
      p.tr = c.r;
      p.tg = c.g;
      p.tb = c.b;
      this.pool.emit(p);
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
    if (!this.layer) return;
    this.pool.update(dt);
    this.layer.begin();
    this.layer.addPool(this.pool);
    this.layer.end();
    this.layer.mesh.visible = this.pool.count > 0;
  }

  /** A new map: nothing carries over. */
  clear(): void {
    this.pool.clear();
    this.live.length = 0;
  }

  dispose(): void {
    if (!this.layer) return;
    this.layer.mesh.removeFromParent();
    this.layer.dispose();
  }
}
