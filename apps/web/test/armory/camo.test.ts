import { MeshStandardMaterial, ShaderLib, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { camoFits, camoMaterial, type CamoDef, type CamoSheet } from '../../src/armory/camo';

type Shader = Parameters<MeshStandardMaterial['onBeforeCompile']>[0];

function compile(m: MeshStandardMaterial): Shader {
  const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader } as Shader;
  m.onBeforeCompile(shader, undefined as never);
  return shader;
}

const gold: CamoDef = { name: 'Gold', kind: 'finish', cell: 6, palette: ['#a87a24', '#cf9f37', '#efc964'], levels: 3, tileM: 0.3, metalness: 0.6, roughness: 0.32, weapons: ['hawk50'] };
const dune: CamoDef = { name: 'Dune', kind: 'camo', cell: 1, palette: ['#9c7f52', '#b59d6e', '#cbb78c'], levels: 3, tileM: 0.3 };
const sheet: CamoSheet = { patterns: 'camo_patterns.png', atlasSize: [1024, 512], cell: [256, 256], camos: { gold, dune } };

describe('weapon finishes', () => {
  it('sets metal and roughness on the camo panels only, and reflects the environment map', () => {
    const env = new Texture();
    const m = camoMaterial(new MeshStandardMaterial({ roughness: 0.7 }), new Texture(), sheet, gold, env) as MeshStandardMaterial;
    expect(m.envMap).toBe(env);
    expect(m.roughness).toBe(0.7); // the factory value stays for grips and steel
    const shader = compile(m);
    expect(shader.fragmentShader).toContain('metalnessFactor = camoMetal');
    expect((shader.uniforms.camoMetal as { value: number }).value).toBe(0.6);
  });

  it('leaves a plain camo matte, with no metal override', () => {
    const shader = compile(camoMaterial(new MeshStandardMaterial(), new Texture(), sheet, dune, new Texture()) as MeshStandardMaterial);
    expect((shader.uniforms.camoMetal as { value: number }).value).toBe(-1);
  });

  it('keeps the gold finish on the Hawk (docs/03), and camos on everything', () => {
    expect(camoFits(gold, 'hawk50')).toBe(true);
    expect(camoFits(gold, 'k47')).toBe(false);
    expect(camoFits(dune, 'k47')).toBe(true);
  });
});
