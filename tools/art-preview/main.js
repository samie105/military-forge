/* global document, window, fetch, URLSearchParams, requestAnimationFrame */
// Art viewer: the Rookie and the yard kit at the gameplay camera (docs/01 §5: perspective,
// FOV 35°, looking down −Z at the z = 0 plane, 5° downward tilt; docs/03 §10 zoom table).
// It loads the web build exactly as the client will (apps/web/public/assets: meshopt GLB + WebP)
// and doubles as a reference for W1/W2: part assembly on one skeleton, the dye-mask shader,
// aim-offset blending by angle per weapon family and upper-body actions over locomotion.
// Standalone: three.js from the CDN. Serve the repo root with serve.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ASSETS = '../../apps/web/public/assets/';
const ART = '../../art/';
const VISIBLE_WIDTH_1X = 36; // metres at zoom 1× (docs/03 §10)
const FOV = 35;
const TILT = THREE.MathUtils.degToRad(5);
const TEAM = { blue: new THREE.Color(0x2f7dff), orange: new THREE.Color(0xff7a1a) };
const AIM_TAGS = [['down90', -90], ['down45', -45], ['level', 0], ['up45', 45], ['up90', 90]];
const ACTIONS = { reload: { rifle: 'reload_rifle', pistol: 'reload_pistol', dual: 'reload_pistol', none: 'reload_pistol' }, swap: 'swap', throw: 'throw', melee: 'melee' };
// Copied from packages/content/src/hitboxes.ts for the overlay only.
const HITBOXES = {
  standing: { head: [1.24, 0.24], torso: [0.45, 0.95, 0.3], legs: [0.1, 0.45, 0.22] },
  crouched: { head: [0.84, 0.22], torso: [0.32, 0.7, 0.3], legs: [0.1, 0.32, 0.22] },
};

const params = new URLSearchParams(window.location.search);
const $ = (id) => document.getElementById(id);
const ui = {
  zoom: $('zoom'), clip: $('clip'), family: $('family'), aim: $('aim'), shading: $('shading'),
  lod: $('lod'), yaw: $('yaw'), outline: $('outline'), hitboxes: $('hitboxes'), save: $('save'),
  stats: $('stats'), status: $('status'), dyeP: $('dyeP'), dyeS: $('dyeS'), dyeA: $('dyeA'),
};
for (const key of ['zoom', 'shading', 'lod', 'yaw', 'outline', 'family', 'aim']) if (params.has(key)) ui[key].value = params.get(key);
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
const NO_OUTLINE = { outlineParameters: { visible: false } };

// ------------------------------------------------------------------ assets

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader();
const load = (path) => loader.loadAsync(path);
function loadTex(path, data) {
  return texLoader.loadAsync(path).then((t) => {
    t.flipY = false; // glTF UV convention
    t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    return t;
  });
}
ui.status.textContent = 'loading…';
const [rookie, arsenal, catalogue, kit, body0, body1, anims] = await Promise.all([
  fetch(`${ASSETS}characters/rookie/rookie.json`).then((r) => r.json()),
  fetch(`${ASSETS}weapons/weapons.json`).then((r) => r.json()),
  fetch(`${ASSETS}cosmetics/index.json`).then((r) => r.json()),
  load(`${ART}kit/kit_yard.glb`),
  load(`${ASSETS}characters/rookie/rookie_body.glb`),
  load(`${ASSETS}characters/rookie/rookie_body_lod1.glb`),
  load(`${ASSETS}characters/rookie/rookie_anims.glb`),
]);
const UPPER = new Set(rookie.upperBodyBones);
const weaponGltf = Object.fromEntries(await Promise.all(Object.keys(arsenal.weapons).map(
  async (id) => [id, await load(`${ASSETS}weapons/${id}.glb`)])));
// ?fire=1 freezes one shot on every held weapon (assets/vfx/weapons.vfx.json): flash, light pop,
// tracer and casings in flight, all placed from the weapon's sockets.
const FIRE = params.get('fire') === '1';
const vfx = FIRE ? await fetch(`${ASSETS}vfx/weapons.vfx.json`).then((r) => r.json()) : null;
const [flashTex, tracerTex, casingsGltf] = FIRE ? await Promise.all([
  loadTex(`${ASSETS}vfx/${vfx.flash.atlas}`), loadTex(`${ASSETS}vfx/${vfx.tracer.texture}`),
  load(`${ASSETS}vfx/${vfx.casings.file}`),
]) : [];
// ?impacts=1 lays out one block per sim surface with its impact burst, particles and decals
// frozen (assets/vfx/impacts.vfx.json), and the non-gory hit marker on the hero.
const IMPACTS = params.get('impacts') === '1';
const imp = IMPACTS ? await fetch(`${ASSETS}vfx/impacts.vfx.json`).then((r) => r.json()) : null;
const [impactTex, decalTex, particleTex] = IMPACTS ? await Promise.all([
  loadTex(`${ASSETS}vfx/${imp.impact.atlas}`), loadTex(`${ASSETS}vfx/${imp.decals.atlas}`),
  loadTex(`${ASSETS}vfx/${imp.particles.texture}`),
]) : [];
// ?boom=1 freezes explosions mid-blast (assets/vfx/explosions.vfx.json): a frag at its peak with its
// shockwave and debris, a rocket mushroom, scorch decals, and the trail of a blast-launched player.
const BOOM = params.get('boom') === '1';
const boom = BOOM ? await fetch(`${ASSETS}vfx/explosions.vfx.json`).then((r) => r.json()) : null;
const boomImp = BOOM ? await fetch(`${ASSETS}vfx/impacts.vfx.json`).then((r) => r.json()) : null;
const [boomTex, ringTex, boomPartTex, boomDecalTex] = BOOM ? await Promise.all([
  loadTex(`${ASSETS}vfx/${boom.atlas}`), loadTex(`${ASSETS}vfx/${boom.shockwave.texture}`),
  loadTex(`${ASSETS}vfx/particles.webp`), loadTex(`${ASSETS}vfx/${boomImp.decals.atlas}`),
]) : [];
// Aim-pose set per held item (weapons.json `aimPose`; docs/04 §9.5).
const aimFamily = (id) => arsenal.weapons[id].aimPose ?? 'pistol';
const clips = Object.fromEntries(anims.animations.map((c) => [c.name, c]));
// Armed locomotion: the aim layer owns the upper body, so drop those tracks from the loop.
const lowerOnly = {};
const lowerClip = (name) => (lowerOnly[name] ??= new THREE.AnimationClip(
  `${name}_lower`, clips[name].duration, clips[name].tracks.filter((t) => !UPPER.has(t.name.split('.')[0]))));

// Dye textures by stem (mesh extras name them: dyeMask / dyeAlbedo).
const dyeTex = {};
async function loadDye(dir, stem) {
  const [albedo, mask] = await Promise.all([
    loadTex(`${dir}/textures/${stem}_dye_albedo.webp`, false),
    loadTex(`${dir}/textures/${stem}_dye_mask.webp`, true),
  ]);
  dyeTex[stem] = { albedo, mask };
}
await Promise.all([
  loadDye(`${ASSETS}characters/rookie`, 'rookie_body'),
  loadDye(`${ASSETS}characters/rookie`, 'rookie_body_lod1'),
]);
// Cosmetics catalogue (default parts + starter items), every LOD and dye texture up front.
const items = {};
await Promise.all(Object.values(catalogue).flat().map(async (e) => {
  const dir = `${ASSETS}cosmetics/${e.manifest.split('/')[0]}`;
  const m = await fetch(`${ASSETS}cosmetics/${e.manifest}`).then((r) => r.json());
  const lods = Object.fromEntries(await Promise.all(['lod0', 'lod1'].map(async (lod) => {
    await loadDye(dir, m.lods[lod].replace(/\.glb$/, ''));
    return [lod, await load(`${dir}/${m.lods[lod]}`)];
  })));
  items[e.id] = { ...m, lods };
}));
const SLOTS = ['headgear', 'eyewear', 'boots', 'gloves', 'jetpack'];
// Each part keeps its own default dyes (mesh extras `dyeDefaults`); the pickers recolour every
// part's channel once touched (or via ?dyeP=…), like a per-character dye loadout.
const defaults = rookie.dye.lod0.defaults;
const dyeMaterials = []; // uniform sets of every dye material
const override = { dyeP: null, dyeS: null, dyeA: null };
function applyOverrides() {
  for (const u of dyeMaterials) {
    for (const key of Object.keys(override)) if (override[key]) u[key].value.copy(override[key]);
  }
}
for (const [key, input, dflt] of [['dyeP', ui.dyeP, defaults.primary], ['dyeS', ui.dyeS, defaults.secondary], ['dyeA', ui.dyeA, defaults.accent]]) {
  if (params.has(key)) override[key] = new THREE.Color(`#${params.get(key).replace('#', '')}`);
  input.value = override[key] ? `#${override[key].getHexString()}` : dflt;
  input.addEventListener('input', () => {
    override[key] = new THREE.Color(input.value);
    applyOverrides();
  });
}

// ------------------------------------------------------------------ materials

// docs/04 §5.4: color = albedo × lerp(1, dye[channel], mask); A = team glow (docs/04 §1.4).
// The body's dye albedo carries the skin weight in its alpha (#66, dye.py): × lerp(1, 2 × skin tone, a), as
// apps/web/src/character/dyeMaterial.ts does, with the default tone (skin_04). Without it faces render pale (review L13).
const SKIN_TONE = new THREE.Color('#da9f75');
function dyeMaterial(dye, team, partDefaults, skin = false) {
  const m = new THREE.MeshToonMaterial({ map: dye.albedo, gradientMap: ramp });
  const glow = { value: team ? TEAM[team].clone() : new THREE.Color(0) };
  const uniforms = {
    dyeP: { value: new THREE.Color(partDefaults.primary ?? '#ffffff') },
    dyeS: { value: new THREE.Color(partDefaults.secondary ?? '#ffffff') },
    dyeA: { value: new THREE.Color(partDefaults.accent ?? '#ffffff') },
  };
  dyeMaterials.push(uniforms);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, { dyeMask: { value: dye.mask }, teamGlow: glow });
    Object.assign(sh.uniforms, { skinTone: { value: SKIN_TONE } });
    sh.fragmentShader = 'uniform sampler2D dyeMask;\nuniform vec3 dyeP, dyeS, dyeA, teamGlow, skinTone;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 dyeM = texture2D(dyeMask, vMapUv);
        ${skin ? 'diffuseColor.rgb *= mix(vec3(1.0), 2.0 * skinTone, diffuseColor.a); diffuseColor.a = 1.0;' : ''}
        diffuseColor.rgb *= mix(vec3(1.0), dyeP, dyeM.r) * mix(vec3(1.0), dyeS, dyeM.g) * mix(vec3(1.0), dyeA, dyeM.b);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += teamGlow * dyeM.a * 0.9;`);
  };
  m.customProgramCacheKey = () => (skin ? 'dye-toon-skin' : 'dye-toon');
  return m;
}

const variantCache = new Map();
function shadeVariants(mesh, team) {
  const src = mesh.material;
  const key = `${src.uuid}:${team}`;
  if (!variantCache.has(key)) {
    const base = { map: src.map ?? null, color: src.color.clone(), vertexColors: src.vertexColors };
    const outlineParams = team ? { thickness: 0.0022, color: TEAM[team].toArray(), alpha: 1, visible: true } : { visible: false };
    const dye = mesh.userData.dyeAlbedo ? dyeTex[mesh.userData.dyeAlbedo.replace(/_dye_albedo$/, '')] : null;
    const toon = new THREE.MeshToonMaterial({ ...base, gradientMap: ramp });
    const v = {
      dye: dye ? dyeMaterial(dye, team, mesh.userData.dyeDefaults ?? {}, mesh.userData.dyeAlbedo.startsWith('rookie_body')) : toon,
      toon,
      flat: new THREE.MeshBasicMaterial(base),
      lit: src.clone(),
    };
    for (const m of Object.values(v)) m.userData.outlineParameters = { ...outlineParams };
    variantCache.set(key, v);
  }
  return variantCache.get(key);
}
const shaded = [];
function applyShading() {
  for (const mesh of shaded) {
    mesh.material = mesh.userData.variants[ui.shading.value];
    mesh.material.userData.outlineParameters.visible = Boolean(mesh.userData.team) && ui.outline.value === 'hull';
  }
}

// ------------------------------------------------------------------ kit + dressing

// ?map=<id>: a compiled map from art/maps/<id>/ (layout + kit + MapDef); otherwise the yard slice.
const MAP = params.get('map');
const pieces = Object.fromEntries(kit.scene.children.map((o) => [o.name, o]));
function place(src, x, y, z = 0) {
  const o = src.clone();
  o.position.set(x, y, z);
  o.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = !src.name.includes('ground') && !src.name.includes('far');
    m.receiveShadow = true;
    m.userData.variants = shadeVariants(m, null);
    shaded.push(m);
  });
  scene.add(o);
}
// The reference for W1's map renderer: one InstancedMesh per (piece, flip), so the static map costs
// one draw call per pair (22 for the Street Market) instead of one per placement. Mirrored pieces get
// their own geometry, x negated and the winding reversed, so every material stays single-sided (the
// kit exports doubleSided false).
function mirrored(geometry) {
  const g = geometry.clone();
  for (const name of ['position', 'normal']) {
    const a = g.attributes[name];
    if (a) for (let i = 0; i < a.count; i++) a.setX(i, -a.getX(i));
  }
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
function placeInstanced(items, kitPieces) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.piece}|${it.flip ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const m4 = new THREE.Matrix4();
  let draws = 0;
  for (const [key, list] of groups) {
    const [name, flip] = key.split('|');
    const src = kitPieces[name];
    src.updateMatrixWorld(true);
    src.traverse((m) => {
      if (!m.isMesh) return;
      const inst = new THREE.InstancedMesh(flip === '1' ? mirrored(m.geometry) : m.geometry, m.material, list.length);
      list.forEach((it, i) => inst.setMatrixAt(i, m4.makeTranslation(it.x, it.y ?? 0, it.z ?? 0).multiply(m.matrixWorld)));
      inst.computeBoundingSphere();
      inst.castShadow = !name.includes('ground') && !name.includes('far');
      inst.receiveShadow = true;
      inst.userData.variants = shadeVariants(inst, null);
      shaded.push(inst);
      scene.add(inst);
      draws += 1;
    });
  }
  document.body.dataset.mapDraws = `${draws} draws for ${items.length} placements`;
}
let layout = null;
let mapDef = null;
if (MAP) {
  [layout, mapDef] = await Promise.all([
    fetch(`${ART}maps/${MAP}/layout.json`).then((r) => r.json()),
    fetch(`${ART}maps/${MAP}/${MAP}.map.json`).then((r) => r.json()),
  ]);
  const mapKit = await load(`${ASSETS}${layout.kit}`);
  const mk = Object.fromEntries(mapKit.scene.children.map((o) => [o.name, o]));
  placeInstanced([...layout.pieces, ...(layout.decor ?? [])], mk);
  if (layout.palette) {
    scene.background = new THREE.Color(layout.palette.sky);
    scene.fog = new THREE.Fog(new THREE.Color(layout.palette.fog), 30, 110);
  }
} else {
  for (let x = -18; x <= 18; x += 4) place(pieces.ground_4m, x, 0);
  place(pieces.platform_2m, -5.5, 3.0);
  place(pieces.platform_2m, 3.0, 4.0);
  place(pieces.platform_2m, 8.0, 2.25);
  place(pieces.crate_1m, 5.0, 0);
  place(pieces.crate_1m, 6.0, 0);
  place(pieces.crate_1m, 5.5, 1.0);
}

// Preview-only dressing (not kit pieces): fill under the ground, a far skyline, slice markers.
const fill = new THREE.Mesh(new THREE.BoxGeometry(220, 12, 2), new THREE.MeshBasicMaterial({ color: MAP ? 0x5a3f30 : 0x4f4b45, userData: NO_OUTLINE }));
fill.position.set(0, -7.3, 0);
scene.add(fill);
const far = new THREE.MeshBasicMaterial({ color: 0x8c9cab, userData: NO_OUTLINE });
for (let i = 0; i < (MAP ? 0 : 18); i++) {
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
for (const x of MAP ? [] : [-10, 10]) {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, 1.2), new THREE.Vector3(x, 9, 1.2)]), markerMat);
  line.computeLineDistances();
  scene.add(line);
}

// Compiled collision (what the sim uses) drawn over the art: solids white, one-ways yellow.
const collision = new THREE.Group();
if (mapDef) {
  const solidMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
  const owMat = new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false });
  for (const s of mapDef.solids) {
    const pts = [];
    for (let i = 0; i < s.points.length; i += 2) pts.push(new THREE.Vector3(s.points[i], s.points[i + 1], 1.1));
    collision.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), solidMat));
  }
  for (const w of mapDef.oneWays) {
    collision.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(w.ax, w.ay, 1.1), new THREE.Vector3(w.bx, w.by, 1.1)]), owMat));
  }
  collision.renderOrder = 30;
  scene.add(collision);
}

// ------------------------------------------------------------------ props on sockets (placeholders)

// Weapon frame = socket frame (docs/04 §9.4): +Y toward the muzzle, +Z up, origin at the grip,
// so a weapon attaches to its socket with an identity transform.
function weapon(id) {
  const w = weaponGltf[id].scene.clone();
  w.traverse((o) => { if (o.isMesh) o.userData.variants = shadeVariants(o, null); });
  if (FIRE) fireFx(id, w);
  return w;
}

// Two crossed quads: the flash/tracer plane holds the muzzle axis (weapon +Y) and faces the side
// camera (normal = weapon ±X); the second one is turned 90° about the axis for volume.
const CROSSED = [
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)),
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)),
];
function crossedQuads(geometry, material) {
  const g = new THREE.Group();
  for (const basis of CROSSED) {
    const m = new THREE.Mesh(geometry, material);
    m.quaternion.setFromRotationMatrix(basis);
    m.renderOrder = 5;
    g.add(m);
  }
  return g;
}
const fxMaterial = (map, color = 0xffffff) => new THREE.MeshBasicMaterial({
  map, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  toneMapped: false, userData: NO_OUTLINE,
});
function fireFx(id, gun) {
  const hook = vfx.weapons[id];
  const muzzle = gun.getObjectByName('muzzle');
  const eject = gun.getObjectByName('eject');
  if (hook?.flash && muzzle) {
    const style = vfx.flash.styles[hook.flash];
    const [cw, ch] = vfx.flash.cell;
    const [aw, ah] = vfx.flash.atlasSize;
    const cell = style.frames[[...id].reduce((h, c) => h + c.charCodeAt(0), 0) % style.frames.length];
    const cx = (cell % (aw / cw)) * cw;
    const cy = Math.floor(cell / (aw / cw)) * ch;
    const s = hook.flashScale ?? 1;
    const geo = new THREE.PlaneGeometry(style.quad.widthM * s, style.quad.heightM * s)
      .translate(style.quad.widthM * s * (0.5 - style.quad.originU), 0, 0);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (cx + uv.getX(i) * cw) / aw, (cy + (1 - uv.getY(i)) * ch) / ah); // flipY false: v down from the top
    }
    muzzle.add(crossedQuads(geo, fxMaterial(flashTex)));
    const l = style.light;
    const light = new THREE.PointLight(new THREE.Color(l.color), l.intensity, l.rangeM, 2);
    muzzle.add(light);
  }
  const tracer = hook?.tracer && vfx.tracer.styles[hook.tracer];
  if (tracer && muzzle) {
    const len = tracer.lengthM;
    const geo = new THREE.PlaneGeometry(len, tracer.widthM).translate(0.6 + len / 2, 0, 0);
    muzzle.add(crossedQuads(geo, fxMaterial(tracerTex, new THREE.Color(tracer.tint))));
  }
  const casing = hook?.casing && hook.eject === 'shot' && casingsGltf.scene.getObjectByName(`casing_${hook.casing}`);
  if (casing && eject) {
    const type = vfx.casings.types[hook.casing];
    const dir = new THREE.Vector3(...(eject.userData.dir ?? [1, 0, 0])).normalize();
    // a frozen arc: three casings at 30 / 70 / 120 ms, gravity along the weapon's −Z
    for (const [i, t] of [0.03, 0.07, 0.12].entries()) {
      const c = casing.clone();
      c.position.copy(dir).multiplyScalar(type.speedMps * t).add(new THREE.Vector3(0, 0, -4.9 * t * t));
      c.rotation.set(1.1 * i + 0.4, 2.3 * i, 0.7 * i);
      c.traverse((o) => { if (o.isMesh) o.userData.variants = shadeVariants(o, null); });
      eject.add(c);
    }
  }
}

// A quad showing one atlas cell: `size` m square (or w × h), with `anchor` (u, v of the cell) on the origin.
function cellQuad(tex, cell, [cw, ch], [aw, ah], w, h = w, anchor = [0.5, 0.5]) {
  const geo = new THREE.PlaneGeometry(w, h).translate(w * (0.5 - anchor[0]), h * (anchor[1] - 0.5), 0);
  const cols = aw / cw;
  const cx = (cell % cols) * cw;
  const cy = Math.floor(cell / cols) * ch;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (cx + uv.getX(i) * cw) / aw, (cy + (1 - uv.getY(i)) * ch) / ah);
  return geo;
}
function boomScene() {
  const plain = (map, color = 0xffffff, opacity = 1) => new THREE.MeshBasicMaterial({
    map, color, transparent: true, opacity, depthWrite: false, toneMapped: false, userData: NO_OUTLINE,
  });
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blast = (styleName, frame, x, y, ringT) => {
    const st = boom.styles[styleName];
    const fb = boom.flipbooks[st.flipbook];
    const size = fb.cellM * st.scale;
    const cell = fb.firstCell[0] + (frame % 4) + Math.floor(frame / 4) * 8;
    const q = new THREE.Mesh(cellQuad(boomTex, cell, boom.cell, boom.atlasSize, size, size, fb.anchorUV), plain(boomTex));
    q.position.set(x, y, 0.8);
    q.renderOrder = 9;
    scene.add(q);
    // the shockwave at ringT of its growth, showing the blast radius
    const r = st.shockwave.fromM + (st.shockwave.toM - st.shockwave.fromM) * ringT;
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(2 * r, 2 * r),
      fxMaterial(ringTex, new THREE.Color(st.shockwave.tint)));
    ring.material.opacity = st.shockwave.opacity * (1 - ringT * 0.5);
    ring.position.set(x, y + (fb.anchor === 'base' ? 0.6 : 0), 0.7);
    ring.renderOrder = 8;
    scene.add(ring);
    const light = new THREE.PointLight(new THREE.Color(st.light.color), st.light.intensity, st.light.rangeM, 2);
    light.position.set(x, y + 0.8, 1.2);
    scene.add(light);
    // debris chips flying out, dust rolling along the ground
    for (const p of [st.debris, st.dust]) {
      for (let k = 0; k < p.count[1]; k++) {
        const ang = p.alongGround ? (k % 2 ? 0.15 : Math.PI - 0.15) : THREE.MathUtils.degToRad(90 + (rnd() * 2 - 1) * p.coneDeg);
        const d = (p.alongGround ? 0.8 : 0.8) + rnd() * (p.alongGround ? 2.2 : 2.6);
        const geo = cellQuad(boomPartTex, boomImp.particles.cells[p.kind], [64, 64], [256, 64], p.sizeM);
        const m = new THREE.Mesh(geo, plain(boomPartTex, new THREE.Color(p.tint), p.alongGround ? 0.8 : 1));
        m.position.set(x + Math.cos(ang) * d, y + 0.1 + Math.sin(ang) * d * (p.alongGround ? 0.2 : 1), 0.75);
        m.rotation.z = rnd() * Math.PI;
        scene.add(m);
      }
    }
    // scorch on the ground slab's front face, at the blast
    const dec = boomImp.decals.styles[st.scorch.decal];
    const sc = new THREE.Mesh(cellQuad(boomDecalTex, dec.cell, boomImp.decals.cell, boomImp.decals.atlasSize, st.scorch.sizeM, st.scorch.sizeM * 0.5),
      plain(boomDecalTex));
    sc.position.set(x, -0.25, 1.01);
    scene.add(sc);
  };
  blast('frag', 4, -12.5, 0.6, 0.65);
  blast('rocket', 6, -4.6, 0.0, 0.85);
  // a blast-launched player's trail: puffs along the arc behind Blue 2 (NOTES §17)
  const lt = boom.launchTrail;
  const to = ROSTER.find((r) => r.name === 'Blue 2');
  for (let k = 1; k <= 8; k++) {
    const t = k / 9;
    const m = new THREE.Mesh(cellQuad(boomPartTex, boomImp.particles.cells[lt.kind], [64, 64], [256, 64], lt.sizeM * (0.5 + t * 0.6)),
      plain(boomPartTex, new THREE.Color(lt.tint), 0.35 + 0.6 * t));
    m.position.set(to.x - (1 - t) * 7, to.y + 0.6 - (1 - t) ** 2 * 4.2, 0.5);
    scene.add(m);
  }
}
function impactBoard() {
  const surfaces = [['concrete', 0x9a9a96], ['metal', 0x6f7680], ['wood', 0xa3743f], ['dirt', 0xb89466], ['glass', 0xcfe6f2]];
  const toonish = (color, glass) => new THREE.MeshToonMaterial({ color, gradientMap: ramp, transparent: glass, opacity: glass ? 0.55 : 1 });
  const normal = (map, color = 0xffffff) => new THREE.MeshBasicMaterial({
    map, color, transparent: true, depthWrite: false, toneMapped: false, userData: NO_OUTLINE,
  });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  surfaces.forEach(([name, color], i) => {
    const x = -16.2 + i * 1.7;
    const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), toonish(color, name === 'glass'));
    block.position.set(x, 0.5, 0);
    scene.add(block);
    const style = imp.impact.styles[name];
    const [aw, ah] = imp.impact.atlasSize;
    // a burst on the top (normal +Y) and one on the left face (normal −X)
    for (const [fi, pos, rot] of [[0, [x + 0.15, 1.0, 0.55], 0], [2, [x - 0.5, 0.45, 0.55], Math.PI / 2]]) {
      const q = new THREE.Mesh(cellQuad(impactTex, style.frames[fi], imp.impact.cell, [aw, ah], style.quadM, style.quadM, style.hitUV),
        normal(impactTex));
      q.position.set(...pos);
      q.rotation.z = rot;
      q.renderOrder = 6;
      scene.add(q);
    }
    // frozen particles above the top burst
    for (const p of style.particles) {
      const [cw] = imp.particles.cell;
      for (let k = 0; k < p.count[1]; k++) {
        const a = THREE.MathUtils.degToRad((rnd() * 2 - 1) * p.coneDeg);
        const d = 0.15 + rnd() * 0.45;
        const geo = cellQuad(particleTex, imp.particles.cells[p.kind], imp.particles.cell, [cw * 4, cw], p.sizeM * (p.kind === 'spark' ? 2.5 : 1), p.sizeM);
        const m = new THREE.Mesh(geo, p.blend === 'additive' ? fxMaterial(particleTex, new THREE.Color(p.tint)) : normal(particleTex, new THREE.Color(p.tint)));
        m.position.set(x + 0.15 + Math.sin(a) * d, 1.0 + Math.cos(a) * d, 0.6);
        m.rotation.z = p.kind === 'spark' ? Math.PI / 2 - a : rnd() * Math.PI;
        m.renderOrder = 7;
        scene.add(m);
      }
    }
    // decals on the front face
    const dec = imp.decals.styles[style.decal];
    const [dw, dh] = imp.decals.atlasSize;
    for (const [dx, dy] of [[-0.25, 0.7], [0.2, 0.35], [-0.1, 0.15]]) {
      const m = new THREE.Mesh(cellQuad(decalTex, dec.cell, imp.decals.cell, [dw, dh], dec.sizeM * 1.6), normal(decalTex));
      m.position.set(x + dx, dy, 0.503);
      m.rotation.z = rnd() * Math.PI * 2;
      scene.add(m);
    }
  });
  // the hit marker on the hero's chest
  const hero = ROSTER.find((r) => r.hero);
  const ps = imp.impact.styles.player;
  const marker = new THREE.Mesh(cellQuad(impactTex, ps.frames[1], imp.impact.cell, imp.impact.atlasSize, ps.quadM), normal(impactTex));
  marker.position.set(hero.x + 0.05, hero.y + 0.95, 0.45);
  marker.renderOrder = 8;
  scene.add(marker);
}
// One flame per nozzle: `points` are the nozzle exits in socket_jetpack's frame (from the part's
// `nozzles` extra); without them, the twin-tank pair.
function makeFlame(points) {
  const g = new THREE.Group();
  const fx = { transparent: true, depthWrite: false, userData: NO_OUTLINE };
  const outer = new THREE.MeshBasicMaterial({ ...fx, color: 0xff8a1f, opacity: 0.9 });
  const inner = new THREE.MeshBasicMaterial({ ...fx, color: 0xfff1b0, opacity: 0.95 });
  const spots = points ?? [new THREE.Vector3(-0.065, -0.26, -0.1), new THREE.Vector3(0.065, -0.26, -0.1)];
  const top = Math.max(...spots.map((p) => p.y));
  for (const p of spots) {
    for (const [mat, r, len] of [[outer, 0.075, 0.62], [inner, 0.038, 0.34]]) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(r * (spots.length > 1 ? 1 : 1.3), len, 10), mat);
      m.rotation.x = Math.PI;
      m.position.set(p.x, p.y - top - len / 2, p.z);
      m.renderOrder = mat === inner ? 2 : 1;
      g.add(m);
    }
  }
  const pivot = new THREE.Group();  // scaled from the nozzle line by the flicker
  pivot.position.y = top;
  pivot.add(g);
  return pivot;
}

// The equipped jetpack's nozzle exits (glTF character space) in socket_jetpack's bind frame.
function nozzlePoints(root, parts) {
  let pts = null;
  for (const p of parts) p.scene.traverse((o) => { if (o.isSkinnedMesh && o.userData.nozzles) pts = o.userData.nozzles; });
  let body = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !body) body = o; });
  if (!pts || !body) return null;
  const i = body.skeleton.bones.findIndex((b) => b.name === 'socket_jetpack');
  if (i < 0) return null;
  const inv = body.skeleton.boneInverses[i];
  return pts.map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(inv));
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
    g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([...pts(0, y1, r, 0, Math.PI), ...pts(0, y0, r, Math.PI, Math.PI * 2)]), mat));
  }
  g.renderOrder = 20;
  return g;
}

// ------------------------------------------------------------------ team silhouettes

// Screen-space team silhouette (docs/04 §5.5): each team's characters go flat into a mask, then a
// full-screen pass paints the team colour on empty pixels next to the mask. Only the outer
// silhouette gets a line; the inverted hull also outlines every interior edge.
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
      float inner = 0.0;
      for (int ring = 1; ring <= 2; ring++) {
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 0.5235988;
          vec4 s = texture2D(tMask, vUv + vec2(cos(a), sin(a)) * texel * radius * float(ring) * 0.5);
          if (s.a > best.a) best = s;
          if (ring == 1 && s.a > 0.5) inner += 1.0;
        }
      }
      // A pixel the mask surrounds is a crack between mesh shells, not the outside edge.
      if (best.a < 0.5 || inner >= 8.0) discard;
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

// ------------------------------------------------------------------ characters

// Assemble body + parts on one skeleton (what W2's assembler does, minus the merge).
function assemble(bodyGltf, partGltfs) {
  const root = SkeletonUtils.clone(bodyGltf.scene);
  let body = null;
  root.traverse((o) => { if (o.isSkinnedMesh) body = o; });
  for (const part of partGltfs) {
    part.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const mesh = o.clone();
      const bones = o.skeleton.bones.map((b) => body.skeleton.getBoneByName(b.name));
      mesh.bind(new THREE.Skeleton(bones, o.skeleton.boneInverses), o.bindMatrix);
      body.parent.add(mesh);
    });
  }
  return root;
}

const ROSTER = [
  { name: 'Rookie', team: 'blue', clip: 'idle', weapon: 'k47', x: -1.0, y: 0, facing: 1, hero: true },
  { name: 'Blue 2', team: 'blue', clip: 'jet_hover', weapon: 'hawk50', x: -5.5, y: 4.4, facing: 1, sweep: 0.9,
    outfit: { headgear: 'headgear_combat_helmet', eyewear: 'eyewear_aviators', boots: 'boots_jungle', gloves: 'gloves_tactical', jetpack: 'jetpack_rocket' } },
  { name: 'Blue 3', team: 'blue', clip: 'jet_ascend', weapon: 'dual', x: -8.6, y: 1.6, facing: 1, aim: 25,
    outfit: { headgear: 'headgear_beret', boots: 'boots_sneakers', jetpack: 'jetpack_drum' } },
  { name: 'Orange 1', team: 'orange', clip: 'run', weapon: 'breacher', x: 3.0, y: 4.0, facing: -1, sweep: 0.6,
    outfit: { headgear: 'headgear_bandana', eyewear: 'eyewear_gas_mask', jetpack: 'jetpack_drum', gloves: 'gloves_tactical' } },
  { name: 'Orange 2', team: 'orange', clip: 'crouch_idle', weapon: 'widow', x: 7.3, y: 0, facing: -1, aim: -8,
    outfit: { headgear: 'headgear_field_cap', eyewear: 'eyewear_aviators', boots: 'boots_jungle' } },
  { name: 'Orange 3', team: 'orange', clip: 'fall', weapon: 'none', x: 8.4, y: 4.6, facing: -1,
    outfit: { headgear: 'headgear_combat_helmet', boots: 'boots_sneakers', jetpack: 'jetpack_rocket' } },
];
for (const name of ['idle', 'walk', 'run', 'crouch_idle', 'crouch_walk', 'jet_ascend', 'jet_hover', 'fall']) {
  const opt = document.createElement('option');
  opt.value = opt.textContent = name;
  ui.clip.add(opt);
}
ui.clip.value = params.get('clip') ?? 'idle';
ui.family.replaceChildren();
for (const [value, label] of [...Object.entries(arsenal.weapons).map(([id, w]) => [id, w.name]), ['dual', 'Hammer + Buzz (dual)'], ['none', 'none']]) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  ui.family.add(opt);
}
ui.family.value = params.get('family') ?? 'k47';
// Locker-style slot pickers for the hero (default part first, "none" for optional slots).
ui.slots = {};
for (const slot of SLOTS) {
  const label = document.createElement('label');
  label.textContent = slot;
  const sel = document.createElement('select');
  const entries = (catalogue[slot] ?? []).slice().sort((x, y) => Number(y.default) - Number(x.default));
  const options = [...(rookie.defaultParts[slot] ? [] : [['none', 'none']]), ...entries.map((e) => [e.id, e.name])];
  for (const [value, text] of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    sel.add(opt);
  }
  sel.value = params.get(slot) ?? rookie.defaultParts[slot] ?? 'none';
  sel.addEventListener('change', spawnAll);
  label.append(sel);
  $('locker').append(label);
  ui.slots[slot] = sel;
}

// On a map, stand the roster on map spawns instead of the yard positions.
if (layout) {
  const at = [[-26, 0], [-47, 8], [-20, 12], [4, 0], [26, 0], [0, 10]];
  ROSTER.forEach((r, i) => Object.assign(r, { x: at[i][0], y: at[i][1] }));
}
let actors = [];
function spawnAll() {
  for (const a of actors) {
    scene.remove(a.root, a.hitboxes);
    for (const m of a.meshes) shaded.splice(shaded.indexOf(m), 1);
  }
  const lod1 = ui.lod.value === '1';
  actors = ROSTER.map((r) => {
    const clipName = r.hero ? ui.clip.value : r.clip;
    const held = r.hero ? ui.family.value : r.weapon;
    const family = held === 'none' ? 'none' : held === 'dual' ? 'dual' : aimFamily(held);
    const lod = lod1 ? 'lod1' : 'lod0';
    const outfit = r.hero ? Object.fromEntries(SLOTS.map((sl) => [sl, ui.slots[sl].value])) : { ...rookie.defaultParts, ...r.outfit };
    const parts = SLOTS.map((sl) => outfit[sl]).filter((id) => id && id !== 'none').map((id) => items[id].lods[lod]);
    const root = assemble(lod1 ? body1 : body0, parts);
    root.position.set(r.x, r.y, 0);
    const sock = (n) => root.getObjectByName(n);
    // dual wield: the classic Buzz + Hammer combo (docs/03 §5)
    if (held === 'dual') {
      sock('socket_weapon_R').add(weapon('hammer44'));
      sock('socket_weapon_L').add(weapon('buzz'));
    } else if (held !== 'none') {
      sock('socket_weapon_R').add(weapon(held));
    }
    sock('socket_nameplate').add(makeNameplate(r.name, r.team));
    const flame = clipName.startsWith('jet_');
    if (flame) sock('socket_jetpack').add(makeFlame(nozzlePoints(root, parts)));
    const meshes = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      if (o.material.blending !== THREE.AdditiveBlending && !o.material.userData.outlineParameters) {
        o.layers.enable(TEAM_LAYER[r.team]);
      }
      if (o.isSkinnedMesh) {
        o.userData.team = r.team;
        o.userData.variants = shadeVariants(o, r.team);
      }
      if (o.userData.variants) {
        meshes.push(o);
        shaded.push(o);
      }
    });
    const mixer = new THREE.AnimationMixer(root);
    const armed = family !== 'none';
    mixer.clipAction(armed ? lowerClip(clipName) : clips[clipName]).play();
    const aims = armed ? AIM_TAGS.map(([tag]) => {
      const act = mixer.clipAction(clips[`aim_${family}_${tag}`]);
      act.play();
      act.setEffectiveWeight(0);
      return act;
    }) : [];
    mixer.setTime((r.x + 20) * 0.37);
    const crouched = clipName.startsWith('crouch');
    const hitboxes = makeHitboxes(crouched ? HITBOXES.crouched : HITBOXES.standing);
    hitboxes.position.set(r.x, r.y, 0);
    scene.add(root, hitboxes);
    return { ...r, held, family, flame, root, meshes, mixer, aims, hitboxes, action: null };
  });
  applyFacing();
  applyShading();
  applyOverrides();
}
function applyFacing() {
  const yaw = THREE.MathUtils.degToRad(Number(ui.yaw.value));
  for (const a of actors) {
    a.root.rotation.y = a.facing * (Math.PI / 2 - yaw);
    a.hitboxes.visible = ui.hitboxes.checked;
  }
  collision.visible = ui.hitboxes.checked;
}

// Aim layer: blend the two family poses around the aim angle; an action takes over the upper body.
function updateAim(a, time) {
  if (!a.aims.length) return;
  const deg = a.hero ? Number(ui.aim.value) : a.sweep ? 70 * Math.sin(time * a.sweep + a.x) : (a.aim ?? 0);
  const f = (THREE.MathUtils.clamp(deg, -90, 90) + 90) / 45;
  const i = Math.min(3, Math.floor(f));
  const t = f - i;
  const actionW = a.action ? a.action.getEffectiveWeight() : 0;
  a.aims.forEach((act, k) => act.setEffectiveWeight((k === i ? 1 - t : k === i + 1 ? t : 0) * (1 - actionW)));
}
function playAction(a, kind) {
  const name = typeof ACTIONS[kind] === 'string' ? ACTIONS[kind] : ACTIONS[kind][a.family];
  const act = a.mixer.clipAction(clips[name]);
  act.reset().setLoop(THREE.LoopOnce, 1).fadeIn(0.08).play();
  act.clampWhenFinished = false;
  a.action = act;
  const done = (e) => {
    if (e.action !== act) return;
    a.mixer.removeEventListener('finished', done);
    act.fadeOut(0.12);
    window.setTimeout(() => { if (a.action === act) a.action = null; }, 120);
  };
  a.mixer.addEventListener('finished', done);
}
for (const b of document.querySelectorAll('[data-action]')) {
  b.addEventListener('click', () => playAction(actors[0], b.dataset.action));
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
  const target = params.has('cx')
    ? new THREE.Vector3(Number(params.get('cx')), Number(params.get('cy') ?? 6), 0)
    : focus && mult < 1
    ? new THREE.Vector3(focus.x, focus.y + 0.9, 0)
    : mult < 1
    ? new THREE.Vector3(hero.x + 3.2, 2.2, 0)
    : new THREE.Vector3(0, 0.28 * (visibleW / camera.aspect), 0);
  camera.position.set(target.x, target.y + dist * Math.sin(TILT), dist * Math.cos(TILT));
  // Fog only for the depth layers behind the gameplay plane, whatever the zoom.
  scene.fog.near = dist + 4;
  scene.fog.far = dist + (MAP ? 70 : 90);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

const clock = new THREE.Clock();
let frames = 0;
let time = 0;
function step(dt) {
  time += dt;
  for (const a of actors) {
    updateAim(a, time);
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
    ui.stats.textContent = `draw calls ${calls}\ntriangles  ${triangles.toLocaleString()}\nhero ${ui.clip.value} · ${ui.family.value} · aim ${ui.aim.value}°`;
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
for (const el of [ui.clip, ui.lod, ui.family]) el.addEventListener('change', spawnAll);
ui.save.addEventListener('click', () => saveShot(`view-${Date.now()}`));
window.addEventListener('resize', frameCamera);

if (IMPACTS) impactBoard();
if (BOOM) boomScene();
spawnAll();
frameCamera();
ui.status.textContent = '';
window.artPreview = { scene, camera, get actors() { return actors; }, playAction }; // console debugging
if (params.has('shot')) {
  // Deterministic capture (works in a hidden tab, where requestAnimationFrame is paused):
  // optionally start an action, advance every clip, render, save.
  document.body.classList.add('shot');
  if (params.has('action')) playAction(actors[0], params.get('action'));
  const secs = Number(params.get('t') ?? 1);
  for (let i = 0; i < Math.round(secs * 30); i++) step(1 / 30);
  await saveShot(params.get('shot'));
}
tick();
