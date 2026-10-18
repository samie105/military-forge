/**
 * Weapon crates on the map (the owner's "more guns"; sim pickups.ts): the gun itself, its W8 model
 * once loaded (the avatar kit's placeholder until then), standing upright over the spot, muzzle up
 * and its side to the camera, like a gun on a rack (the test armory's are 0.8 m apart, too close
 * for long guns lying flat). It bobs and turns a little so it reads as something to grab, over a
 * faint disc in its tier's colour (power weapons gold).
 */
import { pickups, weapons } from '@military-forge/content';
import { CircleGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { PickupView } from '../view';
import { crateColor } from '../weaponItems';
import type { AvatarKit } from './avatar';

/** socket space → world: the muzzle (+Y) up, the top (+Z) to +X, the gun's side toward the camera */
const UPRIGHT = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(1, 0, 0)));
/** height of the gun's lowest point (a stock, below the grip) over the spot (m), and its size: a little over life-size, so it reads as a pickup */
const HOVER = 0.15;
const SCALE = 1.15;
const TURN = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);

interface Item {
  group: Group;
  gun: Mesh;
  def: number;
  /** the grip's height that puts the gun's lowest point HOVER over the spot */
  lift: number;
}

export class WeaponItems {
  readonly group = new Group();
  private readonly items = new Map<number, Item>();
  private readonly discGeo = new CircleGeometry(0.42, 24).rotateX(-Math.PI / 2);
  private readonly discs = new Map<string, MeshBasicMaterial>();
  private time = 0;

  constructor(private readonly kit: AvatarKit) {
    this.group.name = 'weapon-items';
  }

  private disc(color: string): MeshBasicMaterial {
    let m = this.discs.get(color);
    if (!m) {
      m = new MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false });
      this.discs.set(color, m);
    }
    return m;
  }

  sync(views: readonly PickupView[] | undefined, dt: number): void {
    this.time += dt;
    const seen = new Set<number>();
    for (const k of views ?? []) {
      const def = pickups[k.def];
      if (def?.kind !== 'weapon' || def.weapon === undefined) continue;
      seen.add(k.id);
      // the model in the kit (the GLB once it has loaded, a placeholder until then)
      const model = this.kit.weapon(def.weapon);
      let item = this.items.get(k.id);
      if (item && (item.def !== def.weapon || item.gun.geometry !== model.geometry)) {
        item.group.removeFromParent();
        item = undefined;
      }
      if (!item) {
        const group = new Group();
        const gun = new Mesh(model.geometry, model.material);
        gun.scale.setScalar(SCALE);
        gun.castShadow = true;
        const glow = new Mesh(this.discGeo, this.disc(crateColor(weapons[def.weapon]!)));
        glow.position.y = 0.02;
        group.add(gun, glow);
        if (!model.geometry.boundingBox) model.geometry.computeBoundingBox();
        item = { group, gun, def: def.weapon, lift: HOVER - Math.min(0, model.geometry.boundingBox!.min.y) * SCALE };
        this.items.set(k.id, item);
        this.group.add(group);
      }
      item.group.position.set(k.x, k.y, 0);
      // the grip (the model's origin) over the spot, the muzzle up; bobbing, turning a little
      item.gun.quaternion.copy(UPRIGHT).premultiply(TURN.setFromAxisAngle(Y_AXIS, 0.35 * Math.sin(this.time * 1.2 + k.id)));
      item.gun.position.set(0, item.lift + 0.05 * Math.sin(this.time * 2.4 + k.id), 0);
    }
    for (const [id, item] of this.items) {
      if (seen.has(id)) continue;
      item.group.removeFromParent();
      this.items.delete(id);
    }
  }

  get count(): number {
    return this.items.size;
  }

  dispose(): void {
    this.discGeo.dispose();
    for (const m of this.discs.values()) m.dispose();
    this.group.removeFromParent();
  }
}
