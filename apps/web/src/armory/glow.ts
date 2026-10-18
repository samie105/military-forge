/**
 * Glow panels: energy weapons mark their lenses, cells, coils and pilot rings with a `_GLOW` vertex
 * attribute (build_weapons.py), and their vertex colour is added as emission, so they read lit in
 * any lighting. A camo keeps the glow (camoMaterial re-applies this patch for `userData.glow`).
 * The reference for the in-match renderer; the Armory uses it as is.
 */
import type { Material, MeshStandardMaterial } from 'three';

type Shader = Parameters<Material['onBeforeCompile']>[0];

/** emission = vertex colour × this on `_GLOW` panels */
export const GLOW_STRENGTH = 1.4;

export function patchGlow(shader: Shader): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float _glow;\nvarying float vGlow;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = _glow;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vGlow;')
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * ${GLOW_STRENGTH.toFixed(2)};`,
    );
}

/** A copy of `material` whose `_GLOW` panels glow; only for meshes that have the attribute. */
export function glowMaterial(material: MeshStandardMaterial): MeshStandardMaterial {
  const m = material.clone();
  m.userData.glow = true;
  m.onBeforeCompile = (shader) => patchGlow(shader);
  m.customProgramCacheKey = () => 'glow';
  return m;
}
