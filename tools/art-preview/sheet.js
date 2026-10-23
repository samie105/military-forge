/* global document, window, fetch, URL, URLSearchParams */
// Art sheets: a grid of soldiers rendered from the web build, for the art README and PRs (turnarounds,
// clips and weapon holds, outfits on each body). Each cell assembles a body and its parts on one skeleton the
// way the viewer (main.js) does: per-body part fits (a part manifest's `bodies.<body>`), the dye shader with
// the skin weight, `hidesHair` headgear dropping the hair part, `hidesBody` parts hiding the body's regions
// (the body GLB's `_REGION` attribute), weapons on their sockets with an identity transform.
//
//   python3 tools/art-preview/serve.py 8124
//   open http://localhost:8124/tools/art-preview/sheet.html?spec=tools/art-preview/sheets/<name>.json&shot=<name>
//
// `shot` saves art/screenshots/<shot>.png through serve.py and sets the title to `saved:<shot>`.
// Spec: { title, cols, cell: [w, h], frame: { width, bottom, top }, defaults: {...cell}, cells: [cell] }, a cell:
//   body (manifest under assets/), lod, parts { slot: id | null }, yaw (deg, 0 = facing the camera), loco (clip),
//   aim (upper-body clip), action (upper-body clip), t (s), weapon / weaponL / slung / holster (weapon ids),
//   dyes { primary, secondary, accent }, skin (hex), hero (the body's close-up textures, `dye.lod0.heroAlbedo` /
//   `heroMask`, as the creator's setHero), label.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ROOT = '../../';
const ASSETS = `${ROOT}apps/web/public/assets/`;
const SLOTS = ['headgear', 'eyewear', 'top', 'gloves', 'legs', 'boots', 'jetpack', 'hair'];
const params = new URLSearchParams(window.location.search);
const status = document.getElementById('status');
const spec = await fetch(`${ROOT}${params.get('spec')}`).then((r) => r.json());

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();
const once = (key, make) => (cache.has(key) ? cache.get(key) : (cache.set(key, make()), cache.get(key)));
const gltf = (path) => once(path, () => loader.loadAsync(path));
const json = (path) => once(path, () => fetch(path).then((r) => (r.ok ? r.json() : null)));
const texture = (path, data) => once(path, () => new THREE.TextureLoader().loadAsync(path).then((t) => {
  t.flipY = false; // glTF UV convention
  t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  return t;
}));
const dir = (path) => path.slice(0, path.lastIndexOf('/') + 1);
const resolve = (base, rel) => new URL(rel, new URL(base, window.location.href)).href;

const ramp = new THREE.DataTexture(new Uint8Array([110, 185, 255]), 3, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.needsUpdate = true;

// docs/04 §5.4, as main.js: albedo × lerp(1, dye, mask), the body's skin weight in its albedo alpha.
function dyeMaterial(dye, defaults, override, skin, skinTone) {
  const m = new THREE.MeshToonMaterial({ map: dye.albedo, gradientMap: ramp, side: THREE.DoubleSide });
  const pick = (ch) => new THREE.Color(override?.[ch] ?? defaults?.[ch] ?? '#ffffff');
  const uniforms = { dyeP: { value: pick('primary') }, dyeS: { value: pick('secondary') }, dyeA: { value: pick('accent') } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, { dyeMask: { value: dye.mask }, skinTone: { value: new THREE.Color(skinTone) } });
    sh.fragmentShader = 'uniform sampler2D dyeMask;\nuniform vec3 dyeP, dyeS, dyeA, skinTone;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 dyeM = texture2D(dyeMask, vMapUv);
        ${skin ? 'diffuseColor.rgb *= mix(vec3(1.0), 2.0 * skinTone, diffuseColor.a); diffuseColor.a = 1.0;' : ''}
        diffuseColor.rgb *= mix(vec3(1.0), dyeP, dyeM.r) * mix(vec3(1.0), dyeS, dyeM.g) * mix(vec3(1.0), dyeA, dyeM.b);`);
  };
  m.customProgramCacheKey = () => (skin ? 'sheet-dye-skin' : 'sheet-dye');
  return m;
}

async function layer(manifestPath, entry, lod, hero = false) {
  const base = dir(manifestPath);
  const d = entry.dye[lod];
  const close = hero && d.heroAlbedo && d.heroMask;
  const [g, albedo, mask] = await Promise.all([
    gltf(base + entry.lods[lod]), texture(base + (close ? d.heroAlbedo : d.albedo), false),
    texture(base + (close ? d.heroMask : d.mask), true),
  ]);
  return { gltf: g, dye: { albedo, mask }, defaults: entry.dye[lod].defaults ?? {}, skin: entry.dye[lod].skin === 'alpha' };
}

// Body triangles whose three vertices all carry a hidden region code are dropped (the part replaces them).
function hideRegions(geometry, codes) {
  const region = geometry.getAttribute('_region');
  if (!region || !codes.length) return geometry;
  const g = geometry.clone();
  const idx = g.getIndex().array;
  const keep = [];
  for (let i = 0; i < idx.length; i += 3) {
    if ([0, 1, 2].every((k) => codes.includes(Math.round(region.getX(idx[i + k]))))) continue;
    keep.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  g.setIndex(keep);
  return g;
}

async function soldier(cell) {
  const bodyPath = ASSETS + cell.body;
  const bodyManifest = await json(bodyPath);
  const bodyId = bodyManifest.body ?? 'male';
  const lod = cell.lod ?? 'lod0';
  const wanted = { ...bodyManifest.defaultParts, ...(cell.parts ?? {}) };
  const parts = [];
  for (const slot of SLOTS) {
    const id = wanted[slot];
    if (!id) continue;
    const path = `${ASSETS}cosmetics/${slot}/${id}.json`;
    const m = await json(path);
    if (!m) throw new Error(`no manifest ${path}`);
    const fit = m.bodies?.[bodyId] ?? m;
    parts.push({ slot, id, manifest: m, ...(await layer(path, fit, lod)) });
  }
  // headgear hides the hair part unless its extras say otherwise (the Field Cap, Beret and Bandana keep it)
  const extrasOf = (p) => { let x = {}; p.gltf.scene.traverse((o) => { if (o.isSkinnedMesh) x = o.userData; }); return x; };
  const hidesHair = parts.some((p) => p.slot === 'headgear' && (extrasOf(p).hidesHair ?? p.manifest.hidesHair ?? true));
  const shown = parts.filter((p) => !(p.slot === 'hair' && hidesHair));
  const codes = shown.flatMap((p) => (p.manifest.hidesBody ?? []).map((r) => bodyManifest.regions?.[r])).filter((c) => c !== undefined);
  const body = await layer(bodyPath, bodyManifest, lod, cell.hero);
  const root = SkeletonUtils.clone(body.gltf.scene);
  let bodyMesh = null;
  root.traverse((o) => { if (o.isSkinnedMesh) bodyMesh = o; });
  bodyMesh.geometry = hideRegions(bodyMesh.geometry, codes);
  const skinTone = cell.skin ?? '#da9f75';
  bodyMesh.material = dyeMaterial(body.dye, body.defaults, cell.dyes, body.skin, skinTone);
  for (const p of shown) {
    p.gltf.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const mesh = o.clone();
      const bones = o.skeleton.bones.map((b) => bodyMesh.skeleton.getBoneByName(b.name));
      mesh.bind(new THREE.Skeleton(bones, o.skeleton.boneInverses), o.bindMatrix);
      mesh.material = dyeMaterial(p.dye, p.defaults, cell.dyes, false, skinTone);
      bodyMesh.parent.add(mesh);
    });
  }
  const weapons = await json(`${ASSETS}weapons/weapons.json`);
  for (const [key, socket] of [['weapon', 'socket_weapon_R'], ['weaponL', 'socket_weapon_L'], ['slung', 'sling_back'], ['holster', 'holster_thigh']]) {
    if (!cell[key]) continue;
    if (!weapons.weapons[cell[key]]) throw new Error(`no weapon ${cell[key]}`);
    const w = (await gltf(`${ASSETS}weapons/${cell[key]}.glb`)).scene.clone();
    w.traverse((o) => {
      if (o.isMesh) o.material = new THREE.MeshToonMaterial({ map: o.material.map ?? null, color: o.material.color, gradientMap: ramp });
    });
    root.getObjectByName(socket).add(w);
  }
  root.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  if (cell.loco || cell.aim || cell.action) {
    // a body manifest without `anims` shares the male clip library (the assembler's rule)
    const anims = await gltf(bodyManifest.anims ? resolve(bodyPath, bodyManifest.anims) : `${ASSETS}characters/rookie/rookie_anims.glb`);
    const clips = Object.fromEntries(anims.animations.map((c) => [c.name, c]));
    const upper = new Set(bodyManifest.upperBodyBones);
    const mixer = new THREE.AnimationMixer(root);
    if (cell.loco) {
      const c = clips[cell.loco];
      const armed = cell.aim || cell.action;
      mixer.clipAction(armed ? new THREE.AnimationClip(`${c.name}_lower`, c.duration, c.tracks.filter((t) => !upper.has(t.name.split('.')[0]))) : c).play();
    }
    for (const name of [cell.aim, cell.action].filter(Boolean)) {
      if (!clips[name]) throw new Error(`no clip ${name}`);
      mixer.clipAction(clips[name]).play();
    }
    mixer.setTime(cell.t ?? 0);
  }
  root.rotation.y = THREE.MathUtils.degToRad(cell.yaw ?? 0);
  return root;
}

const [cw, ch] = spec.cell ?? [320, 440];
const cols = spec.cols ?? 5;
const rows = Math.ceil(spec.cells.length / cols);
const titleH = spec.title ? 44 : 0;
const labelH = 26;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(cols * cw, rows * ch);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const hull = new OutlineEffect(renderer, { defaultThickness: 0.0035, defaultColor: [0.1, 0.1, 0.12] });
const frame = { width: 1.3, bottom: -0.05, top: 1.75, ...spec.frame };
const camH = frame.top - frame.bottom;
const camW = Math.max(frame.width, camH * (cw / (ch - labelH)));
const camera = new THREE.OrthographicCamera(-camW / 2, camW / 2, frame.top, frame.bottom - camH * (labelH / (ch - labelH)), 0.1, 50);
camera.position.set(0, 0, 10);

renderer.setClearColor(0xd9dfe5, 1);
renderer.clear();  // cells past the last one stay the page colour
renderer.setScissorTest(true);
for (const [i, raw] of spec.cells.entries()) {
  const cell = { ...spec.defaults, ...raw };
  status.textContent = `cell ${i + 1} / ${spec.cells.length}`;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe4edf5, 0x6d6553, 1.8));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
  sun.position.set(-3, 6, 8);
  scene.add(sun);
  scene.add(await soldier(cell));
  const x = (i % cols) * cw;
  const y = (rows - 1 - Math.floor(i / cols)) * ch;  // GL viewports count from the bottom
  renderer.setViewport(x, y, cw, ch);
  renderer.setScissor(x, y, cw, ch);
  renderer.setClearColor(new THREE.Color(cell.background ?? ((Math.floor(i / cols) + i) % 2 ? 0xdde3e8 : 0xd3dae0)), 1);
  renderer.clear();
  hull.render(scene, camera);
}

// labels and title on a 2D canvas over the render
const out = document.createElement('canvas');
out.width = cols * cw;
out.height = rows * ch + titleH;
const ctx = out.getContext('2d');
ctx.fillStyle = '#20262d';
ctx.fillRect(0, 0, out.width, titleH);
ctx.drawImage(renderer.domElement, 0, titleH);
if (spec.title) {
  ctx.fillStyle = '#f2f4f6';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillText(spec.title, 14, 29);
}
ctx.font = '600 14px system-ui, sans-serif';
for (const [i, raw] of spec.cells.entries()) {
  const label = raw.label ?? '';
  const x = (i % cols) * cw;
  const y = titleH + Math.floor(i / cols) * ch;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillRect(x, y + ch - labelH, cw, labelH);
  ctx.fillStyle = '#1b2733';
  ctx.fillText(label, x + 10, y + ch - 8, cw - 20);
}
document.body.prepend(out);
status.textContent = '';
if (params.has('shot')) {
  const name = params.get('shot');
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const res = await fetch(`/__screenshot/${name}.png`, { method: 'POST', body: blob });
  document.title = res.ok ? `saved:${name}` : 'save failed';
}
