/**
 * The character material (docs/04 §5.4): one toon material for the merged soldier. Each vertex carries
 * the texture layer of the part it came from (`texLayer`: 0 = body, then one per art slot), and each layer has
 * its own dye albedo + mask from W8 (body 512², parts 256², so they can't share an array texture):
 *   color = albedo × lerp(1, primary, mask.r) × lerp(1, secondary, mask.g) × lerp(1, accent, mask.b)
 *           × lerp(1, 2 × skinTone, skinWeight)    (skin: body layer only, albedo alpha; skinMask.ts)
 *   emissive += team × mask.a
 * Dye colours are per layer, because each part has its own default dyes until the player picks one
 * (docs/04 §5.4); the assembler fills them. Every soldier shares one shader program: dyes, textures and
 * the team colour are uniforms, so recolouring or re-dressing never recompiles.
 */
import { Color, DataTexture, DoubleSide, MeshToonMaterial, NearestFilter, RGBAFormat, RedFormat, type Texture } from 'three';
import { SKIN_HEADROOM } from './skinMask';

/** Texture layers: 0 = body, 1… = W8's art slots (assembler.ts ART_SLOTS). */
export const DYE_LAYERS = 9;

/**
 * The layers one material samples. Two samplers a layer, plus the toon ramp, must stay within WebGL2's 16 fragment
 * samplers (phones have exactly 16), so the soldier is drawn by two materials sharing every dye uniform: the body and
 * the first five art slots (13 samplers), and the garments, hair, top and legs (7). The merged geometry has one group
 * per material (assembler.ts build()).
 */
export const MAIN_LAYERS: readonly number[] = [0, 1, 2, 3, 4, 5];
export const GARMENT_LAYERS: readonly number[] = [6, 7, 8];

let toonRamp: DataTexture | null = null;

/**
 * Three-step toon ramp shared by everything toon-shaded: soldiers in the Locker and in game, the gameplay
 * plane, the guns (art/README.md art-style test).
 */
export function characterToonRamp(): DataTexture {
  if (!toonRamp) {
    toonRamp = new DataTexture(new Uint8Array([110, 190, 255]), 3, 1, RedFormat);
    toonRamp.minFilter = toonRamp.magFilter = NearestFilter;
    toonRamp.generateMipmaps = false;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

let blank: { albedo: DataTexture; mask: DataTexture } | null = null;
/** 1×1 stand-ins bound to unused layers (white albedo, no dye). */
function blankLayer(): { albedo: DataTexture; mask: DataTexture } {
  if (!blank) {
    const tex = (rgba: number[]) => {
      const t = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat);
      t.needsUpdate = true;
      return t;
    };
    blank = { albedo: tex([255, 255, 255, 0]), mask: tex([0, 0, 0, 0]) };
  }
  return blank;
}

export interface DyeColours {
  /** the player's chosen colours (what the Locker shows); the shader reads `layerColours` */
  readonly primary: Color;
  readonly secondary: Color;
  readonly accent: Color;
  readonly skin: Color;
  /** emissive glow through the mask's A channel; black = off */
  readonly team: Color;
}


/** A 4×4 ordered-dither threshold (Bayer) per screen pixel, for the dissolve. */
export const DISSOLVE_GLSL = `uniform float dyeDissolve;
float dyeBayer( vec2 p ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 i = ivec2( mod( p, 4.0 ) );
  return ( m[ i.x + i.y * 4 ] + 0.5 ) / 16.0;
}`;

/** The dissolve's test at the top of a fragment shader (a uniform branch: whole soldiers never take it). */
export function dissolveTest(uniform: string): string {
  return `if ( ${uniform} > 0.0 && dyeBayer( gl_FragCoord.xy ) < ${uniform} ) discard;`;
}

export class DyeMaterial extends MeshToonMaterial {
  readonly dye: DyeColours = { primary: new Color(1, 1, 1), secondary: new Color(1, 1, 1), accent: new Color(1, 1, 1), skin: new Color(1, 1, 1), team: new Color(0, 0, 0) };
  /** primary, secondary, accent per layer (layer × 3 + channel): the colours the shader multiplies in */
  readonly layerColours: readonly Color[] = Array.from({ length: DYE_LAYERS * 3 }, () => new Color(1, 1, 1));
  /** the body's own default dyes (primary, secondary, accent): skin texels keep them whatever the player picks */
  readonly bodyDefaults: readonly Color[] = Array.from({ length: 3 }, () => new Color(1, 1, 1));
  /**
   * Toon rim light: a hard-edged band on the silhouette's upper edges, the colour of the scene's rim light. The
   * Locker lights soldiers with a real rim light; in game, where the scene has none, this gives them the same pop
   * (render3d/lighting.ts picks colour and strength per map). Strength 0 = off.
   */
  readonly rim = { colour: new Color(0x7fb8ff), strength: { value: 0 } };
  /**
   * How far the soldier has dissolved (0 whole … 1 gone): an ordered-dither screen door, so a dying soldier fades
   * without turning transparent (that would be another shader program) (render3d/death.ts).
   */
  readonly dissolve = { value: 0 };
  /** the garment layers' material (hair, top, legs): the same dyes, rim and dissolve; set its layers through this one */
  readonly garments: DyeMaterial | null;
  /** the layers this material samples; the first is `map` (so three sets up vMapUv) */
  readonly layers: readonly number[];
  private readonly albedos: { value: Texture }[];
  private readonly masks: { value: Texture }[];

  /** `of`: the main material whose dye uniforms a garment material shares (internal: `garments` makes it) */
  constructor(of?: DyeMaterial) {
    // Double-sided: the generated meshes have a few flipped faces (art/README.md).
    super({ map: blankLayer().albedo, gradientMap: characterToonRamp(), side: DoubleSide });
    this.name = of ? 'character-dye-garments' : 'character-dye';
    this.layers = of ? GARMENT_LAYERS : MAIN_LAYERS;
    if (of) {
      // one set of colours for both: whatever recolours, rims or dissolves the soldier reaches the garments too
      Object.assign(this, { dye: of.dye, layerColours: of.layerColours, bodyDefaults: of.bodyDefaults, rim: of.rim, dissolve: of.dissolve });
    }
    this.albedos = Array.from({ length: DYE_LAYERS }, () => ({ value: blankLayer().albedo as Texture }));
    this.masks = Array.from({ length: DYE_LAYERS }, () => ({ value: blankLayer().mask as Texture }));
    this.garments = of ? null : new DyeMaterial(this);
    const [first, ...rest] = this.layers as [number, ...number[]];
    const uniforms: Record<string, { value: unknown }> = {
      dyeColours: { value: this.layerColours },
      dyeBodyDefaults: { value: this.bodyDefaults },
      dyeRimColour: { value: this.rim.colour },
      dyeRimStrength: this.rim.strength,
      dyeSkin: { value: this.dye.skin },
      dyeTeam: { value: this.dye.team },
      dyeDissolve: this.dissolve,
    };
    // the first layer's albedo is `map` itself (so three sets up vMapUv); the others get their own samplers
    for (const i of rest) uniforms[`dyeAlbedo${i}`] = this.albedos[i]!;
    for (const i of this.layers) uniforms[`dyeMask${i}`] = this.masks[i]!;
    const declared = [...rest.map((i) => `dyeAlbedo${i}`), ...this.layers.map((i) => `dyeMask${i}`)];
    const fetch = (i: number) =>
      `{ dyeAlb = textureGrad( ${i === first ? 'map' : `dyeAlbedo${i}`}, vMapUv, dyeDx, dyeDy ); dyeM = textureGrad( dyeMask${i}, vMapUv, dyeDx, dyeDy ); }`;
    // samplers can't be indexed by a varying in GLSL ES 3.0: branch per layer (the first, the body for the main one, last)
    const branches = rest.map((i) => `if ( dyeLayer == ${i} ) ${fetch(i)}\n          else `).join('') + fetch(first);
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float texLayer;\nvarying float vTexLayer;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTexLayer = texLayer;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D ${declared.join(', ')};
          uniform vec3 dyeColours[ ${DYE_LAYERS * 3} ], dyeBodyDefaults[ 3 ];
          uniform vec3 dyeSkin, dyeTeam, dyeRimColour;
          uniform float dyeRimStrength;
          varying float vTexLayer;
          ${DISSOLVE_GLSL}`,
        )
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${dissolveTest('dyeDissolve')}`)
        .replace(
          '#include <map_fragment>',
          // gradients from outside the branches: a 2×2 quad can straddle two parts
          `int dyeLayer = int( vTexLayer + 0.5 );
          vec2 dyeDx = dFdx( vMapUv ), dyeDy = dFdy( vMapUv );
          vec4 dyeAlb, dyeM;
          ${branches}
          float dyeSkinW = dyeLayer == 0 ? dyeAlb.a : 0.0;
          int dyeAt = dyeLayer * 3;
          vec3 dyeBy = mix( vec3( 1.0 ), dyeColours[ dyeAt ], dyeM.r ) * mix( vec3( 1.0 ), dyeColours[ dyeAt + 1 ], dyeM.g ) * mix( vec3( 1.0 ), dyeColours[ dyeAt + 2 ], dyeM.b );
          // skin never takes the player's dyes: where the body mask bleeds onto the face it keeps the painted look
          vec3 dyeDef = mix( vec3( 1.0 ), dyeBodyDefaults[ 0 ], dyeM.r ) * mix( vec3( 1.0 ), dyeBodyDefaults[ 1 ], dyeM.g ) * mix( vec3( 1.0 ), dyeBodyDefaults[ 2 ], dyeM.b );
          diffuseColor.rgb *= dyeAlb.rgb * mix( dyeBy, dyeDef, dyeSkinW ) * mix( vec3( 1.0 ), ${SKIN_HEADROOM.toFixed(1)} * dyeSkin, dyeSkinW );`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += dyeTeam * dyeM.a;')
        .replace(
          '#include <opaque_fragment>',
          // a band where the surface turns away from the camera, weighted to the upper edges (lit from above-behind)
          `float dyeRimF = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );
          outgoingLight += diffuseColor.rgb * dyeRimColour * dyeRimStrength * smoothstep( 0.62, 0.72, dyeRimF ) * smoothstep( -0.3, 0.5, normal.y );
          #include <opaque_fragment>`,
        );
    };
  }

  override customProgramCacheKey(): string {
    return `character-dye-v6-${this.layers.join('.')}`;
  }

  /** The material that draws `layer` (this one, or its garments'). */
  private owner(layer: number): DyeMaterial {
    return this.layers.includes(layer) || !this.garments ? this : this.garments;
  }

  /** The dye albedo + mask of one layer (either material's); null = unused (white, undyed). */
  setLayer(layer: number, albedo: Texture | null, mask: Texture | null): void {
    const m = this.owner(layer);
    const b = blankLayer();
    if (layer === m.layers[0]) m.map = albedo ?? b.albedo;
    else m.albedos[layer]!.value = albedo ?? b.albedo;
    m.masks[layer]!.value = mask ?? b.mask;
  }

  /** Current albedo of a layer (tests, tooling). */
  layerAlbedo(layer: number): Texture | null {
    const m = this.owner(layer);
    const t = layer === m.layers[0] ? m.map : m.albedos[layer]!.value;
    return t === blankLayer().albedo ? null : t;
  }

  /** Both materials, in the merged geometry's group order (mesh.material). */
  get all(): DyeMaterial[] {
    return this.garments ? [this, this.garments] : [this];
  }

  override dispose(): void {
    this.garments?.dispose();
    super.dispose();
  }
}
