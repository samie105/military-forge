/**
 * The 3D view's chunk (main.ts imports it dynamically through view3d/index.ts's stand-in): three.js,
 * render3d and the character assembler. Nothing here runs until the page asks for 3D (audit 28 Oct).
 */
import type { MapDef } from '@military-forge/content';
import { DefaultLoadingManager, WebGLRenderer } from 'three';
import { assetLoad } from '../assetLoad';
import { CharacterAssembler } from '../character';
import { create3d, type PlaneCamera, type Renderer3D } from '../render3d';
import type { LoadoutDirectory } from '../render3d/loadouts';
import type { GraphicsPreset } from '../render3d/presets';
import type { PortraitGl } from '../portrait';

// the map loading screen's real progress: every GLTF, texture and KTX2 the 3D view loads, from its first
assetLoad.attach(DefaultLoadingManager);

/** One assembler for the 3D view and the portraits: they share its geometry and part caches. */
export const soldiers = new CharacterAssembler();

/** The 3D view on the page's canvas (Renderer3D's arguments, with this chunk's assembler), or null when WebGL fails to start. */
export function start3d(canvas: HTMLCanvasElement, camera: PlaneCamera, map: MapDef, preset: GraphicsPreset, showStats: boolean, allowSoftware: boolean, loadouts: LoadoutDirectory): Renderer3D | null {
  return create3d(canvas, camera, map, preset, showStats, soldiers, allowSoftware, loadouts);
}

/**
 * What the portraits draw with: the 3D view's WebGL context, or (a page drawing in 2D) a context of
 * their own, made on the first picture.
 */
export function portraitGl(view: Renderer3D | null): PortraitGl {
  return { renderer: view?.renderer ?? new WebGLRenderer({ antialias: false, alpha: true }), assembler: soldiers };
}
