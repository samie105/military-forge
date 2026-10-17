/**
 * Feel report: objective numbers for the current tuning, checked against the feel targets, so
 * playtest impressions can be compared against measurements (docs/02 §19).
 * Run: pnpm --filter @military-forge/sim feel        (sweep for better values: pnpm --filter @military-forge/sim tune)
 */
import { weapons } from '@military-forge/content';
import {
  measureBlast,
  measureDash,
  measureEvents,
  measureGrenade,
  measureMovement,
  measureWeapon,
  measureZones,
  type DashMetrics,
  type EventMetrics,
  type MovementMetrics,
  type ZoneMetrics,
} from './feel-lib';
import { BLAST_TARGETS, DASH_TARGETS, EVENT_TARGETS, FOG_TARGETS, MOVEMENT_TARGETS, WEAPON_TARGETS, ZONE_TARGETS } from './feel-targets';

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
const g = measureGrenade();
rows.push(['Frag @45°: first bounce / detonation (m)', `${g.firstBounce.toFixed(1)} / ${g.detonation.toFixed(1)}`, '']);

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

const w0 = Math.max(...rows.map(([k]) => k.length));
const w1 = Math.max(...rows.map(([, v]) => v.length));
console.log('\nFeel report (current tuning)\n');
for (const [k, v, s] of rows) console.log(`  ${k.padEnd(w0)}  ${v.padEnd(w1)}  ${s}`);
console.log('');
