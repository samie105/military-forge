/**
 * Bodies (the character creator, owner 22 Oct): one rig per base body (content's body_female is built
 * on the female body), and an instance that swaps body in place.
 */
import { AnimationMixer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_COSMETIC_LOADOUT, type CosmeticLoadout } from '@military-forge/content';
import { CharacterAssembler, bodyOfLoadout } from '../../src/character';
import { JOINTS, fakeSource, type FakeBody } from './fakeRig';

const female: CosmeticLoadout = { ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, bodyType: 'body_female' } };
const make = (body: FakeBody | null) => new CharacterAssembler({ source: fakeSource(body) });

describe('CharacterAssembler: bodies', () => {
  it('reads the body from the body type', () => {
    expect(bodyOfLoadout(DEFAULT_COSMETIC_LOADOUT)).toBe('male');
    expect(bodyOfLoadout(female)).toBe('female');
  });

  it("builds a female soldier on the female rig, sharing the male clip library when it has none", async () => {
    const a = make({ height: 0.95 });
    const c = await a.create(female);
    expect(c.body).toBe('female');
    expect(c.bone('head')!.position.y).toBeCloseTo(0.99 * 0.95, 5);
    expect(c.clips.map((clip) => clip.name)).toEqual(['idle', 'walk']);
    const male = await a.create(null);
    expect(male.body).toBe('male');
    expect(male.meshes[0]!.geometry).not.toBe(c.meshes[0]!.geometry);
  });

  it('a body with its own clip library uses it', async () => {
    const c = await make({ anims: true }).create(female);
    expect(c.clips.map((clip) => clip.name)).toEqual(['idle_f']);
  });

  it('swaps body in place: the same root, bones and mesh on the new bind pose, in the new rig\'s joint order', async () => {
    const reversed = [...JOINTS].reverse();
    const a = make({ height: 0.9, joints: reversed });
    const c = await a.create(null);
    const root = c.root;
    const head = c.bone('head')!;
    const mesh = c.meshes[0]!;
    const mixer = new AnimationMixer(root);
    mixer.clipAction(c.clips[0]!).play();
    await c.setLoadout(female);
    expect(c.body).toBe('female');
    expect(c.root).toBe(root);
    expect(c.bone('head')).toBe(head);
    expect(c.meshes[0]).toBe(mesh);
    expect(head.position.y).toBeCloseTo(0.99 * 0.9, 5);
    expect(mesh.skeleton.bones.map((b) => b.name)).toEqual(reversed);
    expect(mesh.skeleton.bones[0]).toBe(c.bone(reversed[0]!));
    mixer.update(0.1); // still bound
    await c.setLoadout(DEFAULT_COSMETIC_LOADOUT);
    expect(c.body).toBe('male');
    expect(head.position.y).toBeCloseTo(0.99, 5);
    expect(mesh.skeleton.bones.map((b) => b.name)).toEqual(JOINTS);
  });

  it("draws the male body while the female body's art isn't there, and says so", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = await make(null).create(female);
    expect(c.body).toBe('male');
    expect(c.loadout.items.bodyType).toBe('body_female');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("female body's art isn't available"), expect.anything());
    warn.mockRestore();
  });

  it('refuses a rig with bones this soldier lacks, keeping its body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // the female rig has a bone the male soldier's skeleton doesn't: the male instance can't take it
    const a = make({ joints: [...JOINTS, 'ponytail_1'] });
    const c = await a.create(null);
    await c.setLoadout(female);
    expect(c.body).toBe('male');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ponytail_1'));
    // created as female, it has that bone
    expect((await a.create(female)).bone('ponytail_1')).not.toBeNull();
    warn.mockRestore();
  });
});
