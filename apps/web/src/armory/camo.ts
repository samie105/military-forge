/**
 * Weapon camos (weapons/camos.json): a tileable pattern projected onto the panels a weapon marks
 * with its `_CAMO` vertex attribute (build_weapons.py), coloured from the camo's palette. Weapons
 * have no UVs, so the pattern is triplanar in the weapon's own frame. Grips, steel, the toy muzzle
 * tip and blades have `_CAMO` 0 and keep their colours, so a camo never hides a weapon's role.
 * The reference for the in-match renderer; the Armory uses it as is.
 */
import { Color, NearestFilter, type Material, type MeshStandardMaterial, type Texture, Vector2 } from 'three';
import { patchGlow } from './glow';

export interface CamoDef {
  name: string;
  /** a finish (gold, chrome, carbon) also sets metalness / roughness on the panels and reflects */
  kind?: 'camo' | 'finish';
  cell: number;
  /** sRGB hex, one colour per pattern level */
  palette: string[];
  levels: number;
  /** metres of weapon per pattern tile */
  tileM: number;
  metalness?: number;
  roughness?: number;
  /** weapon ids it is for (the gold finish is the Hawk's); absent = every weapon */
  weapons?: string[];
}

/** whether `camo` can go on weapon `id` */
export function camoFits(camo: CamoDef, id: string): boolean {
  return !camo.weapons || camo.weapons.includes(id);
}

export interface CamoSheet {
  patterns: string;
  atlasSize: [number, number];
  cell: [number, number];
  camos: Record<string, CamoDef>;
}

/** Nearest filtering and no mipmaps: the levels are indices, not colours to blend. */
export function prepareCamoPatterns(texture: Texture): Texture {
  texture.flipY = false;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A copy of `material` that paints its `_CAMO` panels with `camo`. A finish also sets metalness and
 * roughness on those panels only, and reflects `envMap` (without one, metal renders near-black).
 */
export function camoMaterial(material: MeshStandardMaterial, patterns: Texture, sheet: CamoSheet, camo: CamoDef, envMap?: Texture | null): Material {
  const m = material.clone();
  const finish = camo.kind === 'finish';
  if (finish && envMap) {
    m.envMap = envMap;
    m.envMapIntensity = 0.9;
  }
  const cols = sheet.atlasSize[0] / sheet.cell[0];
  const cellSize = new Vector2(sheet.cell[0] / sheet.atlasSize[0], sheet.cell[1] / sheet.atlasSize[1]);
  // flipY is false for this texture (see the viewer), so v runs down from the top like the image
  const cellOrigin = new Vector2((camo.cell % cols) * cellSize.x, Math.floor(camo.cell / cols) * cellSize.y);
  const palette = [0, 1, 2, 3].map((i) => new Color(camo.palette[Math.min(i, camo.palette.length - 1)]));
  const glow = material.userData.glow === true;
  m.onBeforeCompile = (shader) => {
    if (glow) patchGlow(shader);
    Object.assign(shader.uniforms, {
      camoMap: { value: patterns },
      camoCellOrigin: { value: cellOrigin },
      camoCellSize: { value: cellSize },
      camoTile: { value: camo.tileM },
      camoLevels: { value: camo.levels },
      camoPalette: { value: palette },
      camoMetal: { value: finish ? (camo.metalness ?? 0) : -1 },
      camoRough: { value: camo.roughness ?? 1 },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _camo;\nvarying float vCamo;\nvarying vec3 vCamoPos;\nvarying vec3 vCamoNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCamo = _camo;\nvCamoPos = position;\nvCamoNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D camoMap;
uniform vec2 camoCellOrigin;
uniform vec2 camoCellSize;
uniform float camoTile;
uniform float camoLevels;
uniform vec3 camoPalette[4];
uniform float camoMetal;
uniform float camoRough;
varying float vCamo;
varying vec3 vCamoPos;
varying vec3 vCamoNormal;
float camoLevel(vec2 p) {
  return texture2D(camoMap, camoCellOrigin + fract(p / camoTile) * camoCellSize).r;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (vCamo > 0.5) {
  vec3 w = pow(abs(normalize(vCamoNormal)), vec3(4.0));
  w /= w.x + w.y + w.z;
  // the dominant face's projection: crisp edges, no blending of indices
  float r = w.x > w.y && w.x > w.z ? camoLevel(vCamoPos.yz) : (w.y > w.z ? camoLevel(vCamoPos.xz) : camoLevel(vCamoPos.xy));
  int idx = int(floor(r * (camoLevels - 1.0) + 0.5));
  vec3 c = camoPalette[0];
  if (idx == 1) c = camoPalette[1];
  else if (idx == 2) c = camoPalette[2];
  else if (idx >= 3) c = camoPalette[3];
  diffuseColor.rgb = c;
}`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
// a finish: metal and roughness on the camo panels only (grips and steel keep the factory values)
if (vCamo > 0.5 && camoMetal >= 0.0) {
  metalnessFactor = camoMetal;
  roughnessFactor = camoRough;
}`,
      );
  };
  m.customProgramCacheKey = () => `camo:${camo.cell}:${glow}:${finish}`;
  return m;
}
