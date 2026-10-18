import { MeshStandardMaterial, ShaderLib, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { camoMaterial, type CamoDef, type CamoSheet } from '../../src/armory/camo';
import { glowMaterial } from '../../src/armory/glow';

type Shader = Parameters<MeshStandardMaterial['onBeforeCompile']>[0];

function compile(m: MeshStandardMaterial): Shader {
  const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader } as Shader;
  m.onBeforeCompile(shader, undefined as never);
  return shader;
}

const camo: CamoDef = { name: 'Dune', cell: 1, palette: ['#9c7f52', '#b59d6e', '#cbb78c'], levels: 3, tileM: 0.3 };
const sheet: CamoSheet = { patterns: 'camo_patterns.png', atlasSize: [1024, 512], cell: [256, 256], camos: { dune: camo } };

describe('weapon glow panels', () => {
  it('adds the vertex colour as emission on `_glow` vertices', () => {
    const shader = compile(glowMaterial(new MeshStandardMaterial({ vertexColors: true })));
    expect(shader.vertexShader).toContain('attribute float _glow;');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += diffuseColor.rgb * vGlow');
  });

  it('survives a camo: the camo material re-applies the glow', () => {
    const glowing = camoMaterial(glowMaterial(new MeshStandardMaterial()), new Texture(), sheet, camo) as MeshStandardMaterial;
    const shader = compile(glowing);
    expect(shader.fragmentShader).toContain('vGlow');
    expect(shader.fragmentShader).toContain('camoPalette');
    expect(glowing.customProgramCacheKey()).not.toBe(camoMaterial(new MeshStandardMaterial(), new Texture(), sheet, camo).customProgramCacheKey());
  });

  it('leaves weapons without glow panels alone under a camo', () => {
    const shader = compile(camoMaterial(new MeshStandardMaterial(), new Texture(), sheet, camo) as MeshStandardMaterial);
    expect(shader.fragmentShader).not.toContain('vGlow');
  });
});
