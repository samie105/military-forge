import { ShaderLib, type WebGLProgramParametersWithUniforms } from 'three';
import { describe, expect, it } from 'vitest';
import { DyeMaterial, OutlineMaterial } from '../../src/character';

/** Runs a material's onBeforeCompile on three's own shader source, as the renderer would. */
function compiled(material: OutlineMaterial | DyeMaterial, lib: 'basic' | 'toon') {
  const shader = { uniforms: {}, vertexShader: ShaderLib[lib].vertexShader, fragmentShader: ShaderLib[lib].fragmentShader } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, undefined as never);
  return shader as unknown as { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string };
}

describe('character outline (inverted hull)', () => {
  it('pushes the back faces out by a fixed number of pixels, turning the FLIP_SIDED normal back outward', () => {
    const m = new OutlineMaterial();
    const s = compiled(m, 'basic');
    expect(s.vertexShader).toContain('outlineWidth * 2.0 / outlineViewport * gl_Position.w');
    expect(s.vertexShader).toMatch(/#ifdef FLIP_SIDED\s+vec3 outlineN = - transformedNormal;/);
    expect(s.vertexShader).not.toContain('#include <project_vertex>');
    m.setWidth(3);
    m.setViewport(1920, 810);
    expect(s.uniforms.outlineWidth!.value).toBe(3);
    expect((s.uniforms.outlineViewport!.value as { toArray(): number[] }).toArray()).toEqual([1920, 810]);
    expect(m.side).toBe(1); // BackSide
  });

  it('gives the dye material a rim light that is off until a renderer turns it on', () => {
    const m = new DyeMaterial();
    const s = compiled(m, 'toon');
    expect(m.rim.strength.value).toBe(0);
    expect(s.fragmentShader).toContain('dyeRimStrength');
    expect(s.fragmentShader).toMatch(/outgoingLight \+= diffuseColor\.rgb \* dyeRimColour/);
    m.rim.strength.value = 0.6;
    expect(s.uniforms.dyeRimStrength!.value).toBe(0.6);
  });
});
