/**
 * The character material (docs/04 §5.4): a toon material whose albedo is tinted per channel,
 *   color = albedo × lerp(1, primary, mask.r) × lerp(1, secondary, mask.g) × lerp(1, accent, mask.b)
 *           × lerp(1, skinTone, albedo.a)
 *   emissive += team × mask.a
 * Textured vertices (texLayer ≥ 0) sample the albedo/mask textures; procedural placeholder parts
 * (texLayer < 0) carry their albedo in the vertex colour and their mask in the `dyeMask` attribute.
 * Dyes are uniforms, so recolouring never rebuilds geometry and every dye shares one shader program.
 */
import { Color, DataTexture, DoubleSide, MeshToonMaterial, NearestFilter, RedFormat, type Texture } from 'three';

let toonRamp: DataTexture | null = null;

/** Three-step toon ramp shared by every character. */
export function characterToonRamp(): DataTexture {
  if (!toonRamp) {
    toonRamp = new DataTexture(new Uint8Array([110, 190, 255]), 3, 1, RedFormat);
    toonRamp.minFilter = toonRamp.magFilter = NearestFilter;
    toonRamp.generateMipmaps = false;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

export interface DyeColours {
  readonly primary: Color;
  readonly secondary: Color;
  readonly accent: Color;
  readonly skin: Color;
  /** emissive glow through the mask's A channel; black = off */
  readonly team: Color;
}

export class DyeMaterial extends MeshToonMaterial {
  readonly dye: DyeColours = { primary: new Color(1, 1, 1), secondary: new Color(1, 1, 1), accent: new Color(1, 1, 1), skin: new Color(1, 1, 1), team: new Color(0, 0, 0) };
  private readonly maskUniform: { value: Texture };

  constructor(albedo: Texture, mask: Texture) {
    // Double-sided like the source GLB: decimated generator meshes have a few flipped faces.
    super({ map: albedo, gradientMap: characterToonRamp(), vertexColors: true, side: DoubleSide });
    this.name = 'character-dye';
    this.maskUniform = { value: mask };
    const d = this.dye;
    const uniforms = {
      dyeMaskMap: this.maskUniform,
      dyePrimary: { value: d.primary },
      dyeSecondary: { value: d.secondary },
      dyeAccent: { value: d.accent },
      dyeSkin: { value: d.skin },
      dyeTeam: { value: d.team },
    };
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 dyeMask;\nattribute float texLayer;\nvarying vec4 vDyeMask;\nvarying float vTexLayer;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDyeMask = dyeMask;\nvTexLayer = texLayer;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D dyeMaskMap;\nuniform vec3 dyePrimary, dyeSecondary, dyeAccent, dyeSkin, dyeTeam;\nvarying vec4 vDyeMask;\nvarying float vTexLayer;',
        )
        .replace(
          '#include <map_fragment>',
          `float dyeTextured = step( 0.0, vTexLayer );
          vec4 dyeAlbedo = mix( vec4( 1.0, 1.0, 1.0, 0.0 ), texture2D( map, vMapUv ), dyeTextured );
          vec4 dyeM = mix( vDyeMask, texture2D( dyeMaskMap, vMapUv ), dyeTextured );
          diffuseColor.rgb *= dyeAlbedo.rgb * mix( vec3( 1.0 ), dyePrimary, dyeM.r ) * mix( vec3( 1.0 ), dyeSecondary, dyeM.g )
            * mix( vec3( 1.0 ), dyeAccent, dyeM.b ) * mix( vec3( 1.0 ), dyeSkin, dyeAlbedo.a );`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += dyeTeam * dyeM.a;');
    };
  }

  override customProgramCacheKey(): string {
    return 'character-dye-v1';
  }

  /** Swaps the albedo + mask pair (LOD change). */
  setMaps(albedo: Texture, mask: Texture): void {
    this.map = albedo;
    this.maskUniform.value = mask;
  }
}
