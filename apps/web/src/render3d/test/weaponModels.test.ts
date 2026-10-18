import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry, DataTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Uint16BufferAttribute, Vector3, type Texture } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OFFHAND, parseSockets, weaponFromGltf, type GunMaterials } from '../weaponModels';

describe('weapon models', () => {
  it('reads the muzzle and off-hand nodes from a weapon GLB (and falls back without them)', () => {
    const root = new Group();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.02, -0.1, 0, 0.02, 0.5, 0.05, 0, 0.3, -0.02]), 3));
    root.add(new Mesh(g));
    const muzzle = new Group();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0.576, 0.06);
    const offhand = new Group();
    offhand.name = 'offhand';
    offhand.position.set(-0.05, 0.07, -0.03);
    root.add(muzzle, offhand);
    const material = new MeshBasicMaterial();
    const model = weaponFromGltf({ scene: root } as unknown as GLTF, material)!;
    expect(model.muzzle.toArray()).toEqual(new Vector3(0, 0.576, 0.06).toArray());
    expect(model.offhand.toArray()).toEqual(new Vector3(-0.05, 0.07, -0.03).toArray());
    expect(model.material).toBe(material);
    root.remove(muzzle, offhand);
    const bare = weaponFromGltf({ scene: root } as unknown as GLTF, material)!;
    expect(bare.muzzle.y).toBeCloseTo(0.5); // the barrel's tip
    expect(bare.offhand.toArray()).toEqual(DEFAULT_OFFHAND.toArray());
  });
});

describe('scanned guns and scripted guns (art review H2)', () => {
  /** A one-triangle gun: vertex colours, or a scan's UVs and albedo, with camo panels either way. */
  function gun(kind: 'scan' | 'scripted' | 'bare') {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0.05, 0.4, 0, 0, 0.3, 0.05]), 3));
    g.setAttribute('_camo', new BufferAttribute(new Float32Array([1, 0, 1]), 1));
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    if (kind === 'scan') g.setAttribute('uv', new Uint16BufferAttribute([0, 0, 65535, 0, 0, 65535], 2, true)); // quantised, normalised
    if (kind === 'scripted') g.setAttribute('color', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3));
    const root = new Group();
    root.add(new Mesh(g, new MeshStandardMaterial(kind === 'scan' ? { map } : {})));
    return { gltf: { scene: root } as unknown as GLTF, map };
  }
  const vertexColors = new MeshBasicMaterial();
  const plain = new MeshBasicMaterial();
  const made: Texture[] = [];
  const materials: GunMaterials = {
    vertexColors,
    plain,
    textured: (map) => {
      made.push(map);
      return new MeshBasicMaterial({ map });
    },
  };

  it('a scan keeps its albedo on a material of its own, its UVs and its camo panels', () => {
    const { gltf, map } = gun('scan');
    const model = weaponFromGltf(gltf, materials)!;
    expect(made).toContain(map);
    expect((model.material as MeshBasicMaterial).map).toBe(map);
    const uv = model.geometry.getAttribute('uv');
    expect([uv.getX(1), uv.getY(2)]).toEqual([1, 1]); // denormalised
    expect(Array.from(model.geometry.getAttribute('_camo').array)).toEqual([1, 0, 1]);
  });

  it('a scripted gun keeps its vertex colours; a gun with neither is plain, never black', () => {
    expect(weaponFromGltf(gun('scripted').gltf, materials)!.material).toBe(vertexColors);
    expect(weaponFromGltf(gun('bare').gltf, materials)!.material).toBe(plain);
  });
});

describe('moving-part child meshes stay on the gun (#73, #82)', () => {
  /** A scanned gun as the Forge ships it: the body mesh with `part_*` meshes as its children, at their pivots. */
  function partGun() {
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const material = new MeshStandardMaterial({ map });
    const tri = (y: number) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array([0, y, 0, 0.05, y + 0.1, 0, 0, y + 0.05, 0.05]), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 3));
      g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
      return g;
    };
    const body = new Mesh(tri(0), material);
    body.name = 'breacher';
    const pump = new Mesh(tri(0), material);
    pump.name = 'part_pump';
    pump.position.set(0, 0.4, -0.045);
    pump.userData = { axis: [0, -1, 0], travel: 0.06 };
    const mag = new Mesh(tri(0), material);
    mag.name = 'part_mag';
    mag.position.set(0, 0.2, -0.16);
    body.add(pump, mag);
    const root = new Group();
    root.add(body);
    return { gltf: { scene: root } as unknown as GLTF, map };
  }

  it('the body and every part, each where it rests, with the gun’s textured material', () => {
    const { gltf, map } = partGun();
    const made: Texture[] = [];
    const model = weaponFromGltf(gltf, { vertexColors: new MeshBasicMaterial(), plain: new MeshBasicMaterial(), textured: (m) => (made.push(m), new MeshBasicMaterial({ map: m })) })!;
    const pos = model.geometry.getAttribute('position');
    expect(pos.count).toBe(9); // body, pump and mag
    const ys = Array.from({ length: pos.count }, (_, i) => pos.getY(i));
    expect(Math.max(...ys)).toBeCloseTo(0.5); // the pump, 0.4 up the gun
    expect(Math.min(...Array.from({ length: pos.count }, (_, i) => pos.getZ(i)))).toBeCloseTo(-0.16); // the mag below
    expect(model.geometry.getAttribute('uv').count).toBe(9);
    expect(made).toEqual([map]);
  });

  it('a mesh whose attributes do not match the body’s is left out, not fatal', () => {
    const { gltf } = partGun();
    const odd = new BufferGeometry();
    odd.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    gltf.scene.add(new Mesh(odd));
    expect(weaponFromGltf(gltf, new MeshBasicMaterial())!.geometry.getAttribute('position').count).toBe(9);
  });
});

describe('sockets.json (the Forge)', () => {
  it('parses the shipped file: muzzle, off hand, eject, family and aim pose by weapon id', () => {
    const shipped = JSON.parse(readFileSync(new URL('../../../public/assets/weapons/sockets.json', import.meta.url), 'utf8'));
    const sockets = parseSockets(shipped);
    const k47 = sockets.get('k47')!;
    expect(k47.family).toBe('rifle');
    expect(k47.aimPose).toBe('rifle');
    expect(k47.hands).toBe(2);
    expect(k47.muzzle!.pos.toArray()).toEqual([0, 0.635, 0.011]); // the K-47 from generated images (#73), lowered in the hand
    expect(k47.muzzle!.dir.toArray()).toEqual([0, 1, 0]);
    expect(k47.offhand!.toArray()).toEqual([-0.05, 0.07, -0.03]);
    expect(sockets.get('machete')!.muzzle).toBeNull();
  });

  it('sockets.json wins over the GLB’s own nodes', () => {
    const root = new Group();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, -0.1, 0, 0, 0.6, 0.05, 0.02, 0.3, 0]), 3));
    root.add(new Mesh(g));
    const node = new Group();
    node.name = 'muzzle';
    node.position.set(0, 0.5, 0.05);
    root.add(node);
    const sockets = parseSockets({ weapons: { x: { sockets: { muzzle: { pos: [0, 0.58, 0.06], dir: [0, 1, 0], boreRadius: 0.02 }, offhand: { pos: [-0.05, 0.08, -0.02] } } } } }).get('x')!;
    const model = weaponFromGltf({ scene: root } as unknown as GLTF, new MeshBasicMaterial(), sockets)!;
    expect(model.muzzle.y).toBeCloseTo(0.58);
    expect(model.offhand.y).toBeCloseTo(0.08);
    expect(model.sockets!.muzzle!.boreRadius).toBe(0.02);
  });
});
