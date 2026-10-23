/**
 * Dash afterimages (docs/02 §21): frozen, tinted copies of a dashing character's pose that fade
 * behind it. A copy shares the character's geometry and keeps its own bone matrices, copied from
 * the final pose (aim included), so it costs a draw call per character mesh while it shows.
 * Medium and High keep a few (`max`); Low none.
 */
import { Color, Group, MeshBasicMaterial, Skeleton, SkinnedMesh, type Scene } from 'three';
import type { CharacterInstance } from '../character';

/** seconds an afterimage takes to fade */
export const GHOST_LIFE = 0.28;
/** a dashing character leaves one this often (s) when 4 may show; fewer allowed, spaced wider */
export const GHOST_EVERY = 0.035;
const GHOST_OPACITY = 0.42;
const WARM_TINT = new Color(1, 1, 1);

/** A skeleton whose pose was copied in: the renderer's per-frame update leaves it as it is. */
class FrozenSkeleton extends Skeleton {
  override update(): void {}
}

interface Ghost {
  readonly group: Group;
  readonly material: MeshBasicMaterial;
  meshes: SkinnedMesh[];
  /** the character its meshes copy (rebuilt for another) */
  source: Pick<CharacterInstance, 'meshes'> | null;
  age: number;
}

export type GhostSource = Pick<CharacterInstance, 'root' | 'meshes'>;

export class DashGhosts {
  /** how many may show at once (graphics preset: 0 on Low) */
  max = 4;
  private readonly ghosts: Ghost[] = [];

  constructor(private readonly scene: Scene) {}

  /** seconds between a dashing character's afterimages, for `max` of them */
  get every(): number {
    return (GHOST_EVERY * 4) / Math.max(1, this.max);
  }

  /** afterimages showing */
  get count(): number {
    let n = 0;
    for (const g of this.ghosts) if (g.group.visible) n++;
    return n;
  }

  /** A copy of `inst`'s pose right now, tinted `color`, fading over GHOST_LIFE. */
  snap(inst: GhostSource, color: Color): void {
    if (this.max <= 0) return;
    const g = this.slot();
    if (g.source !== inst) this.rebuild(g, inst);
    inst.root.updateMatrixWorld(true);
    for (let i = 0; i < inst.meshes.length; i++) {
      const src = inst.meshes[i]!.skeleton;
      const dst = g.meshes[i]!.skeleton;
      src.update();
      if (src.boneMatrices && dst.boneMatrices) dst.boneMatrices.set(src.boneMatrices.subarray(0, src.bones.length * 16));
      if (dst.boneTexture) dst.boneTexture.needsUpdate = true;
    }
    g.material.color.copy(color);
    g.material.opacity = GHOST_OPACITY;
    g.age = 0;
    g.group.visible = true;
  }

  update(dt: number): void {
    for (const g of this.ghosts) {
      if (!g.group.visible) continue;
      g.age += dt;
      const k = 1 - g.age / GHOST_LIFE;
      if (k <= 0) g.group.visible = false;
      else g.material.opacity = GHOST_OPACITY * k * k;
    }
  }

  /**
   * One afterimage of `inst` whatever `max` is (the warm-up draws its skinned, see-through material
   * once, so neither the first dash nor a later tier with afterimages builds it mid-game); clear() hides it.
   */
  showForWarmUp(inst: GhostSource): void {
    const max = this.max;
    this.max = Math.max(1, max);
    this.snap(inst, WARM_TINT);
    this.max = max;
  }

  /** Hides them all (a new map, a preset with none). */
  clear(): void {
    for (const g of this.ghosts) g.group.visible = false;
  }

  dispose(): void {
    for (const g of this.ghosts) {
      for (const m of g.meshes) m.skeleton.dispose();
      g.material.dispose();
      g.group.removeFromParent();
    }
    this.ghosts.length = 0;
  }

  /** The oldest showing once `max` show, else a hidden one, else a new one. */
  private slot(): Ghost {
    let oldest: Ghost | null = null;
    let free: Ghost | null = null;
    let showing = 0;
    for (const g of this.ghosts) {
      if (!g.group.visible) {
        free ??= g;
        continue;
      }
      showing++;
      if (!oldest || g.age > oldest.age) oldest = g;
    }
    if (oldest && showing >= this.max) return oldest;
    if (free) return free;
    // pushed back a hair in depth: where an afterimage still covers the character (the dash's first
    // frames), the character wins instead of being washed over
    const material = new MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    const g: Ghost = { group: new Group(), material, meshes: [], source: null, age: 0 };
    g.group.name = 'vfx-ghost';
    this.scene.add(g.group);
    this.ghosts.push(g);
    return g;
  }

  /** Its meshes copy `inst`'s: the same geometry, bound like it, posed by a frozen skeleton. */
  private rebuild(g: Ghost, inst: GhostSource): void {
    for (const m of g.meshes) {
      m.skeleton.dispose();
      m.removeFromParent();
    }
    g.meshes = inst.meshes.map((src) => {
      const m = new SkinnedMesh(src.geometry, g.material);
      m.bind(new FrozenSkeleton(src.skeleton.bones, src.skeleton.boneInverses), src.bindMatrix);
      m.bindMode = src.bindMode;
      m.frustumCulled = false;
      return m;
    });
    if (g.meshes.length) g.group.add(...g.meshes);
    g.source = inst;
  }
}
