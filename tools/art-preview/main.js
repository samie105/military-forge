/* global document, window, fetch, URLSearchParams, requestAnimationFrame */
// Art-test viewer: the rigged soldier + the yard kit at the gameplay camera (docs/01 §5:
// perspective, FOV 35°, looking down −Z at the z = 0 plane, 5° downward tilt; docs/03 §10 zoom
// table). Standalone: three.js from the CDN, assets from ../../art/. Serve with serve.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ART = '../../art/';
const VISIBLE_WIDTH_1X = 36; // metres at zoom 1× (docs/03 §10)
const FOV = 35;
const TILT = THREE.MathUtils.degToRad(5);
const TEAM = { blue: new THREE.Color(0x2f7dff), orange: new THREE.Color(0xff7a1a) };
// Copied from packages/content/src/hitboxes.ts for the overlay only.
const HITBOXES = {
  standing: { head: [1.24, 0.24], torso: [0.45, 0.95, 0.3], legs: [0.1, 0.45, 0.22] },
  crouched: { head: [0.84, 0.22], torso: [0.32, 0.7, 0.3], legs: [0.1, 0.32, 0.22] },
};

const params = new URLSearchParams(window.location.search);
const ui = {
  zoom: document.getElementById('zoom'),
  clip: document.getElementById('clip'),
  shading: document.getElementById('shading'),
  lod: document.getElementById('lod'),
  yaw: document.getElementById('yaw'),
  outline: document.getElementById('outline'),
  hitboxes: document.getElementById('hitboxes'),
  save: document.getElementById('save'),
  stats: document.getElementById('stats'),
  status: document.getElementById('status'),
};
for (const key of ['zoom', 'shading', 'lod', 'yaw', 'outline']) if (params.has(key)) ui[key].value = params.get(key);
if (params.has('hitboxes')) ui.hitboxes.checked = params.get('hitboxes') === '1';

// ------------------------------------------------------------------ renderer, scene, lights

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // docs/11 §3 DPR cap (High)
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
document.body.prepend(renderer.domElement);
const hull = new OutlineEffect(renderer, { defaultThickness: 0.004, defaultColor: [0.08, 0.08, 0.1] });

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xb3c1cd);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 40, 120);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);

scene.add(new THREE.HemisphereLight(0xe4edf5, 0x6d6553, 1.7));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
sun.position.set(-8, 16, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); // docs/11 §2: one 1024² map over the gameplay plane
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 14, bottom: -4, near: 1, far: 60 });
scene.add(sun);

const ramp = new THREE.DataTexture(new Uint8Array([110, 185, 255]), 3, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.needsUpdate = true;

// Every mesh keeps its three shading variants; the team outline rides on each variant.
// Shared per (source material, team) so clones don't multiply materials.
const variantCache = new Map();
function shadeVariants(src, team) {
  const key = `${src.uuid}:${team}`;
  if (!variantCache.has(key)) variantCache.set(key, buildVariants(src, team));
  return variantCache.get(key);
}
function buildVariants(src, team) {
  const base = { map: src.map ?? null, color: src.color.clone(), vertexColors: src.vertexColors };
  const outlineParams = team
    ? { thickness: 0.0022, color: TEAM[team].toArray(), alpha: 1, visible: true }
    : { visible: false };
  const variants = {
    toon: new THREE.MeshToonMaterial({ ...base, gradientMap: ramp }),
    flat: new THREE.MeshBasicMaterial(base),
    lit: src.clone(),
  };
  for (const m of Object.values(variants)) m.userData.outlineParameters = { ...outlineParams };
  return variants;
}

const shaded = []; // meshes with userData.variants
// Screen-space team silhouette (docs/04 §5.5): each team's characters are drawn flat into a mask,
// then a full-screen pass paints the team colour on empty pixels next to the mask. Only the outer
// silhouette gets a line, unlike the inverted hull, which also outlines every interior edge.
const TEAM_LAYER = { blue: 1, orange: 2 };
const maskRT = new THREE.WebGLRenderTarget(1, 1);
const maskMats = Object.fromEntries(Object.keys(TEAM).map((t) => [t, new THREE.MeshBasicMaterial({ color: TEAM[t], fog: false })]));
const silhouette = new THREE.ShaderMaterial({
  uniforms: { tMask: { value: maskRT.texture }, texel: { value: new THREE.Vector2() }, radius: { value: 2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D tMask; uniform vec2 texel; uniform float radius; varying vec2 vUv;
    void main() {
      if (texture2D(tMask, vUv).a > 0.5) discard;
      vec4 best = vec4(0.0);
      for (int ring = 1; ring <= 2; ring++) {
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 0.5235988;
          vec4 s = texture2D(tMask, vUv + vec2(cos(a), sin(a)) * texel * radius * float(ring) * 0.5);
          if (s.a > best.a) best = s;
        }
      }
      if (best.a < 0.5) discard;
      gl_FragColor = vec4(best.rgb, 1.0);
      #include <colorspace_fragment>
    }`,
  depthTest: false,
  depthWrite: false,
  transparent: true,
});
const post = new THREE.Scene();
const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), silhouette);
postQuad.frustumCulled = false;
post.add(postQuad);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function renderSilhouettes() {
  const bg = scene.background;
  scene.background = null;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.setRenderTarget(maskRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  for (const [team, layer] of Object.entries(TEAM_LAYER)) {
    camera.layers.set(layer);
    scene.overrideMaterial = maskMats[team];
    renderer.render(scene, camera);
  }
  scene.overrideMaterial = null;
  camera.layers.set(0);
  scene.background = bg;
  renderer.setRenderTarget(null);
  renderer.render(post, postCam);
  renderer.autoClear = true;
  renderer.shadowMap.autoUpdate = true;
}

function applyShading() {
  for (const mesh of shaded) {
    const v = mesh.userData.variants;
    mesh.material = v[ui.shading.value];
    const team = mesh.userData.team;
    mesh.material.userData.outlineParameters.visible = Boolean(team) && ui.outline.value === 'hull';
  }
}

// ------------------------------------------------------------------ assets

const loader = new GLTFLoader();
const load = (path) => loader.loadAsync(ART + path);
ui.status.textContent = 'loading GLBs…';
const [kit, lod0, lod1] = await Promise.all([
  load('kit/kit_yard.glb'),
  load('character/rookie.glb'),
  load('character/rookie_lod1.glb'),
]);
const pieces = Object.fromEntries(kit.scene.children.map((o) => [o.name, o]));

function place(name, x, y) {
  const o = pieces[name].clone();
  o.position.set(x, y, 0);
  o.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = name !== 'ground_4m';
    m.receiveShadow = true;
    m.userData.variants = shadeVariants(m.material, null);
    shaded.push(m);
  });
  scene.add(o);
  return o;
}

// The 20 m slice (x −10…+10) plus ground either side so the 36 m view isn't empty.
for (let x = -18; x <= 18; x += 4) place('ground_4m', x, 0);
place('platform_2m', -5.5, 3.0);
place('platform_2m', 3.0, 4.0);
place('platform_2m', 8.0, 2.25);
place('crate_1m', 5.0, 0);
place('crate_1m', 6.0, 0);
place('crate_1m', 5.5, 1.0);

// Preview-only dressing (not kit pieces): fill under the ground, a far skyline, slice markers.
const NO_OUTLINE = { outlineParameters: { visible: false } };
const fill = new THREE.Mesh(new THREE.BoxGeometry(60, 12, 2), new THREE.MeshBasicMaterial({ color: 0x4f4b45, userData: NO_OUTLINE }));
fill.position.set(0, -7.3, 0); // top tucked just under the ground blocks
scene.add(fill);
const far = new THREE.MeshBasicMaterial({ color: 0x8c9cab, userData: NO_OUTLINE });
for (let i = 0; i < 18; i++) {
  const w = 3 + ((i * 7) % 6);
  const h = 4 + ((i * 11) % 10);
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 2), far);
  b.position.set(-48 + i * 6 + ((i * 13) % 3), h / 2 - 1.5, -26 - ((i * 5) % 12));
  scene.add(b);
}
const backdrop = new THREE.Mesh(new THREE.BoxGeometry(200, 1.5, 40), new THREE.MeshBasicMaterial({ color: 0x8e9480, userData: NO_OUTLINE }));
backdrop.position.set(0, -0.76, -22);
scene.add(backdrop);
const markerMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.5 });
for (const x of [-10, 10]) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, 1.2), new THREE.Vector3(x, 9, 1.2)]);
  const line = new THREE.Line(g, markerMat);
  line.computeLineDistances();
  scene.add(line);
}

// Props hung on the skeleton's sockets (docs/04 §4.1): proves the sockets are where they should be.
function makeGun() {
  const steel = new THREE.MeshToonMaterial({ color: 0x2d3136, gradientMap: ramp });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.12), steel);
  body.position.set(0, 0.1, 0.02);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8), steel);
  barrel.position.set(0, 0.36, 0.05);
  g.add(body, barrel);
  return g;
}
function makeFlame() {
  // Socket space: +Y up the back, +Z forward, +X to the character's left. The nozzles sit
  // ~0.25 m below and ~0.1 m behind socket_jetpack. Normal blending: additive washes out on a
  // light sky.
  const g = new THREE.Group();
  const fx = { transparent: true, depthWrite: false, userData: NO_OUTLINE };
  const outer = new THREE.MeshBasicMaterial({ ...fx, color: 0xff8a1f, opacity: 0.9 });
  const inner = new THREE.MeshBasicMaterial({ ...fx, color: 0xfff1b0, opacity: 0.95 });
  for (const x of [-0.065, 0.065]) {
    for (const [mat, r, len] of [[outer, 0.075, 0.62], [inner, 0.038, 0.34]]) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, len, 10), mat);
      m.rotation.x = Math.PI; // point down
      m.position.set(x, -0.26 - len / 2, -0.1);
      m.renderOrder = mat === inner ? 2 : 1;
      g.add(m);
    }
  }
  // Scale from the nozzle, not the cone centres, when flickering.
  const pivot = new THREE.Group();
  pivot.position.y = -0.26;
  g.position.y = 0.26;
  pivot.add(g);
  return pivot;
}
function makeNameplate(text, team) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(15,18,24,0.7)';
  ctx.beginPath();
  ctx.roundRect(4, 8, 248, 48, 14);
  ctx.fill();
  ctx.fillStyle = `#${TEAM[team].getHexString()}`;
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, 128, 43);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(1.1, 0.275, 1);
  s.renderOrder = 10;
  return s;
}
function makeHitboxes(layout) {
  const pts = (cx, cy, r, a0, a1) => Array.from({ length: 17 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / 16;
    return new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0);
  });
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xff3355, depthTest: false });
  const [hy, hr] = layout.head;
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts(0, hy, hr, 0, Math.PI * 2)), mat));
  for (const [y0, y1, r] of [layout.torso, layout.legs]) {
    const p = [...pts(0, y1, r, 0, Math.PI), ...pts(0, y0, r, Math.PI, Math.PI * 2)];
    g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(p), mat));
  }
  g.position.z = 0; // on the gameplay plane; depthTest off keeps it on top
  g.renderOrder = 20;
  return g;
}

const ROSTER = [
  { name: 'Rookie', team: 'blue', clip: 'idle', x: -1.0, y: 0, facing: 1, hero: true },
  { name: 'Blue 2', team: 'blue', clip: 'jet_hover', x: -5.5, y: 4.4, facing: 1 },
  { name: 'Blue 3', team: 'blue', clip: 'jet_ascend', x: -8.6, y: 1.6, facing: 1 },
  { name: 'Orange 1', team: 'orange', clip: 'run', x: 3.0, y: 4.0, facing: -1 },
  { name: 'Orange 2', team: 'orange', clip: 'crouch_idle', x: 7.3, y: 0, facing: -1, crouched: true },
  { name: 'Orange 3', team: 'orange', clip: 'fall', x: 8.4, y: 4.6, facing: -1 },
];
for (const a of lod0.animations) {
  const opt = document.createElement('option');
  opt.value = opt.textContent = a.name;
  opt.selected = a.name === 'idle';
  ui.clip.add(opt);
}
if (params.has('clip')) ui.clip.value = params.get('clip');

let actors = [];
function spawnAll() {
  for (const a of actors) {
    scene.remove(a.root, a.hitboxes);
    for (const m of a.meshes) shaded.splice(shaded.indexOf(m), 1);
  }
  const src = ui.lod.value === '1' ? lod1 : lod0;
  actors = ROSTER.map((r) => {
    const root = SkeletonUtils.clone(src.scene);
    const meshes = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      o.userData.team = r.team;
      o.userData.variants = shadeVariants(o.material, r.team);
      meshes.push(o);
      shaded.push(o);
    });
    root.position.set(r.x, r.y, 0);
    root.getObjectByName('socket_weapon_R').add(makeGun());
    root.getObjectByName('socket_nameplate').add(makeNameplate(r.name, r.team));
    const clipName = r.hero ? ui.clip.value : r.clip;
    const flame = clipName.startsWith('jet_');
    if (flame) root.getObjectByName('socket_jetpack').add(makeFlame());
    root.traverse((o) => {
      if (o.isMesh && o.material.blending !== THREE.AdditiveBlending) o.layers.enable(TEAM_LAYER[r.team]);
    });
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(THREE.AnimationClip.findByName(src.animations, clipName)).play();
    mixer.setTime((r.x + 20) * 0.37); // desync the loops
    const hitboxes = makeHitboxes(r.crouched || clipName === 'crouch_idle' ? HITBOXES.crouched : HITBOXES.standing);
    hitboxes.position.x = r.x;
    hitboxes.position.y = r.y;
    scene.add(root, hitboxes);
    return { ...r, flame, root, meshes, mixer, hitboxes };
  });
  applyFacing();
  applyShading();
}
function applyFacing() {
  const yaw = THREE.MathUtils.degToRad(Number(ui.yaw.value));
  for (const a of actors) {
    a.root.rotation.y = a.facing * (Math.PI / 2 - yaw);
    a.hitboxes.visible = ui.hitboxes.checked;
  }
}

// ------------------------------------------------------------------ camera + loop

function frameCamera() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  hull.setSize(w, h);
  const px = renderer.getDrawingBufferSize(new THREE.Vector2());
  maskRT.setSize(px.x, px.y);
  silhouette.uniforms.texel.value.set(1 / px.x, 1 / px.y);
  silhouette.uniforms.radius.value = 2 * renderer.getPixelRatio();
  camera.aspect = w / h;
  const mult = Number(ui.zoom.value);
  const visibleW = VISIBLE_WIDTH_1X * mult;
  const halfH = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const dist = visibleW / 2 / (halfH * camera.aspect);
  const hero = ROSTER[0];
  const focus = params.has('focus') ? ROSTER[Number(params.get('focus'))] : null;
  // Close-up: ?focus=<roster index>, else the hero, the crates and the crouching soldier.
  // Otherwise put the ground line ~22% up from the bottom.
  const target = focus && mult < 1
    ? new THREE.Vector3(focus.x, focus.y + 0.9, 0)
    : mult < 1
    ? new THREE.Vector3(hero.x + 3.2, 2.2, 0)
    : new THREE.Vector3(0, 0.28 * (visibleW / camera.aspect), 0);
  camera.position.set(target.x, target.y + dist * Math.sin(TILT), dist * Math.cos(TILT));
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

const clock = new THREE.Clock();
let frames = 0;
let time = 0;
function step(dt) {
  time += dt;
  for (const a of actors) {
    a.mixer.update(dt);
    const flame = a.flame && a.root.getObjectByName('socket_jetpack').children[0];
    if (flame) flame.scale.y = 0.85 + 0.2 * Math.sin(time * 43 + a.x) * Math.sin(time * 17);
  }
  renderer.info.reset();
  if (ui.outline.value === 'hull') hull.render(scene, camera);
  else renderer.render(scene, camera);
  if (ui.outline.value === 'silhouette') renderSilhouettes();
  if (frames++ % 15 === 0) {
    const { calls, triangles } = renderer.info.render;
    ui.stats.textContent = `draw calls ${calls}\ntriangles  ${triangles.toLocaleString()}\nhero clip  ${ui.clip.value}`;
  }
}
function tick() {
  step(Math.min(clock.getDelta(), 0.05));
  requestAnimationFrame(tick);
}

async function saveShot(name) {
  const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/png'));
  const res = await fetch(`/__screenshot/${name}.png`, { method: 'POST', body: blob });
  ui.status.textContent = res.ok ? `saved art/screenshots/${name}.png` : `save failed (${res.status}): run serve.py`;
  document.title = res.ok ? `saved:${name}` : 'save failed';
}

ui.zoom.addEventListener('change', frameCamera);
ui.shading.addEventListener('change', applyShading);
ui.outline.addEventListener('change', applyShading);
ui.yaw.addEventListener('input', applyFacing);
ui.hitboxes.addEventListener('change', applyFacing);
ui.clip.addEventListener('change', spawnAll);
ui.lod.addEventListener('change', spawnAll);
ui.save.addEventListener('click', () => saveShot(`view-${Date.now()}`));
window.addEventListener('resize', frameCamera);

spawnAll();
frameCamera();
ui.status.textContent = '';
window.artPreview = { scene, camera, get actors() { return actors; } }; // for console debugging
if (params.has('shot')) {
  // Deterministic capture (works in a hidden tab, where requestAnimationFrame is paused):
  // advance every clip by one second, render, save.
  document.body.classList.add('shot');
  for (let i = 0; i < 30; i++) step(1 / 30);
  await saveShot(params.get('shot'));
}
tick();
