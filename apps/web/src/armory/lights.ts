/**
 * A fixed pool of point lights for the Armory's muzzle flashes and special effects (review L11).
 * three.js compiles a program per light count, so a PointLight added and removed per shot recompiled
 * the weapon's shaders on every Fire, a hitch each time. These lights stay in the scene from the start;
 * a free one is dark (intensity 0), so the count never changes.
 */
import { PointLight, type ColorRepresentation, type Object3D, type Vector3 } from 'three';

/** a flash and two overlapping special effects (the flame's pilot and its stream) */
export const LIGHT_POOL_SIZE = 3;

export interface PoolLightDef {
  color: ColorRepresentation;
  intensity: number;
  rangeM: number;
}

export class LightPool {
  private readonly free: PointLight[] = [];
  readonly lights: readonly PointLight[];

  constructor(parent: Object3D, size = LIGHT_POOL_SIZE) {
    for (let i = 0; i < size; i++) {
      const l = new PointLight(0xffffff, 0, 1, 2);
      parent.add(l);
      this.free.push(l);
    }
    this.lights = [...this.free];
  }

  /** A lit light at `at` (in the pool parent's space), or null when all are in use: the effect plays unlit. */
  take(def: PoolLightDef | undefined, at: Vector3): PointLight | null {
    if (!def) return null;
    const l = this.free.pop();
    if (!l) return null;
    l.color.set(def.color);
    l.intensity = def.intensity;
    l.distance = def.rangeM;
    l.position.copy(at);
    return l;
  }

  /** Hand a light back: it goes dark and stays in the scene. */
  give(l: PointLight | null): void {
    if (!l || this.free.includes(l) || !this.lights.includes(l)) return;
    l.intensity = 0;
    this.free.push(l);
  }

  /** lights in use */
  busy(): number {
    return this.lights.length - this.free.length;
  }
}
