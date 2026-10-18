/**
 * Feel report: objective numbers for the current tuning, checked against the feel targets, so
 * playtest impressions can be compared against measurements (docs/02 §19).
 * Run: pnpm --filter @military-forge/sim feel        (sweep for better values: pnpm --filter @military-forge/sim tune)
 */
import { BREACHER, BUZZ, HAMMER, K47, SMOKE, WIDOW, defaultTuning, grenades, weapons } from '@military-forge/content';
import {
  measureBlast,
  measureDash,
  measureEmp,
  measureEvents,
  measureFlash,
  measureGas,
  measureGrenade,
  measureMine,
  measureMovement,
  measureRecoil,
  measureRecoilTopSpeed,
  measureShield,
  measureSprayDrift,
  measureWeapon,
  measureZones,
  type DashMetrics,
  type EventMetrics,
  type MovementMetrics,
  type ZoneMetrics,
} from './feel-lib';
import {
  BLAST_TARGETS,
  DASH_TARGETS,
  EMP_TARGETS,
  EVENT_TARGETS,
  FLASH_TARGETS,
  FOG_TARGETS,
  GAS_TARGETS,
  MINE_TARGETS,
  MOVEMENT_TARGETS,
  RECOIL_TARGETS,
  SPRAY_TARGETS,
  THROW_TARGETS,
  WEAPON_TARGETS,
  ZONE_TARGETS,
} from './feel-targets';

const rows: [string, string, string][] = [];
const mark = (ok: boolean) => (ok ? '✓' : '✗ off target');

const m = measureMovement();
for (const t of MOVEMENT_TARGETS) {
  const v = m[t.key as keyof MovementMetrics];
  rows.push([t.label, v.toFixed(2), `${mark(v >= t.min && v <= t.max)}  (target ${t.min}–${t.max}: ${t.why})`]);
}
rows.push(['Airtime, take-off → landing (s)', m.airtime.toFixed(2), '']);

// dash (docs/02 §21)
const d = measureDash();
for (const t of DASH_TARGETS) {
  const v = d[t.key as keyof DashMetrics];
  rows.push([t.label, v.toFixed(2), `${mark(v >= t.min && v <= t.max)}  (target ${t.min}–${t.max}: ${t.why})`]);
}
rows.push(['Dash: up-right from standing, apex / run (m)', `${d.diagUp.toFixed(2)} / ${d.diagRun.toFixed(2)}`, '']);
rows.push(['Fall from a 6 m hover, no dash (s)', d.fallTime.toFixed(2), '']);

for (const w of weapons) {
  const distances = w.fireMode === 'melee' ? [1, 5] : [5, 12, 18];
  for (const dist of distances) {
    for (const air of [false, true]) {
      const r = measureWeapon(w.index, dist, air);
      const t = WEAPON_TARGETS.find((x) => x.weapon === w.id && x.distance === dist && x.airborne === air);
      const ok =
        !t ||
        ((t.hitMin === undefined || r.hitRate >= t.hitMin) && (t.hitMax === undefined || r.hitRate <= t.hitMax) && (t.ttkMax === undefined || r.ttk <= t.ttkMax));
      const ttk = r.killRate === 0 ? 'no kill  ' : `TTK ${r.ttk.toFixed(2)} s`;
      const partial = r.killRate > 0 && r.killRate < 1 ? ` (${(100 * r.killRate).toFixed(0)}% killed in 10 s)` : '';
      rows.push([`${w.name} @ ${dist} m ${air ? '(airborne)' : '(grounded)'}`, `${ttk} · hits ${(100 * r.hitRate).toFixed(0)}%${partial}`, t ? mark(ok) : '']);
    }
  }
}

for (const t of BLAST_TARGETS) {
  const b = measureBlast(t.distance);
  const ok = b.flew >= t.flewMin && b.flew <= t.flewMax && b.peak >= t.peakMin;
  rows.push([`Frag ${t.distance} m away: flight / peak (m)`, `${b.flew.toFixed(1)} / ${b.peak.toFixed(1)} · ${b.hpLeft.toFixed(0)} HP left`, `${mark(ok)}  (target ${t.flewMin}–${t.flewMax} m, peak ≥ ${t.peakMin}: ${t.why})`]);
}
for (const def of grenades) {
  if (def.effect === 'mine') continue; // it doesn't bounce or go off on a fuse: it sticks (the mine rows below)
  const g = measureGrenade({}, def.index);
  const t = THROW_TARGETS.find((x) => x.grenade === def.id);
  const ok = !!t && g.firstBounce >= t.bounceMin && g.firstBounce <= t.bounceMax && g.detonation >= t.offMin && g.detonation <= t.offMax;
  rows.push([`${def.name} @45°: first bounce / goes off (m)`, `${g.firstBounce.toFixed(1)} / ${g.detonation.toFixed(1)}`, t ? `${mark(ok)}  (target ${t.bounceMin}–${t.bounceMax} / ${t.offMin}–${t.offMax}: ~30% farther, owner: "the bombs should go far")` : '']);
}
const smoke = SMOKE.cloud;
rows.push(['Smoke cloud: radius / opaque / life', `${smoke.radius} m / ${(smoke.radius * 0.85).toFixed(1)} m / ${smoke.duration} s`, 'hides anyone fully inside from bots and from the AOI']);
for (const t of GAS_TARGETS) {
  const m = measureGas(t.distance);
  const ok = (t.ttkMax === undefined || m.ttk <= t.ttkMax) && (t.dpsMin === undefined || m.dps >= t.dpsMin) && (t.dpsMax === undefined || m.dps <= t.dpsMax);
  const life = Number.isNaN(m.ttk) ? `survives (${m.taken.toFixed(0)} dmg)` : `dead in ${m.ttk.toFixed(2)} s`;
  const range = [t.ttkMax !== undefined ? `TTK ≤ ${t.ttkMax} s` : '', t.dpsMin !== undefined ? `${t.dpsMin}–${t.dpsMax} dmg/s` : ''].filter(Boolean).join(', ');
  rows.push([`Gas, standing ${t.distance} m from the pop`, `${m.dps.toFixed(1)} dmg/s · ${life}`, `${mark(ok)}  (target ${range}: ${t.why})`]);
}

// map zones at their kinds' defaults (docs/02 §20)
const z = measureZones();
for (const t of ZONE_TARGETS) {
  const v = z[t.key as keyof Omit<ZoneMetrics, 'fogReach'>];
  rows.push([t.label, v.toFixed(2), `${mark(v >= t.min && v <= t.max)}  (target ${t.min}–${t.max}: ${t.why})`]);
}
for (const [name, reach] of Object.entries(z.fogReach)) {
  const t = FOG_TARGETS.find((x) => x.weapon === name);
  const clear = weapons.find((w) => w.name === name)!.range;
  rows.push([`Fog: ${name} reach (m)`, `${reach.toFixed(1)} of ${clear}`, t ? `${mark(reach >= t.min && reach <= t.max)}  (target ${t.min}–${t.max}: ${t.why})` : '']);
}

// map events at their kinds' defaults (docs/02 §20.7)
const ev = measureEvents();
for (const t of EVENT_TARGETS) {
  const v = ev[t.key as keyof EventMetrics];
  rows.push([t.label, v.toFixed(2), `${mark(v >= t.min && v <= t.max)}  (target ${t.min}–${t.max}: ${t.why})`]);
}

// riot shield: shooting a carrier (Hammer in hand) through the raised shield (front), at its bare
// back with the shield up (flank), and at the shield slung on its back (back)
for (const w of [HAMMER, BUZZ, K47, BREACHER, WIDOW]) {
  for (const dist of [5, 12]) {
    const f = measureShield(w.index, dist, 'front');
    const fl = measureShield(w.index, dist, 'flank');
    const b = measureShield(w.index, dist, 'back');
    const ttk = (r: typeof f) => (r.killRate === 0 ? 'no kill' : `${r.ttk.toFixed(2)} s${r.killRate < 1 ? ` (${(100 * r.killRate).toFixed(0)}% killed in 20 s)` : ''}`);
    const brk = (r: typeof f) => (r.breakRate === 0 ? 'never broke' : `broke in ${(100 * r.breakRate).toFixed(0)}% at ${r.breakAt.toFixed(2)} s`);
    rows.push([
      `Shield: ${w.name} @ ${dist} m, front / flank / back`,
      `front ${ttk(f)} (${brk(f)}, ${(100 * f.shieldRate).toFixed(0)}% on it) · flank ${ttk(fl)} · back ${ttk(b)} (${brk(b)}, ${(100 * b.shieldRate).toFixed(0)}% on it)`,
      f.killRate > 0 && fl.killRate > 0 && b.killRate > 0 ? `front ×${(f.ttk / fl.ttk).toFixed(1)}, back ×${(b.ttk / fl.ttk).toFixed(1)}` : '',
    ]);
  }
}

for (const t of FLASH_TARGETS) {
  const f = measureFlash(t.distance, t.lookAway, t.wall);
  const ok = f.white >= t.whiteMin && f.white <= t.whiteMax;
  const how = `${t.distance} m, ${t.lookAway ? 'looking away' : 'looking at it'}${t.wall ? ', behind a wall' : ''}`;
  rows.push([`Flashbang ${how}: white + fade (s)`, `${f.white.toFixed(2)} + ${f.fade.toFixed(2)}`, `${mark(ok)}  (white ${t.whiteMin}–${t.whiteMax} s: ${t.why})`]);
}

const mine = measureMine(1);
const mt = MINE_TARGETS;
rows.push(['Mine thrown level: sticks at (m) / after (s)', `${mine.sticksAt.toFixed(1)} / ${mine.sticksAfter.toFixed(2)}`, `${mark(mine.sticksAt >= mt.sticksAt.min && mine.sticksAt <= mt.sticksAt.max)}  (${mt.sticksAt.min}–${mt.sticksAt.max} m: ${mt.sticksAt.why})`]);
rows.push(['Mine, an enemy 1 m away: blast after (s) / damage', `${mine.blastAfter.toFixed(2)} / ${mine.damage.toFixed(0)}`, `${mark(mine.damage >= mt.damage.min && mine.blastAfter >= mt.blastAfter.min && mine.blastAfter <= mt.blastAfter.max)}  (${mt.blastAfter.min}–${mt.blastAfter.max} s, ≥ ${mt.damage.min} dmg: ${mt.damage.why}; ${mt.blastAfter.why})`]);
const emp = measureEmp();
rows.push(['EMP next to a player hovering 3 m up: jet off (s) / dropped (m)', `${emp.jetOff.toFixed(2)} / ${emp.dropped.toFixed(1)}`, `${mark(emp.jetOff >= EMP_TARGETS.jetOff.min && emp.jetOff <= EMP_TARGETS.jetOff.max && emp.dropped >= EMP_TARGETS.dropped.min)}  (${EMP_TARGETS.jetOff.why}; ${EMP_TARGETS.dropped.why})`]);

const recoil = new Map<string, ReturnType<typeof measureRecoil>>();
for (const t of RECOIL_TARGETS) {
  const w = weapons.find((x) => x.id === t.weapon)!;
  if (!recoil.has(t.weapon)) recoil.set(t.weapon, measureRecoil(w.index));
  const v = recoil.get(t.weapon)![t.key];
  rows.push([`${t.label} (m)`, v.toFixed(2), `${mark(v >= t.min && v <= t.max)}  (target ${t.min}–${t.max}: ${t.why})`]);
}
for (const t of SPRAY_TARGETS) {
  const w = weapons.find((x) => x.id === t.weapon)!;
  const v = measureSprayDrift(w.index);
  rows.push([`${w.name} sprayed level for 1 s in the air: drift back (m)`, v.toFixed(2), `${mark(v >= t.min - 1e-9 && v <= t.max + 1e-9)}  (target ${t.min}–${t.max}: ${t.why})`]);
}
{
  const top = Math.max(...weapons.map((w) => measureRecoilTopSpeed(w.index)));
  const cap = defaultTuning.launchSpeedX;
  rows.push(['Fastest recoil alone carries you sideways (m/s)', top.toFixed(2), `${mark(top < cap)}  (below launchSpeedX ${cap}: recoil never gets the blast-launch drag)`]);
}

const w0 = Math.max(...rows.map(([k]) => k.length));
const w1 = Math.max(...rows.map(([, v]) => v.length));
console.log('\nFeel report (current tuning)\n');
for (const [k, v, s] of rows) console.log(`  ${k.padEnd(w0)}  ${v.padEnd(w1)}  ${s}`);
console.log('');
