/**
 * Fog Stair's look (maps-vertical; the owner's pick, 23 Oct): its own place, its own painted layers,
 * and the near one hazed so it reads as background, never as walls that stop bullets.
 */
import { maps } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { environmentFor } from '../index';

describe('fog-stair environment', () => {
  it('has its own look and painted layers, no kit yet', () => {
    const def = environmentFor('fog-stair')!;
    expect(maps['fog-stair']).toBeDefined();
    expect(def.kitUrl).toBeUndefined();
    expect(def.defaultLook).toBe('fog');
    expect(def.backdrop!.skies.fog).toBe('sky.webp');
    expect(def.backdrop!.layers.map((l) => l.name)).toEqual(['far', 'mid']);
  });

  it('a painted layer close behind the play plane is hazed toward the river fog', () => {
    const def = environmentFor('fog-stair')!;
    const look = def.looks[def.defaultLook]!;
    for (const layer of def.backdrop!.layers) if (layer.z > -16) expect(look.backdropHaze?.amount[layer.name] ?? 0, layer.name).toBeGreaterThanOrEqual(0.3);
    // a foggy place: the fog closes in sooner than the Street Market's day
    expect(look.fog.far).toBeLessThan(environmentFor('street-market')!.looks.day!.fog.far);
  });
});
