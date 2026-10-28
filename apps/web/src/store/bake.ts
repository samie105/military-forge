/**
 * The Store's baked art (dev only: scripts/store-art.mjs runs this in a Vite page; main.ts never imports it): a
 * skin's gun rendered side on with the game's own loader, toon ramp and skin glow (render3d/weaponModels.ts, as the
 * Locker draws it), on a transparent background, so a phone shows one small image instead of a 3D view.
 */
import { Box3, DirectionalLight, HemisphereLight, Matrix4, Mesh, MeshToonMaterial, OrthographicCamera, Scene, Vector3, WebGLRenderer, type Texture } from 'three';
import { characterGltfLoader, characterToonRamp } from '../character';
import { LOCKER_LIGHTS } from '../locker/turntable';
import { SKIN_GLOW, weaponFromGltf } from '../render3d/weaponModels';

/** the weapon frame (+Y muzzle, +Z up, +X right) turned side on: muzzle to the right, up up, its right side to the camera */
const SIDE_ON = new Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1);

/** `url`'s gun as a `width`×`height` WebP data URL (transparent round it), the gun filling the width less `margin`. */
export async function bakeGun(url: string, width: number, height: number, margin = 0.06): Promise<string> {
  const ramp = characterToonRamp();
  const plain = new MeshToonMaterial({ color: 0x2d3136, gradientMap: ramp });
  const materials = {
    plain,
    vertexColors: new MeshToonMaterial({ vertexColors: true, gradientMap: ramp }),
    textured: (map: Texture, emissiveMap: Texture | null = null) =>
      emissiveMap ? new MeshToonMaterial({ map, gradientMap: ramp, emissiveMap, emissive: 0xffffff, emissiveIntensity: SKIN_GLOW }) : new MeshToonMaterial({ map, gradientMap: ramp }),
  };
  const model = weaponFromGltf(await characterGltfLoader().loadAsync(url), materials);
  if (!model) throw new Error(`bakeGun: no mesh in ${url}`);
  const gun = new Mesh(model.solid ?? model.geometry, model.material);
  gun.applyMatrix4(SIDE_ON);
  const box = new Box3().setFromObject(gun);
  const size = box.getSize(new Vector3());
  gun.position.sub(box.getCenter(new Vector3()));

  const light = LOCKER_LIGHTS.lobby;
  const key = new DirectionalLight(light.key, light.keyIntensity);
  key.position.set(1.5, 3, 4);
  const rim = new DirectionalLight(light.rim, 1.2);
  rim.position.set(-2, 2, -2.5);
  const scene = new Scene();
  scene.add(new HemisphereLight(light.sky, light.ground, light.ambient), key, rim, gun);

  // orthographic like the game's side view: the whole gun inside the margin, in its own proportions
  const aspect = width / height;
  let halfW = size.x / 2 / (1 - 2 * margin);
  let halfH = size.y / 2 / (1 - 2 * margin);
  if (halfW / halfH > aspect) halfH = halfW / aspect;
  else halfW = halfH * aspect;
  const camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);

  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  const url2 = canvas.toDataURL('image/webp', 0.9);
  renderer.dispose();
  return url2;
}
