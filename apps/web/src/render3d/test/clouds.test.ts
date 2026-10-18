import { EMP, FLASHBANG, FRAG, GAS, MINE, SMOKE, pickups, type MapDef } from '@military-forge/content';
import { CollisionWorld, MineState, type SimEvent } from '@military-forge/sim';
import { DataTexture, Mesh, Scene, Sprite, SpriteMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { setReduceFlashes } from '../../fx';
import { cloudView } from '../../grenadeViews';
import type { CloudView, Frame } from '../../view';
import { CloudLayer, flashPop, MINE_CALM_HZ, mineLight, puffTexture, reachMask } from '../clouds';
import type { VfxContext } from '../vfx';
import { F, ParticlePool, STRIDE } from '../vfx/pool';

function frame(clouds: CloudView[], grenades: Frame['grenades'] = []): Frame {
  return { tick: 0, localId: 0, players: [], grenades, clouds };
}

const sprites = (layer: CloudLayer) => {
  const out: Sprite[] = [];
  layer.group.traverse((o) => {
    if (o instanceof Sprite && o.visible) out.push(o);
  });
  return out;
};

describe('cloud layer (smoke, gas, non-frag grenades)', () => {
  it('puffs are soft discs: opaque in the middle, clear at the rim', () => {
    const t = puffTexture(32);
    const data = t.image.data as Uint8Array;
    const alpha = (x: number, y: number) => data[(y * 32 + x) * 4 + 3]!;
    expect(alpha(16, 16)).toBeGreaterThan(200);
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(16, 1)).toBeLessThan(40);
  });

  it('builds puffs per cloud, follows its size and density, and drops it when it is gone', () => {
    const scene = new Scene();
    const layer = new CloudLayer(scene);
    const smoke = cloudView(3, SMOKE.index, 20, 1, 300)!;
    const gas = cloudView(4, GAS.index, 40, 1, 300)!;
    layer.update(frame([smoke, gas]), 1 / 60);
    const all = sprites(layer);
    expect(all.length).toBeGreaterThan(20);
    // smoke is dense and mostly in front of the plane (it covers players at z = 0); gas is a haze
    const smokePuffs = all.filter((s) => Math.abs(s.position.x - 20) < smoke.radius);
    const gasPuffs = all.filter((s) => Math.abs(s.position.x - 40) < gas.radius);
    expect(smokePuffs.filter((s) => s.position.z > 0.3).length).toBeGreaterThan(smokePuffs.length / 3);
    const opacity = (s: Sprite) => (s.material as SpriteMaterial).opacity;
    expect(Math.min(...smokePuffs.map(opacity))).toBeGreaterThan(0.6);
    expect(Math.max(...gasPuffs.map(opacity))).toBeLessThan(0.4);
    // puffs fill out the cloud's radius; the core covers the part that blocks sight
    for (const s of smokePuffs) expect(s.scale.x).toBeGreaterThan(0.5 * smoke.radius);
    expect(Math.max(...smokePuffs.map((s) => s.scale.x))).toBeGreaterThanOrEqual(2 * smoke.opaque);
    for (const s of all) expect(Math.abs(s.position.z)).toBeLessThan(1); // behind the terrain's front face

    // thinning out: fainter
    layer.update(frame([cloudView(3, SMOKE.index, 20, 1, 60 * 11)!, gas]), 1 / 60);
    expect(Math.max(...sprites(layer).filter((s) => s.position.x < 30).map(opacity))).toBeLessThan(0.4);

    layer.update(frame([gas]), 1 / 60);
    expect(sprites(layer).every((s) => s.position.x > 30)).toBe(true);
    layer.update(frame([]), 1 / 60);
    expect(sprites(layer)).toHaveLength(0);
  });

  it('a reused cloud slot with another type is a new cloud', () => {
    const layer = new CloudLayer(new Scene());
    layer.update(frame([cloudView(1, SMOKE.index, 10, 1, 100)!]), 1 / 60);
    const before = sprites(layer).length;
    layer.update(frame([cloudView(1, GAS.index, 10, 1, 5)!]), 1 / 60);
    expect(sprites(layer).length).not.toBe(before);
  });

  it('draws grenades other than frags (render3d-b draws those), in their own colours', () => {
    const layer = new CloudLayer(new Scene());
    layer.update(
      frame(
        [],
        [
          { x: 1, y: 2, fuse: 30, type: FRAG.index },
          { x: 3, y: 4, fuse: 30, type: SMOKE.index },
          { x: 5, y: 6, fuse: 30, type: GAS.index },
        ],
      ),
      1 / 60,
    );
    const balls: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh && o.visible) balls.push(o);
    });
    expect(balls.map((b) => [b.position.x, b.position.y])).toEqual([
      [3, 4],
      [5, 6],
    ]);
    layer.update(frame([], []), 1 / 60);
    expect(layer.group.children.filter((o) => o instanceof Mesh && o.visible)).toHaveLength(0);
    layer.dispose();
  });

  it('mines are pucks whose light shows their state; armed ones blink', () => {
    expect(mineLight(MineState.Flying, 0)).toBe(0x3fb950);
    expect(mineLight(MineState.Arming, 0)).toBe(0xd29922);
    // the Forge's spec: armed blinks 4 Hz, a triggered mine beeps 8 Hz; 3 Hz at most when calm
    expect(mineLight(MineState.Armed, 0)).not.toBe(mineLight(MineState.Armed, 0.13));
    expect(mineLight(MineState.Armed, 0)).toBe(mineLight(MineState.Armed, 0.12));
    expect(mineLight(MineState.Triggered, 0)).not.toBe(mineLight(MineState.Triggered, 1 / 16 + 0.001));
    expect(mineLight(MineState.Armed, 0, MINE_CALM_HZ)).toBe(mineLight(MineState.Armed, 0.16, MINE_CALM_HZ));
    expect(mineLight(MineState.Armed, 0, MINE_CALM_HZ)).not.toBe(mineLight(MineState.Armed, 0.17, MINE_CALM_HZ));
    expect(mineLight(MineState.Triggered, 0, MINE_CALM_HZ)).toBe(mineLight(MineState.Triggered, 0.16, MINE_CALM_HZ));
    const layer = new CloudLayer(new Scene());
    layer.update(
      frame(
        [],
        [
          { x: 1, y: 0.12, fuse: 0, type: MINE.index, state: MineState.Armed },
          { x: 2, y: 3, fuse: 30, type: EMP.index },
        ],
      ),
      1 / 60,
    );
    const visible: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh && o.visible && o.parent?.visible !== false) visible.push(o);
    });
    expect(visible.length).toBe(3); // the puck, its light (and its glow sprite), the EMP ball
    layer.update(frame([], []), 1 / 60);
    const left: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh && o.visible && o.parent?.visible !== false) left.push(o);
    });
    expect(left).toHaveLength(0);
  });
});

describe('cloud layer: walls, and the flashbang and EMP bursts (review)', () => {
  /** a flat floor and a thin wall at x 12 (0.2 m) from the floor up */
  const walled: MapDef = {
    id: 'walled',
    name: 'walled',
    bounds: { minX: -2, minY: -6, maxX: 40, maxY: 20 },
    solids: [{ points: [-2, -6, 40, -6, 40, 0, -2, 0] }, { points: [12, 0, 12.2, 0, 12.2, 10, 12, 10] }],
    oneWays: [],
    spawns: [{ x: 5, y: 0 }],
    dummies: [],
    labels: [],
  };

  it('a cloud a thin wall cuts is masked off past the wall (the sim bounds it there); an open one isn\'t masked', () => {
    const world = new CollisionWorld(walled);
    const mask = reachMask(world, 10, 1, SMOKE.cloud.radius)!;
    expect(mask).not.toBeNull();
    const data = mask.texture.image.data as Uint8Array;
    const n = mask.texture.image.width;
    const at = (x: number, y: number) => {
      const i = Math.floor((x - mask.rect.x) * mask.rect.z * n);
      const j = Math.floor((y - mask.rect.y) * mask.rect.w * n);
      return data[j * n + i]!;
    };
    expect(at(10, 1)).toBe(255); // the centre
    expect(at(8, 2)).toBe(255); // this side of the wall
    expect(at(13, 1)).toBe(0); // past it
    expect(at(13.5, 3)).toBe(0);
    expect(reachMask(world, 30, 12, SMOKE.cloud.radius)).toBeNull(); // nothing in reach (floors count: they bound it too)
  });

  it('every puff samples its cloud\'s mask in world space', () => {
    const layer = new CloudLayer(new Scene());
    const world = new CollisionWorld(walled);
    layer.update(frame([cloudView(1, SMOKE.index, 10, 1, 300)!]), 1 / 60, { world } as VfxContext);
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: 'void main() {\n\tmvPosition.xy += rotatedPosition;\n}', fragmentShader: 'void main() {\n\t#include <alphamap_fragment>\n}' };
    const puff = sprites(layer).find((s) => s.position.x !== 0)!;
    (puff.material as SpriteMaterial).onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('vCloudXY = modelMatrix[ 3 ].xy + rotatedPosition;');
    expect(shader.fragmentShader).toContain('texture2D( cloudMask');
    expect((shader.uniforms.cloudMask as { value: DataTexture }).value.image.width).toBe(64); // a real mask: the wall cuts it
    layer.dispose();
  });

  it('a flashbang is a small pop and a ring; an EMP a blue ring to its radius; a frag nothing here (review M7)', () => {
    const glow = new ParticlePool(256);
    const smoke = new ParticlePool(64);
    const fx = { glow, smoke, detail: 1 } as unknown as VfxContext;
    const layer = new CloudLayer(new Scene());
    const boom = (grenade: number, radius: number): SimEvent => ({ type: 'explosion', x: 10, y: 2, radius, owner: 0, grenade });
    layer.onEvents([boom(FRAG.index, 4)], fx);
    expect(glow.count).toBe(0); // render3d-b's blast
    layer.onEvents([boom(FLASHBANG.index, FLASHBANG.flash.fullRadius)], fx);
    expect(glow.count).toBe(3);
    const size1 = (i: number) => glow.data[i * STRIDE + F.size1]!;
    // never screen-sized: the pop stays a couple of metres, the ring marks the full-white radius
    expect(size1(0)).toBeLessThan(3);
    expect(size1(2)).toBeCloseTo(2.24 * FLASHBANG.flash.fullRadius, 5);
    const before = glow.count;
    layer.onEvents([boom(EMP.index, EMP.emp.radius)], fx);
    expect(glow.count - before).toBeGreaterThanOrEqual(6);
    // the ring and its echo are alpha-blended (they read on a bright sky), blue, out to the radius
    expect(smoke.count).toBe(3);
    expect(smoke.data[F.size1]!).toBeCloseTo(2.24 * EMP.emp.radius, 5);
    expect(smoke.data[F.tb]!).toBeGreaterThan(smoke.data[F.tr]!);
    expect(size1(before)).toBeCloseTo(2.24 * EMP.emp.radius, 5);
  });

  it('"Reduce flashes" greys the flashbang\'s pop', () => {
    const glow = new ParticlePool(64);
    const fx = { glow, detail: 1 } as unknown as VfxContext;
    setReduceFlashes(true);
    try {
      flashPop(fx, 0, 0, 4);
      expect(glow.data[F.alpha]!).toBeLessThan(0.5);
      expect(glow.data[F.tr]!).toBeLessThan(0.6);
    } finally {
      setReduceFlashes(false);
    }
  });
});

describe('grenade pairs on the map (pickups)', () => {
  it('a grenade pair is two canisters in its type\'s colour; the shield meshes leave it alone', () => {
    const layer = new CloudLayer(new Scene());
    const pair = pickups.find((p) => p.kind === 'grenades' && p.grenade === SMOKE.index)!;
    const f = { ...frame([]), pickups: [{ id: 7, def: pair.index, x: 10, y: 0 }, { id: 8, def: 0, x: 20, y: 0 }] };
    layer.update(f, 1 / 60);
    const canisters: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh && o.visible && Math.abs(o.getWorldPosition(new Vector3()).x - 10) < 0.5) canisters.push(o);
    });
    expect(canisters).toHaveLength(2);
    layer.update({ ...f, pickups: [] }, 1 / 60);
    const left: Mesh[] = [];
    layer.group.traverse((o) => {
      if (o instanceof Mesh && o.visible) left.push(o);
    });
    expect(left).toHaveLength(0);
    layer.dispose();
  });
});
