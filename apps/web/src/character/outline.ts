/**
 * The character outline (docs/04 §5.5, docs/11 "clean looks"): an inverted hull, the soldier's own skinned mesh
 * drawn again from the back, pushed out along its normals by a fixed number of *pixels*, so it reads the same
 * at gameplay zoom (a soldier is ~80 px tall at 1080p) and in the Locker's close-ups. One extra draw call per
 * soldier; the colour is a uniform (team colours later: docs/04 §1.4).
 */
import { BackSide, Color, MeshBasicMaterial, Vector2, type ColorRepresentation } from 'three';

/** Warm near-black: reads against sky and ground without the harshness of pure black. */
export const OUTLINE_COLOUR = '#1d1712';

export class OutlineMaterial extends MeshBasicMaterial {
  /** outline width in drawing-buffer pixels */
  readonly width: { value: number };
  /** how far the hull sits behind the body (m), so it never shows through the body's own faces */
  readonly back = { value: 0.03 };
  /** drawing-buffer size of the viewport this material is drawn into (its renderer keeps it current) */
  readonly viewport = { value: new Vector2(1280, 720) };

  constructor(colour: ColorRepresentation = OUTLINE_COLOUR, widthPx = 2) {
    super({ color: new Color(colour), side: BackSide });
    this.name = 'character-outline';
    this.width = { value: widthPx };
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { outlineWidth: this.width, outlineViewport: this.viewport, outlineBack: this.back });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float outlineWidth, outlineBack;\nuniform vec2 outlineViewport;')
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
          mvPosition.z -= outlineBack;
          gl_Position = projectionMatrix * mvPosition;
          #ifdef USE_SKINNING
            // the normal's direction on screen, in pixels; then that many pixels out. A BackSide material gets
            // FLIP_SIDED, which turns transformedNormal inward: turn it back out.
            #ifdef FLIP_SIDED
              vec3 outlineN = - transformedNormal;
            #else
              vec3 outlineN = transformedNormal;
            #endif
            vec2 outlineDir = ( projectionMatrix * vec4( normalize( outlineN ), 0.0 ) ).xy * outlineViewport;
            float outlineLen = length( outlineDir );
            if ( outlineLen > 1e-6 ) gl_Position.xy += outlineDir / outlineLen * outlineWidth * 2.0 / outlineViewport * gl_Position.w;
          #endif`,
        );
    };
  }

  override customProgramCacheKey(): string {
    return 'character-outline-v2';
  }

  /** Outline width in drawing-buffer pixels (CSS px × device pixel ratio). */
  setWidth(px: number): void {
    this.width.value = px;
  }

  /** The size of the viewport being drawn, in drawing-buffer pixels. */
  setViewport(width: number, height: number): void {
    this.viewport.value.set(Math.max(1, width), Math.max(1, height));
  }
}
