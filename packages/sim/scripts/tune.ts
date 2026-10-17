/**
 * Target-driven tuning sweep (docs/02 §19). Tries parameter combinations against the feel
 * targets in feel-targets.ts, keeps the ones that pass every target, and recommends the
 * smallest change from the current values (fewest knobs first, then the smallest relative change, one system at a time).
 *
 * Run: pnpm --filter @military-forge/sim tune
 */
import { BUZZ, HAMMER, defaultTuning, weapons, type Tuning } from '@military-forge/content';
import { measureMovement, measureWeapon, withSpread, type MovementMetrics } from './feel-lib';
import { MOVEMENT_TARGETS, WEAPON_TARGETS, type WeaponTarget } from './feel-targets';

const grid = <T>(values: Record<string, T[]>): Record<string, T>[] =>
  Object.entries(values).reduce<Record<string, T>[]>((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);

/**
 * Size of a change, for ranking: the number of parameters changed counts first (one knob moved a
 * lot beats three knobs nudged, because each knob is a playtest variable), then the relative size.
 * A zero base value counts as one unit of relative change when it becomes non-zero.
 */
function changeSize(candidate: Record<string, number>, base: Record<string, number>): { knobs: number; rel: number } {
  let knobs = 0;
  let rel = 0;
  for (const [k, v] of Object.entries(candidate)) {
    const b = base[k]!;
    if (Math.abs(v - b) < 1e-9) continue;
    knobs++;
    rel += b === 0 ? 1 : Math.abs(v - b) / Math.abs(b);
  }
  return { knobs, rel };
}
const bySize = (a: { size: { knobs: number; rel: number } }, b: { size: { knobs: number; rel: number } }) =>
  a.size.knobs - b.size.knobs || a.size.rel - b.size.rel;
const fmtSize = (s: { knobs: number; rel: number }) => `${s.knobs} knob${s.knobs === 1 ? '' : 's'} Δ${s.rel.toFixed(2)}`;

function movementPasses(m: MovementMetrics): { pass: boolean; misses: string[] } {
  const misses = MOVEMENT_TARGETS.filter((t) => {
    const v = m[t.key as keyof MovementMetrics];
    return v < t.min || v > t.max;
  }).map((t) => `${t.key}=${m[t.key as keyof MovementMetrics].toFixed(2)}`);
  return { pass: misses.length === 0, misses };
}

// ---------- movement ----------
const moveBase = {
  fuelBurn: defaultTuning.fuelBurn,
  jetThrust: defaultTuning.jetThrust,
  jetMaxVy: defaultTuning.jetMaxVy,
  jetAirMaxX: defaultTuning.jetAirMaxX,
  fuelRegenAir: defaultTuning.fuelRegenAir,
};
const moveGrid = grid({
  fuelBurn: [38, 40, 42, 44, 46, 48],
  jetThrust: [36, 38, 40],
  jetMaxVy: [6, 6.25, 6.5],
  jetAirMaxX: [6.5, 7],
  fuelRegenAir: [6, 12],
});
const before = measureMovement();
const moveResults = moveGrid.map((c) => {
  const m = measureMovement(c as Partial<Tuning>);
  return { c, m, size: changeSize(c, moveBase), ...movementPasses(m) };
});
const movePass = moveResults.filter((r) => r.pass).sort(bySize);

// ---------- weapons ----------
const measure = (t: WeaponTarget) => measureWeapon(weapons.find((w) => w.id === t.weapon)!.index, t.distance, t.airborne);

function weaponCheck(t: WeaponTarget, r: { ttk: number; hitRate: number }): boolean {
  return (
    (t.hitMin === undefined || r.hitRate >= t.hitMin) &&
    (t.hitMax === undefined || r.hitRate <= t.hitMax) &&
    (t.ttkMax === undefined || r.ttk <= t.ttkMax)
  );
}

const buzzTargets = WEAPON_TARGETS.filter((t) => t.weapon === BUZZ.id);
const buzzBase = { base: BUZZ.spread.base, bloomPerShot: BUZZ.spread.bloomPerShot };
const buzzResults = grid({ base: [3, 3.5, 4, 4.5, 5, 6], bloomPerShot: [0.2, 0.3, 0.4, 0.5] }).map((c) => {
  const results = withSpread({ buzz: c }, () => buzzTargets.map((t) => ({ t, r: measure(t) })));
  return { c, results, pass: results.every(({ t, r }) => weaponCheck(t, r)), size: changeSize(c, buzzBase) };
});
const buzzPass = buzzResults.filter((r) => r.pass).sort(bySize);

const hammerTargets = WEAPON_TARGETS.filter((t) => t.weapon === HAMMER.id);
const hammerBase = { airMul: HAMMER.spread.airMul, minAir: HAMMER.spread.minAir };
const hammerResults = grid({ airMul: [1.5, 2, 2.25, 2.5, 3], minAir: [0, 1.5, 2.5] }).map((c) => {
  const results = withSpread({ hammer: c }, () => hammerTargets.map((t) => ({ t, r: measure(t) })));
  return { c, results, pass: results.every(({ t, r }) => weaponCheck(t, r)), size: changeSize(c, hammerBase) };
});
const hammerPass = hammerResults.filter((r) => r.pass).sort(bySize);

// ---------- report ----------
const fmt = (m: MovementMetrics) =>
  `burn ${m.burn.toFixed(2)}s climb ${m.climb.toFixed(1)}m jetRun ${m.jetRun.toFixed(1)}m hover ${m.hover.toFixed(2)}s refill ${m.refill.toFixed(2)}s tap ${m.tapHop.toFixed(2)}m to2m ${m.to2m.toFixed(2)}s`;
console.log('\nMOVEMENT (targets: ' + MOVEMENT_TARGETS.map((t) => `${t.key} ${t.min}–${t.max}`).join(', ') + ')');
console.log(`  current  ${JSON.stringify(moveBase)}  ${fmt(before)}  misses: ${movementPasses(before).misses.join(' ') || 'none'}`);
console.log(`  ${movePass.length}/${moveResults.length} combinations pass. Smallest changes:`);
for (const r of movePass.slice(0, 6)) console.log(`   ${fmtSize(r.size)} ${JSON.stringify(r.c)}  ${fmt(r.m)}`);

const wfmt = (rs: { t: WeaponTarget; r: { ttk: number; hitRate: number } }[]) =>
  rs.map(({ t, r }) => `${t.label.replace(' grounded', '').replace(' airborne', ' air')}: ${(100 * r.hitRate).toFixed(0)}% ${r.ttk.toFixed(2)}s`).join(' | ');
const buzzNow = buzzResults.find((r) => r.c.base === buzzBase.base && r.c.bloomPerShot === buzzBase.bloomPerShot)!;
console.log('\nBUZZ');
console.log(`  current ${JSON.stringify(buzzBase)}  ${wfmt(buzzNow.results)}`);
console.log(`  ${buzzPass.length}/${buzzResults.length} pass. Smallest changes:`);
for (const r of buzzPass.slice(0, 5)) console.log(`   ${fmtSize(r.size)} ${JSON.stringify(r.c)}  ${wfmt(r.results)}`);

const hammerNow = hammerResults.find((r) => r.c.airMul === hammerBase.airMul && r.c.minAir === hammerBase.minAir)!;
console.log('\nHAMMER');
console.log(`  current ${JSON.stringify(hammerBase)}  ${wfmt(hammerNow.results)}`);
console.log(`  ${hammerPass.length}/${hammerResults.length} pass. Smallest changes:`);
for (const r of hammerPass.slice(0, 5)) console.log(`   ${fmtSize(r.size)} ${JSON.stringify(r.c)}  ${wfmt(r.results)}`);

const recommendation = {
  tuning: movePass[0]?.c ?? null,
  buzzSpread: buzzPass[0]?.c ?? null,
  hammerSpread: hammerPass[0]?.c ?? null,
};
console.log('\nRECOMMENDED (smallest passing change per system):');
console.log(JSON.stringify(recommendation, null, 2));
