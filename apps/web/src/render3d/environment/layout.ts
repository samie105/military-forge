/**
 * Kit layouts: which kit piece goes where on a map. The art pipeline writes them
 * (art/maps/<map>/layout.json) and compiles the same file into the map's collision
 * (art/pipeline/compile_map.py → packages/content). The web build ships a copy next to the kit
 * (assets/kits/<kit>/<map>.layout.json). Placing pieces exactly the way compile_map.py places their
 * collision keeps what you see on the gameplay plane what you collide with (docs/11 §2).
 */
import { Matrix4 } from 'three';

/** the depth layers the map's grade applies to (grade.ts) */
export type GradedLayer = 'gameplay' | 'mid' | 'far';
/** `glow`: unlit and ungraded, drawn as authored (neon tubes, LED panels: Fog Stair's signs) */
export type KitLayer = GradedLayer | 'glow';

export interface LayoutItem {
  piece: string;
  x: number;
  y?: number;
  /** decor only: depth (gameplay pieces stand in the band around z = 0) */
  z?: number;
  /** mirrored about the piece's pivot (x → −x), as compile_map.py mirrors its collision */
  flip?: boolean;
  /** ad bezels (docs/14 §4.2): the slot this bezel shows */
  slotId?: string;
  phaseIdx?: number;
}

export interface KitLayout {
  id: string;
  name: string;
  /** the kit GLB, relative to assets/ */
  kit: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** gameplay pieces: they carry the map's collision */
  pieces: LayoutItem[];
  /** mid and far dressing, ad bezels and their structures: no collision */
  decor?: LayoutItem[];
  palette?: { sky: string; fog: string; farTint?: number };
}

/** Every placement of the layout, gameplay pieces first. */
export function layoutItems(layout: KitLayout): LayoutItem[] {
  return [...layout.pieces, ...(layout.decor ?? [])];
}

/** Piece space → world: mirror about the pivot when flipped, then move to (x, y, z). */
export function placementMatrix(item: LayoutItem, out = new Matrix4()): Matrix4 {
  return out.makeScale(item.flip ? -1 : 1, 1, 1).setPosition(item.x, item.y ?? 0, item.z ?? 0);
}

/** A piece's point (piece space) in the world, the way compile_map.py's place_poly maps collision. */
export function placePoint(item: LayoutItem, px: number, py: number): [number, number] {
  return [item.x + (item.flip ? -px : px), (item.y ?? 0) + py];
}
