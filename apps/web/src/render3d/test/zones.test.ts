import { mechanicsTestMap } from '@military-forge/content';
import { Mesh, Points } from 'three';
import { describe, expect, it } from 'vitest';
import type { Frame, MapEventView } from '../../view';
import { ZoneVolumes } from '../zones';

const frame = (mapEvent: MapEventView | null = null): Frame => ({ tick: 0, localId: 0, players: [], grenades: [], mapEvent });

function pocket(phase: 'warning' | 'active', zone: number): MapEventView {
  return { id: 'pocket', kind: 'flip', name: 'GRAVITY POCKET', description: '', phase, secondsLeft: 1, progress: 0.5, color: 0xf778ba, zones: [zone], occurrence: 5, bulletRangeMul: 1 };
}

describe('zone volumes (docs/02 §20)', () => {
  const zones = mechanicsTestMap.zones!;
  const siteA = zones.findIndex((z) => z.id === 'pocket-a');
  const siteB = zones.findIndex((z) => z.id === 'pocket-b');
  const volumes = (v: ZoneVolumes) => v.group.children.filter((o): o is Mesh => o instanceof Mesh);

  it('one tinted volume and rim per zone, particles where the zone does something visible', () => {
    const v = new ZoneVolumes(mechanicsTestMap);
    expect(volumes(v)).toHaveLength(zones.length);
    const particles = v.group.children.filter((o) => o instanceof Points);
    // all but mud, the knockback pit and the always-quiet kinds move particles
    expect(particles.length).toBeGreaterThanOrEqual(zones.length - 3);
    v.dispose();
    expect(v.group.children).toHaveLength(0);
  });

  it('event zones stay hidden until their event runs, and only the picked site opens', () => {
    const v = new ZoneVolumes(mechanicsTestMap);
    v.update(frame(), 0.016, 0);
    expect(volumes(v)[siteA]!.visible).toBe(false);
    expect(volumes(v)[0]!.visible).toBe(true); // the low-g zone is always on
    for (let i = 0; i < 60; i++) v.update(frame(pocket('warning', siteA)), 0.016, i / 60);
    expect(volumes(v)[siteA]!.visible).toBe(false); // the warning only pulses its rim
    for (let i = 0; i < 60; i++) v.update(frame(pocket('active', siteA)), 0.016, 1 + i / 60);
    expect(volumes(v)[siteA]!.visible).toBe(true);
    expect(volumes(v)[siteB]!.visible).toBe(false);
    for (let i = 0; i < 120; i++) v.update(frame(), 0.016, 2 + i / 60);
    expect(volumes(v)[siteA]!.visible).toBe(false);
  });

  it('flow particles in a polygon zone start inside its outline and stay there (no re-spawn every frame)', () => {
    // a "<" of wind blowing right: its bounding box's left (upstream) edge touches it only at the tip
    const map = { ...mechanicsTestMap, zones: [{ id: 'gust', kind: 'wind' as const, points: [0, 5, 10, 0, 10, 10] }], events: undefined };
    const v = new ZoneVolumes(map);
    const points = v.group.children.find((o): o is Points => o instanceof Points)!;
    const pos = points.geometry.getAttribute('position');
    const inTriangle = (x: number, y: number) => x >= -1e-6 && x <= 10 + 1e-6 && Math.abs(y - 5) <= x / 2 + 1e-6;
    let moved = 0;
    for (let f = 0; f < 120; f++) {
      const before = Array.from({ length: pos.count }, (_, i) => pos.getX(i));
      v.update(frame(), 1 / 60, f / 60);
      for (let i = 0; i < pos.count; i++) {
        expect(inTriangle(pos.getX(i), pos.getY(i)), `particle ${i} at frame ${f}`).toBe(true);
        if (pos.getX(i) > before[i]!) moved++;
      }
    }
    expect(moved / (120 * pos.count)).toBeGreaterThan(0.8); // drifting with the wind, not teleporting
  });
});
