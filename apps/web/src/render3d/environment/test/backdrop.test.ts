import { maps, streetMarketMap, type MapDef } from '@military-forge/content';
import { VIEW_BASE_WIDTH, VIEW_MAX_ASPECT, VIEW_ZOOM_MULTIPLIERS } from '@military-forge/netcode';
import { Color, Mesh, MeshBasicMaterial, PlaneGeometry, ShaderLib, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../../camera';
import { planePose } from '../../planeCamera';
import { playerView } from '../../test/helpers';
import { SKY_CARD_Z, coverView, hazeMaterial, viewAtDepth } from '../backdrop';
import { ENVIRONMENTS, MapEnvironment, environmentFor } from '../index';

/** Camera poses across the map at every zoom, on a 16:9 and a 4:3 screen, low and high. */
function poses(map: MapDef = streetMarketMap) {
  const out = [];
  for (const [w, h] of [
    [1280, 720],
    [1024, 768],
  ] as const) {
    for (let zoom = 0; zoom < VIEW_ZOOM_MULTIPLIERS.length; zoom++) {
      const cam = new Camera();
      cam.resize(w, h);
      cam.setZoom(zoom, VIEW_ZOOM_MULTIPLIERS.length);
      const { halfW, halfH } = cam.halfExtents;
      for (const fx of [0, 0.5, 1]) {
        for (const fy of [0, 1]) {
          cam.x = map.bounds.minX + halfW + fx * (map.bounds.maxX - map.bounds.minX - 2 * halfW);
          cam.y = map.bounds.minY + halfH + fy * (map.bounds.maxY - map.bounds.minY - 2 * halfH);
          out.push({ zoom, pose: { ...planePose(cam) } });
        }
      }
    }
  }
  return out;
}

describe('painted backdrops', () => {
  it('finds the view at a depth the way the lens-shifted camera sees it (the plane maps 1:1)', () => {
    const cam = new Camera();
    cam.resize(1280, 720);
    cam.x = 10;
    cam.y = 6;
    const pose = planePose(cam);
    const atPlane = viewAtDepth(pose, 0);
    expect(atPlane.x).toBeCloseTo(10, 9);
    expect(atPlane.y).toBeCloseTo(6, 9);
    expect(atPlane.width).toBeCloseTo(VIEW_BASE_WIDTH, 6);
    expect(atPlane.height).toBeCloseTo(2 * cam.halfExtents.halfH, 6);
    const deep = viewAtDepth(pose, -50);
    expect(deep.width / atPlane.width).toBeCloseTo((pose.z + 50) / pose.z, 9);
    expect(deep.y).toBeLessThan(atPlane.y); // the 5° look-down: deeper is lower
    expect(VIEW_MAX_ASPECT).toBe(0.75);
  });

  it('the sky card covers the whole view from every camera position and zoom', () => {
    const sky = new Mesh(new PlaneGeometry(1, 1));
    sky.position.z = SKY_CARD_Z;
    const roam = { cx: 0, cy: 25, halfW: 64, halfH: 31 };
    for (const { pose } of poses()) {
      coverView(sky, 21 / 9, pose, roam);
      const v = viewAtDepth(pose, SKY_CARD_Z);
      const s = sky.scale;
      expect(sky.position.x - s.x / 2).toBeLessThanOrEqual(v.x - v.width / 2 + 1e-6);
      expect(sky.position.x + s.x / 2).toBeGreaterThanOrEqual(v.x + v.width / 2 - 1e-6);
      expect(sky.position.y - s.y / 2).toBeLessThanOrEqual(v.y - v.height / 2 + 1e-6);
      expect(sky.position.y + s.y / 2).toBeGreaterThanOrEqual(v.y + v.height / 2 - 1e-6);
      expect(s.x / s.y).toBeCloseTo(21 / 9, 9);
    }
  });

  it('every painted layer of every map spans the view sideways (walls also top to bottom) from every camera position and zoom', () => {
    for (const env of Object.values(ENVIRONMENTS)) {
      const map = maps[env.mapId]!;
      for (const layer of env.backdrop?.layers ?? []) {
        const x0 = Math.min(...layer.panels.map((p) => p.x - p.width / 2));
        const x1 = Math.max(...layer.panels.map((p) => p.x + p.width / 2));
        for (const { pose } of poses(map)) {
          const v = viewAtDepth(pose, layer.z);
          const what = `${env.mapId} ${layer.name} at x ${pose.x.toFixed(1)} y ${pose.y.toFixed(1)}`;
          expect(x0, what).toBeLessThanOrEqual(v.x - v.width / 2);
          expect(x1, what).toBeGreaterThanOrEqual(v.x + v.width / 2);
          if (layer.opaque) {
            // a wall must also cover the view vertically (its height follows the image, 2048 × 878),
            // down to the floor: below y = 0 the ground plane hides it (the camera is always above it)
            const height = layer.panels[0]!.width * (878 / 2048);
            expect(pose.y, what).toBeGreaterThan(0);
            expect(layer.y, what).toBeLessThanOrEqual(Math.max(0, v.y - v.height / 2));
            expect(layer.y + height, what).toBeGreaterThanOrEqual(v.y + v.height / 2);
          }
        }
        // on a map with ads, painted layers stay behind the ad band (docs/14: z −9…−4), so they can't cover an ad
        if (env.ads) expect(layer.z).toBeLessThan(-9);
      }
    }
  });

  it('hazes a painted layer toward the air in its shader: after the map and tint, alpha untouched, one program for all', () => {
    const m = new MeshBasicMaterial();
    hazeMaterial(m, 0x808080, 0.4);
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: ShaderLib.basic.vertexShader, fragmentShader: ShaderLib.basic.fragmentShader };
    m.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toContain('uniform vec3 hazeColor;');
    expect(shader.fragmentShader).toMatch(/#include <map_fragment>\n\tdiffuseColor\.rgb = mix\( diffuseColor\.rgb, hazeColor, hazeAmount \);/);
    expect(shader.uniforms.hazeAmount!.value).toBeCloseTo(0.4);
    expect(m.customProgramCacheKey()).toBe('backdrop-haze');
    const plain = new MeshBasicMaterial();
    hazeMaterial(plain, 0x808080, 0);
    expect(plain.userData.haze).toBeUndefined();
  });

  it('every look the Street Market offers has a sky image and lights its lamps after dark', () => {
    const def = environmentFor('street-market')!;
    for (const name of Object.keys(def.looks)) expect(def.backdrop!.skies[name], name).toBeDefined();
    expect(def.looks[def.defaultLook]).toBeDefined();
    expect(def.looks.day!.lampGlow).toBeNull();
    expect(def.looks.night!.lampGlow).not.toBeNull();
  });

  it('builds the look it is asked for, the default otherwise; night adds the lamp glows', async () => {
    const def = environmentFor('street-market')!;
    const never = { loadAsync: () => new Promise<never>(() => {}) };
    const fetchNever = () => new Promise<never>(() => {});
    const night = new MapEnvironment(def, streetMarketMap, '/', never, fetchNever, 'night');
    expect(night.lookName).toBe('night');
    expect(night.foregroundGroup.getObjectByName('lamp-glow')).toBeDefined();
    expect(night.background.getObjectByName('lamp-pool')).toBeDefined();
    const fallback = new MapEnvironment(def, streetMarketMap, '/', never, fetchNever, 'noon');
    expect(fallback.lookName).toBe('day');
    expect(fallback.foregroundGroup.getObjectByName('lamp-glow')).toBeUndefined();
    night.dispose();
    fallback.dispose();
  });

  it('a lamp-head glow fades out completely while it covers a player, and comes back once clear', () => {
    const def = environmentFor('street-market')!;
    const never = { loadAsync: () => new Promise<never>(() => {}) };
    const env = new MapEnvironment(def, streetMarketMap, '/', never, () => new Promise<never>(() => {}), 'night');
    const heads = env.foregroundGroup.getObjectByName('lamp-glow') as InstancedMesh;
    const lampX = def.lamps![2]!;
    const cam = new Camera();
    cam.resize(1280, 720);
    cam.x = lampX;
    cam.y = 8;
    const pose = planePose(cam);
    const c = new Color();
    // a player on a ledge just behind the lamp's head
    const under = playerView({ x: lampX, y: 5.6 });
    for (let i = 0; i < 60; i++) env.update(pose, { players: [under], tick: i }, 1 / 60);
    heads.getColorAt(2, c);
    expect(c.r).toBeLessThan(0.02);
    heads.getColorAt(0, c);
    expect(c.r).toBe(1);
    for (let i = 0; i < 60; i++) env.update(pose, { players: [], tick: 60 + i }, 1 / 60);
    heads.getColorAt(2, c);
    expect(c.r).toBeGreaterThan(0.98);
    env.dispose();
  });
});
