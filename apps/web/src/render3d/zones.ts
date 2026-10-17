/**
 * Map zones in 3D (docs/02 §20, docs/11 §2). Each zone is a tinted volume through the gameplay band
 * (its outline extruded z −1…+1, no depth writes, so it tints what is behind and inside it) with a
 * bright rim on the front face, plus a few particles that show what it does: dust drifting in
 * zero-g and low-g, streaks along the wind or a pad's launch, bubbles rising in water, sparks
 * jittering in an EMP field. Event zones show only a faint rim until their event's warning (the rim
 * pulses: players see which site is about to open), then fill in. Purely cosmetic: Math.random is
 * fine here, nothing feeds back into the sim.
 */
import { ZONE_KINDS, resolveZone, zonePoints, type MapDef, type MapZone } from '@military-forge/content';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three';
import type { Frame } from '../view';
import { PLANE_BACK_Z, PLANE_FRONT_Z } from './mapGeometry';

/** volume opacity by state */
const FILL_ON = 0.07;
const RIM_ON = 0.85;
const RIM_OFF = 0.18;

type Motion = 'flow' | 'drift' | 'rise' | 'spark' | 'none';

interface ZoneItem {
  zone: MapZone;
  index: number;
  volume: Mesh<BufferGeometry, MeshBasicMaterial>;
  rim: LineLoop<BufferGeometry, LineBasicMaterial>;
  points: Points<BufferGeometry, PointsMaterial> | null;
  /** per particle: velocity x, y (m/s) */
  vel: Float32Array;
  motion: Motion;
  /** outline (for spawning particles inside it) and bounding box */
  outline: Vector2[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** eased 0 (off) → 1 (on); pending pulses the rim only */
  shown: number;
}

/** Point in polygon (even-odd), for placing particles. */
function inside(outline: readonly Vector2[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]!;
    const b = outline[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The outline extruded through the gameplay band: front, back and side walls. */
function volumeGeometry(outline: Vector2[]): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = outline.length;
  for (const z of [PLANE_FRONT_Z, PLANE_BACK_Z]) for (const p of outline) pos.push(p.x, p.y, z);
  for (const [a, b, c] of ShapeUtils.triangulateShape(outline, [])) {
    idx.push(a!, b!, c!);
    idx.push(n + c!, n + b!, n + a!);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, i, n + j, n + i);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}

function motionOf(zone: MapZone): Motion {
  const r = resolveZone(zone);
  if (r.launch || r.windX !== 0 || r.windY !== 0) return 'flow';
  switch (zone.kind) {
    case 'zeroG':
    case 'lowG':
    case 'damping':
      return 'drift';
    case 'reverseG':
    case 'water':
    case 'longFlight':
      return 'rise';
    case 'emp':
      return 'spark';
    default:
      return 'none';
  }
}

export class ZoneVolumes {
  readonly group = new Group();
  private readonly items: ZoneItem[] = [];

  constructor(map: MapDef) {
    this.group.name = 'map-zones';
    (map.zones ?? []).forEach((zone, index) => {
      const flat = zonePoints(zone);
      const outline: Vector2[] = [];
      for (let i = 0; i < flat.length; i += 2) outline.push(new Vector2(flat[i]!, flat[i + 1]!));
      if (ShapeUtils.isClockWise(outline)) outline.reverse();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of outline) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      const color = new Color(ZONE_KINDS[zone.kind]?.color ?? 0x8b949e);
      const volume = new Mesh(
        volumeGeometry(outline),
        new MeshBasicMaterial({ color, transparent: true, opacity: FILL_ON, depthWrite: false, side: DoubleSide }),
      );
      volume.renderOrder = 5;
      const rimGeometry = new BufferGeometry().setFromPoints(outline.map((p) => new Vector3(p.x, p.y, PLANE_FRONT_Z + 0.02)));
      const rim = new LineLoop(rimGeometry, new LineBasicMaterial({ color, transparent: true, opacity: RIM_ON, depthWrite: false }));
      rim.renderOrder = 6;
      this.group.add(volume, rim);

      const motion = motionOf(zone);
      let points: ZoneItem['points'] = null;
      let vel = new Float32Array(0);
      if (motion !== 'none') {
        const count = Math.max(10, Math.min(90, Math.round((maxX - minX) * (maxY - minY) * 0.35)));
        const pos = new Float32Array(count * 3);
        vel = new Float32Array(count * 2);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(pos, 3));
        points = new Points(geometry, new PointsMaterial({ color, size: motion === 'spark' ? 0.14 : 0.2, transparent: true, opacity: 0.75, depthWrite: false }));
        points.renderOrder = 7;
        points.frustumCulled = false;
        this.group.add(points);
      }
      const item: ZoneItem = { zone, index, volume, rim, points, vel, motion, outline, minX, minY, maxX, maxY, shown: zone.event === undefined ? 1 : 0 };
      if (points) for (let i = 0; i < vel.length / 2; i++) this.respawn(item, i, true);
      this.items.push(item);
    });
  }

  /**
   * Puts particle i somewhere inside the zone: anywhere when `scatter`, else near its upstream
   * side (where wind or a pad's push comes from, the bottom for rising particles). The point is
   * always inside the outline, polygons included: a point on the bounding box's edge can lie
   * outside it and would re-spawn every frame.
   */
  private respawn(item: ZoneItem, i: number, scatter: boolean): void {
    const pos = item.points!.geometry.getAttribute('position') as BufferAttribute;
    const r = resolveZone(item.zone);
    const fx = r.launch ? r.launch[0] : r.windX;
    const fy = r.launch ? r.launch[1] : r.windY;
    const len = Math.hypot(fx, fy) || 1;
    let x = (item.minX + item.maxX) / 2;
    let y = (item.minY + item.maxY) / 2;
    for (let tries = 0; tries < 24; tries++) {
      const tx = item.minX + Math.random() * (item.maxX - item.minX);
      const ty = item.minY + Math.random() * (item.maxY - item.minY);
      if (!inside(item.outline, tx, ty)) continue;
      x = tx;
      y = ty;
      break;
    }
    if (!scatter && (item.motion === 'flow' || item.motion === 'rise')) {
      // walk back against the flow while still inside: the particle then crosses the whole zone
      const ux = item.motion === 'rise' ? 0 : fx / len;
      const uy = item.motion === 'rise' ? 1 : fy / len;
      const step = 0.25;
      for (let k = 0; k < 400 && inside(item.outline, x - ux * step, y - uy * step); k++) {
        x -= ux * step;
        y -= uy * step;
      }
    }
    pos.setXYZ(i, x, y, PLANE_BACK_Z + Math.random() * (PLANE_FRONT_Z - PLANE_BACK_Z));
    const v = item.vel;
    switch (item.motion) {
      case 'flow': {
        const speed = (r.launch ? 7 : 3 + Math.abs(fx) * 0.25) * (0.7 + 0.6 * Math.random());
        v[i * 2] = (fx / len) * speed;
        v[i * 2 + 1] = (fy / len) * speed;
        break;
      }
      case 'rise':
        v[i * 2] = (Math.random() - 0.5) * 0.3;
        v[i * 2 + 1] = (item.zone.kind === 'longFlight' ? 2.5 : 0.8) * (0.6 + 0.8 * Math.random());
        break;
      default:
        v[i * 2] = (Math.random() - 0.5) * 0.8;
        v[i * 2 + 1] = (Math.random() - 0.5) * 0.8;
    }
  }

  /** Per frame: which zones are on (the frame's map event), easing, particles. */
  update(frame: Frame, dt: number, timeSec: number): void {
    const ev = frame.mapEvent;
    const step = Math.min(dt, 0.1);
    for (const item of this.items) {
      let target = 1;
      let pending = false;
      if (item.zone.event !== undefined) {
        const mine = !!ev && ev.id === item.zone.event && ev.zones.includes(item.index);
        target = mine && ev!.phase === 'active' ? 1 : 0;
        pending = mine && ev!.phase === 'warning';
      }
      item.shown += (target - item.shown) * (1 - Math.exp(-step * 6));
      item.volume.material.opacity = FILL_ON * item.shown;
      item.volume.visible = item.shown > 0.01;
      const pulse = 0.5 + 0.5 * Math.sin(timeSec * 9);
      item.rim.material.opacity = pending ? 0.35 + 0.6 * pulse : RIM_OFF + (RIM_ON - RIM_OFF) * item.shown;
      if (!item.points) continue;
      item.points.visible = item.shown > 0.05;
      if (!item.points.visible) continue;
      item.points.material.opacity = 0.75 * item.shown;
      const pos = item.points.geometry.getAttribute('position') as BufferAttribute;
      const v = item.vel;
      for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i) + v[i * 2]! * step;
        let y = pos.getY(i) + v[i * 2 + 1]! * step;
        if (item.motion === 'spark') {
          x += (Math.random() - 0.5) * 0.25;
          y += (Math.random() - 0.5) * 0.25;
        }
        if (x < item.minX || x > item.maxX || y < item.minY || y > item.maxY || !inside(item.outline, x, y)) {
          this.respawn(item, i, item.motion === 'drift' || item.motion === 'spark');
          continue;
        }
        pos.setXY(i, x, y);
      }
      pos.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const item of this.items) {
      item.volume.geometry.dispose();
      item.volume.material.dispose();
      item.rim.geometry.dispose();
      item.rim.material.dispose();
      item.points?.geometry.dispose();
      item.points?.material.dispose();
    }
    this.items.length = 0;
    this.group.clear();
  }
}
