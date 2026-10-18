/**
 * Armory preview of the special-weapon effects (vfx/specials.vfx.json, art/pipeline/build_specials.py):
 * the Dragon's flame puffs, the Arc's beam, the Pulse's charge, orb and EMP burst, the Ripper's blade,
 * the Popper's and Thumper's rounds in flight, and the riot shield's ricochets, cracks and break.
 * The stage is about 2 m across, so the preview slows speeds (× SPEED) and shrinks reaches bigger than
 * the stage (× REACH); things at the weapon keep their size. The in-match renderer reads the same
 * manifest at full speed and size.
 */
import {
  AdditiveBlending,
  type Blending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Object3D,
  PlaneGeometry,
  type PointLight,
  type Quaternion,
  RepeatWrapping,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { LightPool } from './lights';

/** preview speed scale: a 7 m/s flame or an 8 m/s orb would leave the stage in a blink */
export const SPEED = 0.15;
/** preview reach scale for radii bigger than the stage (the 2.5 m EMP burst) */
export const REACH = 0.3;
/** how far a projectile flies in the preview before it ends (or bursts): it stays on the stage */
export const PREVIEW_FLIGHT_M = 0.6;
/** the beam's length in the preview (it really reaches 52 m) */
export const BEAM_PREVIEW_M = 1.6;

interface AtlasDef {
  texture: string;
  size: [number, number];
  cell: [number, number];
  cells?: Record<string, number>;
}
interface FlipbookDef {
  atlas: string;
  firstCell?: number;
  cells?: string[];
  cellM?: number;
  fps: number;
  frames?: number;
  loop?: boolean;
}
interface SpriteDef {
  atlas: string;
  cell: string;
  blend: 'additive' | 'normal';
  originU?: number;
}
interface Tinted {
  sprite?: string;
  tint?: string;
  sizeM?: number;
}
export interface SpecialStyle {
  kind: 'flame' | 'beam' | 'orb' | 'blade' | 'grenade' | 'rocket' | 'shield';
  lifeS?: number;
  speedMps?: number;
  spawnEveryS?: number;
  puffsPerSpawn?: number;
  sizeM?: number;
  widthM?: number;
  uvPerM?: number;
  scrollMps?: number;
  projectile?: string;
  light?: { color: string; intensity: number; rangeM: number };
  pilot?: { socket: string; sprite: string; sizeM: number };
  startGlow?: Tinted;
  endFlare?: { sprite: string; sizeM: number; spinDegPerS: number };
  charge?: { socket: string; chargeS: number; sprite?: string; tint?: string; sizeM?: [number, number] };
  trail?: Tinted & { everyMs?: number; lifeMs?: number };
  burst?: { radiusM: number; shockwave: { texture: string; tint: string; ms: number } };
  ricochet?: { spark: { sprite: string; sizeM: number; ms: number }; streak: { sprite: string; lengthM: number; widthM: number; ms: number } };
  cracks?: { belowHpFraction: number; sprite: string }[];
}
export interface SpecialsManifest {
  atlases: Record<string, AtlasDef>;
  flipbooks: Record<string, FlipbookDef>;
  sprites: Record<string, SpriteDef>;
  beam: { texture: string };
  projectiles: { glb: string };
  styles: Record<string, SpecialStyle>;
}

/** Where the effect starts, in the viewer's holder frame. */
export interface SpecialAnchors {
  /** the muzzle (or, for a shield, the face) */
  from: Vector3;
  /** the way it fires, unit */
  dir: Vector3;
  up: Vector3;
  sockets: Record<string, Vector3>;
  face?: { pos: Vector3; normal: Vector3; up: Vector3; halfSize: [number, number] };
  /** weapon (or shield) frame → holder frame, for projectile meshes modelled in the muzzle frame */
  toView: Quaternion;
}

/** UV offset and repeat of atlas cell `index` (row-major from the top left) for a flipY texture. */
export function cellUv(size: [number, number], cell: [number, number], index: number): { offset: [number, number]; repeat: [number, number] } {
  const cols = Math.round(size[0] / cell[0]);
  const cx = (index % cols) * cell[0];
  const cy = Math.floor(index / cols) * cell[1];
  return { offset: [cx / size[0], 1 - (cy + cell[1]) / size[1]], repeat: [cell[0] / size[0], cell[1] / size[1]] };
}

/** The frame of a `frames`-long flipbook at time t: over `lifeS` (clamped to the last), or looping at fps. */
export function flipFrame(frames: number, t: number, opts: { lifeS?: number; fps?: number; loop?: boolean }): number {
  if (opts.lifeS) return Math.min(frames - 1, Math.max(0, Math.floor((frames * t) / opts.lifeS)));
  const f = Math.floor(t * (opts.fps ?? 16));
  return opts.loop ? ((f % frames) + frames) % frames : Math.min(frames - 1, Math.max(0, f));
}

/** How far past the muzzle a style's preview reaches (m), so the Armory can frame it. */
export function previewReach(m: SpecialsManifest, st: SpecialStyle): number {
  switch (st.kind) {
    case 'flame':
      return (st.speedMps ?? 7) * SPEED * (st.lifeS ?? 0.8) + ((m.flipbooks.flame?.cellM ?? 1.5) * 0.5) / 2;
    case 'beam':
      return BEAM_PREVIEW_M;
    case 'orb':
      return PREVIEW_FLIGHT_M + (st.burst?.radiusM ?? 0) * REACH;
    case 'shield':
      return 0;
    default:
      return PREVIEW_FLIGHT_M + 0.15;
  }
}

interface Fx {
  /** advance to t (seconds since start); false when finished */
  update(t: number, dt: number): boolean;
  dispose(): void;
}

const ease = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k));

export class SpecialsPreview {
  private readonly textures = new Map<string, Texture>();
  private projectiles: Object3D | null = null;
  private running: { fx: Fx; t: number }[] = [];
  private frozen = false;
  private shield: { hp: number; decal: Mesh | null; scrapes: Mesh[] } = { hp: 1, decal: null, scrapes: [] };

  constructor(
    private readonly parent: Object3D,
    private readonly base: string,
    private readonly loader: GLTFLoader,
    /** the viewer's fixed point lights, in `parent`'s space (lights.ts) */
    private readonly lights: LightPool,
  ) {}

  /** Play `styleId`; with `freezeS`, run to that moment and hold it (QA screenshots). */
  async play(m: SpecialsManifest, styleId: string, at: SpecialAnchors, opts: { holdMs?: number; freezeS?: number } = {}): Promise<void> {
    const st = m.styles[styleId];
    if (!st) return;
    this.frozen = false;
    const holdS = Math.max(0.9, (opts.holdMs ?? 0) / 1000);
    await this.preload(m, st);
    this.running.push({ fx: this.build(m, st, at, holdS), t: 0 });
    if (opts.freezeS !== undefined) {
      for (let t = 0; t < opts.freezeS; t += 1 / 60) this.update(1 / 60);
      this.frozen = true;
    }
  }

  update(dt: number): void {
    if (this.frozen) return;
    this.running = this.running.filter((r) => {
      r.t += dt;
      if (r.fx.update(r.t, dt)) return true;
      r.fx.dispose();
      return false;
    });
  }

  /** effects still on stage (a frozen one counts) */
  busy(): boolean {
    return this.running.length > 0;
  }

  /** stop everything and forget the shield's damage (a new weapon) */
  clear(): void {
    for (const r of this.running) r.fx.dispose();
    this.running = [];
    this.frozen = false;
    this.setCrack(null, null);
    for (const s of this.shield.scrapes) this.drop(s);
    this.shield = { hp: 1, decal: null, scrapes: [] };
  }

  dispose(): void {
    this.clear();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
  }

  // ------------------------------------------------------------------ building blocks

  /** every texture (and the projectile meshes) a style needs, so effects build and run synchronously */
  private async preload(m: SpecialsManifest, st: SpecialStyle): Promise<void> {
    const files = [...Object.values(m.atlases).map((a) => a.texture), m.beam.texture];
    if (st.burst) files.push(st.burst.shockwave.texture);
    await Promise.all(
      files
        .filter((f) => !this.textures.has(f))
        .map(async (f) => {
          const t = await new TextureLoader().loadAsync(this.base + f);
          t.colorSpace = SRGBColorSpace;
          this.textures.set(f, t);
        }),
    );
    if (st.projectile && !this.projectiles) this.projectiles = (await this.loader.loadAsync(this.base + m.projectiles.glb)).scene;
  }

  private texture(file: string): Texture {
    return this.textures.get(file)!;
  }

  /** a camera-facing quad showing one atlas cell; `frame()` moves it to another cell of the atlas */
  private cellSprite(m: SpecialsManifest, atlasId: string, cell: number, blend: 'additive' | 'normal', tint?: string) {
    const a = m.atlases[atlasId]!;
    const map = this.texture(a.texture).clone();
    const mat = new SpriteMaterial({ map, transparent: true, depthWrite: false, blending: blendOf(blend), toneMapped: false });
    if (tint) mat.color = new Color(tint);
    const s = new Sprite(mat);
    const frame = (i: number) => {
      const uv = cellUv(a.size, a.cell, i);
      map.offset.set(...uv.offset);
      map.repeat.set(...uv.repeat);
    };
    frame(cell);
    return { s, frame };
  }

  private namedSprite(m: SpecialsManifest, name: string, tint?: string): Sprite {
    const d = m.sprites[name]!;
    const r = this.cellSprite(m, d.atlas, m.atlases[d.atlas]!.cells![d.cell]!, d.blend, tint);
    if (d.originU !== undefined) r.s.center.set(d.originU, 0.5);
    return r.s;
  }

  private add(o: Object3D): void {
    this.parent.add(o);
  }

  private drop(o: Object3D): void {
    this.parent.remove(o);
    if (o instanceof Sprite || o instanceof Mesh) {
      if (o instanceof Mesh) o.geometry.dispose();
      const mat = o.material as SpriteMaterial | MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  }

  private light(def: { color: string; intensity: number; rangeM: number } | undefined, at: Vector3): PointLight | null {
    return this.lights.take(def, at);
  }

  /** short-lived sprites (trails, sparks, shards) owned by one effect */
  private particles() {
    const list: { s: Sprite; born: number; life: number; v: Vector3; grow: [number, number]; fade: boolean; spin: number }[] = [];
    return {
      push: (s: Sprite, born: number, life: number, v = new Vector3(), grow: [number, number] = [s.scale.x, s.scale.x], fade = true, spin = 0) => {
        this.add(s);
        list.push({ s, born, life, v, grow, fade, spin });
      },
      update: (t: number, dt: number, gravity = 0) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i]!;
          const k = (t - p.born) / p.life;
          if (k >= 1) {
            this.drop(p.s);
            list.splice(i, 1);
            continue;
          }
          p.v.y -= gravity * dt;
          p.s.position.addScaledVector(p.v, dt);
          p.s.scale.setScalar(ease(p.grow[0], p.grow[1], k));
          (p.s.material as SpriteMaterial).rotation += p.spin * dt;
          if (p.fade) (p.s.material as SpriteMaterial).opacity = 1 - k;
        }
        return list.length;
      },
      dispose: () => {
        for (const p of list) this.drop(p.s);
        list.length = 0;
      },
    };
  }

  // ------------------------------------------------------------------ effects by kind

  private build(m: SpecialsManifest, st: SpecialStyle, at: SpecialAnchors, holdS: number): Fx {
    switch (st.kind) {
      case 'flame':
        return this.flame(m, st, at, holdS);
      case 'beam':
        return this.beam(m, st, at, holdS);
      case 'orb':
        return this.orb(m, st, at);
      case 'blade':
      case 'grenade':
      case 'rocket':
        return this.round(m, st, at);
      case 'shield':
        return this.shieldHit(m, st, at);
    }
  }

  private flame(m: SpecialsManifest, st: SpecialStyle, at: SpecialAnchors, holdS: number): Fx {
    const book = m.flipbooks.flame!;
    const life = st.lifeS ?? 0.8;
    const every = (st.spawnEveryS ?? 0.15) / (st.puffsPerSpawn ?? 3);
    // the flipbook already grows the puff (0.15 → 0.6 m); the preview draws it at half size
    const size = (book.cellM ?? 1.5) * 0.5;
    const puffs: { s: Sprite; frame: (i: number) => void; born: number; drift: Vector3 }[] = [];
    let next = 0;
    const pilotAt = at.sockets[st.pilot?.socket ?? ''];
    const pilot = st.pilot && pilotAt ? this.namedSprite(m, st.pilot.sprite) : null;
    if (pilot && pilotAt) {
      pilot.position.copy(pilotAt);
      pilot.scale.setScalar(st.pilot!.sizeM * 2);
      this.add(pilot);
    }
    const light = this.light(st.light, at.from);
    const spawn = (born: number) => {
      const p = this.cellSprite(m, book.atlas, book.firstCell ?? 0, 'normal');
      p.s.position.copy(at.from);
      (p.s.material as SpriteMaterial).rotation = Math.random() * Math.PI * 2;
      const drift = at.dir.clone().multiplyScalar((st.speedMps ?? 7) * SPEED).addScaledVector(at.up, 0.12);
      this.add(p.s);
      puffs.push({ ...p, born, drift });
    };
    return {
      update: (t, dt) => {
        while (t < holdS && next <= t) {
          spawn(next);
          next += every;
        }
        for (let i = puffs.length - 1; i >= 0; i--) {
          const p = puffs[i]!;
          const age = t - p.born;
          if (age >= life) {
            this.drop(p.s);
            puffs.splice(i, 1);
            continue;
          }
          p.frame((book.firstCell ?? 0) + flipFrame(book.frames ?? 16, age, { lifeS: life }));
          p.s.position.addScaledVector(p.drift, dt);
          p.s.scale.setScalar(size);
        }
        if (light) light.intensity = (st.light?.intensity ?? 3) * (0.8 + 0.2 * Math.sin(t * 57)) * (t < holdS ? 1 : 0);
        if (pilot) pilot.scale.setScalar(st.pilot!.sizeM * 2 * (0.9 + 0.1 * Math.sin(t * 88)));
        return t < holdS + life;
      },
      dispose: () => {
        for (const p of puffs) this.drop(p.s);
        if (pilot) this.drop(pilot);
        this.lights.give(light);
      },
    };
  }

  private beam(m: SpecialsManifest, st: SpecialStyle, at: SpecialAnchors, holdS: number): Fx {
    const length = BEAM_PREVIEW_M;
    const uvPerM = st.uvPerM ?? 2.5;
    const map = this.texture(m.beam.texture).clone();
    map.wrapS = RepeatWrapping;
    map.repeat.set(length * uvPerM, 1);
    const mat = new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, toneMapped: false });
    const geo = new PlaneGeometry(length, st.widthM ?? 0.07).translate(length / 2, 0, 0);
    const strip = new Mesh(geo, mat);
    strip.add(new Mesh(geo, mat).rotateX(Math.PI / 2));
    strip.position.copy(at.from);
    strip.quaternion.setFromUnitVectors(new Vector3(1, 0, 0), at.dir);
    this.add(strip);
    const glow = st.startGlow?.sprite ? this.namedSprite(m, st.startGlow.sprite, st.startGlow.tint) : null;
    if (glow) {
      glow.position.copy(at.from);
      glow.scale.setScalar(st.startGlow!.sizeM ?? 0.14);
      this.add(glow);
    }
    const flare = st.endFlare ? this.namedSprite(m, st.endFlare.sprite) : null;
    if (flare) {
      flare.position.copy(at.from).addScaledVector(at.dir, length);
      flare.scale.setScalar(st.endFlare!.sizeM);
      this.add(flare);
    }
    const light = this.light(st.light, at.from);
    return {
      update: (t) => {
        map.offset.x = -t * (st.scrollMps ?? 9) * SPEED * uvPerM;
        strip.scale.y = 1 + 0.15 * Math.sin(t * Math.PI * 2 * 20);
        if (flare) (flare.material as SpriteMaterial).rotation = (t * (st.endFlare!.spinDegPerS * Math.PI)) / 180;
        return t < holdS;
      },
      dispose: () => {
        this.parent.remove(strip);
        geo.dispose();
        map.dispose();
        mat.dispose();
        if (glow) this.drop(glow);
        if (flare) this.drop(flare);
        this.lights.give(light);
      },
    };
  }

  private orb(m: SpecialsManifest, st: SpecialStyle, at: SpecialAnchors): Fx {
    const charge = st.charge;
    const chargeS = charge?.chargeS ?? 0.7;
    const speed = (st.speedMps ?? 8) * SPEED;
    const flyS = Math.min(1.0, PREVIEW_FLIGHT_M / speed);
    const chargeAt = at.sockets[charge?.socket ?? ''] ?? at.from;
    const glow = this.namedSprite(m, charge?.sprite ?? 'glow', charge?.tint);
    glow.position.copy(chargeAt);
    this.add(glow);
    const book = m.flipbooks.orb!;
    const a = m.atlases[book.atlas]!;
    const orb = this.cellSprite(m, book.atlas, a.cells![book.cells![0]!]!, 'additive');
    orb.s.visible = false;
    orb.s.scale.setScalar(st.sizeM ?? 0.24);
    this.add(orb.s);
    const trail = this.particles();
    let nextTrail = chargeS;
    const burstTex = st.burst ? this.texture(st.burst.shockwave.texture).clone() : null;
    const ring = burstTex ? new Sprite(new SpriteMaterial({ map: burstTex, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, color: new Color(st.burst!.shockwave.tint) })) : null;
    const burstS = (st.burst?.shockwave.ms ?? 280) / 1000;
    const light = this.light(st.light, chargeAt);
    const end = at.from.clone().addScaledVector(at.dir, speed * flyS);
    return {
      update: (t, dt) => {
        if (t < chargeS) {
          const [s0, s1] = charge?.sizeM ?? [0.03, 0.14];
          glow.scale.setScalar(ease(s0, s1, t / chargeS));
        } else {
          glow.visible = false;
        }
        if (t >= chargeS && t < chargeS + flyS) {
          const k = (t - chargeS) / flyS;
          orb.s.visible = true;
          orb.s.position.lerpVectors(at.from, end, k);
          orb.frame(a.cells![book.cells![flipFrame(book.cells!.length, t, { fps: book.fps, loop: true })]!]!);
          if (light) light.position.copy(orb.s.position);
          while (nextTrail <= t && st.trail?.sprite) {
            nextTrail += (st.trail.everyMs ?? 40) / 1000;
            const s = this.namedSprite(m, st.trail.sprite, st.trail.tint);
            s.position.copy(orb.s.position);
            trail.push(s, t, (st.trail.lifeMs ?? 240) / 1000, new Vector3(), [st.trail.sizeM ?? 0.14, 0.02]);
          }
        } else if (t >= chargeS + flyS) {
          orb.s.visible = false;
          if (ring && !ring.parent) {
            ring.position.copy(end);
            this.add(ring);
          }
          const k = (t - chargeS - flyS) / burstS;
          if (ring) {
            ring.scale.setScalar(ease(0.1, (st.burst?.radiusM ?? 2.5) * REACH * 2, k));
            (ring.material as SpriteMaterial).opacity = 1 - k;
          }
          if (light) light.intensity = (st.light?.intensity ?? 2) * 2.5 * Math.max(0, 1 - k);
        }
        trail.update(t, dt);
        return t < chargeS + flyS + burstS;
      },
      dispose: () => {
        this.drop(glow);
        this.drop(orb.s);
        trail.dispose();
        if (ring) this.drop(ring);
        this.lights.give(light);
      },
    };
  }

  /** the saw blade, the grenade round and the rocket: the mesh flying out of the muzzle with its trail */
  private round(m: SpecialsManifest, st: SpecialStyle, at: SpecialAnchors): Fx {
    const node = this.projectiles?.getObjectByName(`proj_${st.projectile ?? st.kind}`)?.clone();
    const chargeS = st.charge?.chargeS ?? 0;
    const flyS = 0.9;
    const speed = Math.min((st.speedMps ?? 14) * SPEED, PREVIEW_FLIGHT_M / flyS);
    const holder = new Group();
    holder.quaternion.copy(at.toView);
    if (node) holder.add(node);
    holder.visible = false;
    this.add(holder);
    const sparks = this.particles();
    let nextPuff = chargeS;
    const chargeAt = at.sockets[st.charge?.socket ?? ''];
    const spin = st.kind === 'blade' ? 3 : st.kind === 'grenade' ? 1.5 : 0.5; // turns/s, slowed for the eye
    return {
      update: (t, dt) => {
        if (t < chargeS && chargeAt && Math.random() < dt * 25) {
          const s = this.namedSprite(m, 'star4');
          s.position.copy(chargeAt);
          const v = new Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).multiplyScalar(0.8);
          sparks.push(s, t, 0.2, v, [0.06, 0.01]);
        }
        if (t >= chargeS && t < chargeS + flyS) {
          const k = t - chargeS;
          holder.visible = true;
          holder.position.copy(at.from).addScaledVector(at.dir, speed * k);
          if (st.kind === 'grenade') holder.position.addScaledVector(at.up, 0.6 * k - 0.5 * 9.81 * SPEED * k * k);
          node?.rotateOnAxis(new Vector3(st.kind === 'rocket' ? 0 : 1, st.kind === 'rocket' ? 1 : 0, 0), spin * Math.PI * 2 * dt);
          while (nextPuff <= t && st.trail) {
            nextPuff += (st.trail.everyMs ?? 40) / 1000;
            const sprite = st.trail.sprite ?? 'glow';
            const tint = st.trail.tint ?? (st.kind === 'rocket' ? '#cfcac0' : '#d9d4c8');
            const s = this.namedSprite(m, sprite, tint);
            s.position.copy(holder.position);
            (s.material as SpriteMaterial).opacity = 0.6;
            sparks.push(s, t, (st.trail.lifeMs ?? 300) / 1000, at.up.clone().multiplyScalar(0.1), [0.04, st.trail.sizeM ?? 0.12]);
          }
        } else if (t >= chargeS + flyS) {
          holder.visible = false;
        }
        const live = sparks.update(t, dt);
        return t < chargeS + flyS || live > 0;
      },
      dispose: () => {
        this.parent.remove(holder);
        sparks.dispose();
      },
    };
  }

  /** a stopped bullet: spark, streak, a scrape on the face; each hit costs HP until it breaks */
  private shieldHit(m: SpecialsManifest, st: SpecialStyle, at: SpecialAnchors): Fx {
    const face = at.face;
    const rc = st.ricochet;
    if (!face || !rc) return { update: () => false, dispose: () => {} };
    const right = new Vector3().crossVectors(face.up, face.normal).normalize();
    const hit = face.pos
      .clone()
      .addScaledVector(right, (Math.random() - 0.5) * face.halfSize[0])
      .addScaledVector(face.up, (Math.random() - 0.3) * face.halfSize[1])
      .addScaledVector(face.normal, 0.01);
    const parts = this.particles();
    const spark = this.namedSprite(m, rc.spark.sprite);
    spark.position.copy(hit);
    parts.push(spark, 0, rc.spark.ms / 1000, new Vector3(), [rc.spark.sizeM, rc.spark.sizeM * 0.6], true, 4);
    const streak = this.namedSprite(m, rc.streak.sprite);
    streak.position.copy(hit);
    (streak.material as SpriteMaterial).rotation = Math.PI * (0.15 + 0.2 * Math.random());
    parts.push(streak, 0, rc.streak.ms / 1000, new Vector3(), [rc.streak.lengthM, rc.streak.lengthM]);
    this.addScrape(m, face, hit);
    // HP: 300 → cracks by fraction → break, then a fresh shield
    this.shield.hp -= 0.24;
    const crack = [...(st.cracks ?? [])].reverse().find((c) => this.shield.hp < c.belowHpFraction);
    let broke = false;
    if (this.shield.hp <= 0) {
      broke = true;
      this.setCrack(null, null);
      for (const s of this.shield.scrapes) this.drop(s);
      this.shield = { hp: 1, decal: null, scrapes: [] };
      for (let i = 0; i < 10; i++) {
        const s = this.namedSprite(m, 'shard', i < 7 ? '#b8bcc0' : '#2b2d31');
        s.position.copy(face.pos).addScaledVector(right, (Math.random() - 0.5) * 0.4).addScaledVector(face.up, (Math.random() - 0.5) * 0.7);
        const v = face.normal.clone().multiplyScalar(0.6 + Math.random()).addScaledVector(right, Math.random() - 0.5).addScaledVector(face.up, Math.random());
        parts.push(s, 0, 1.1, v, [0.12, 0.08], true, 6 * (Math.random() - 0.5));
      }
    } else if (crack) {
      this.setCrack(m, crack.sprite, face);
    }
    return {
      update: (t, dt) => parts.update(t, dt, broke ? 9.81 * SPEED * 3 : 0) > 0,
      dispose: () => parts.dispose(),
    };
  }

  private addScrape(m: SpecialsManifest, face: NonNullable<SpecialAnchors['face']>, hit: Vector3): void {
    const d = m.sprites.scrape;
    if (!d) return;
    const a = m.atlases[d.atlas]!;
    const map = this.texture(a.texture).clone();
    const uv = cellUv(a.size, a.cell, a.cells![d.cell]!);
    map.offset.set(...uv.offset);
    map.repeat.set(...uv.repeat);
    const mesh = new Mesh(new PlaneGeometry(0.14, 0.14), new MeshBasicMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: false }));
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), face.normal);
    mesh.position.copy(hit).addScaledVector(face.normal, -0.007);
    mesh.rotateZ(0.3 * (Math.random() - 0.5)); // its +X is already along `right`
    this.add(mesh);
    this.shield.scrapes.push(mesh);
    if (this.shield.scrapes.length > 6) this.drop(this.shield.scrapes.shift()!);
  }

  /** the current crack decal on the face (null: none) */
  private setCrack(m: SpecialsManifest | null, sprite: string | null, face?: NonNullable<SpecialAnchors['face']>): void {
    if (this.shield.decal) {
      this.drop(this.shield.decal);
      this.shield.decal = null;
    }
    if (!m || !sprite || !face) return;
    const d = m.sprites[sprite]!;
    const a = m.atlases[d.atlas]!;
    const map = this.texture(a.texture).clone();
    const uv = cellUv(a.size, a.cell, a.cells![d.cell]!);
    map.offset.set(...uv.offset);
    map.repeat.set(...uv.repeat);
    const decal = new Mesh(
      new PlaneGeometry(face.halfSize[0] * 2, face.halfSize[1] * 2),
      new MeshBasicMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, toneMapped: false }),
    );
    // plane +Z → the face normal; its +Y stays the shield's up
    decal.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), face.normal);
    decal.position.copy(face.pos).addScaledVector(face.normal, 0.003);
    this.add(decal);
    this.shield.decal = decal;
  }
}

function blendOf(b: 'additive' | 'normal'): Blending {
  return b === 'additive' ? AdditiveBlending : NormalBlending;
}
