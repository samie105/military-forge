/**
 * "Tune the game" in round two's kit (data-screen="tune"): the rows the host's panel shows, mapped to
 * the real tuning keys with content's own min, max and step (TUNING_GROUPS), the presets, and the
 * words a guest reads when the host changes something. The whole set of keys stays in the dev panel
 * (tweakpane, tuningPanel.ts), which the host's panel opens under "All values".
 */
import { TUNING_GROUPS, changedTuning, createTuning, defaultTuning, type Tuning, type TuningField } from '@military-forge/content';
import { TICK_RATE } from '@military-forge/sim';

type Key = keyof Tuning;

export interface TuneRow {
  /** a stable id (the kit's data-bind name) */
  id: string;
  label: string;
  /** the tuning key the slider edits */
  key: Key;
  /** the value as shown, from the tuning (Dash · distance shows metres, from speed × burst) */
  show(t: Tuning): number;
  /** the tuning that shows `shown` (snapped to the step) */
  apply(t: Tuning, shown: number): Tuning;
  /** the shown range and step */
  min(t: Tuning): number;
  max(t: Tuning): number;
  step(t: Tuning): number;
  unit: string;
}

const field = (key: Key): TuningField => {
  for (const g of TUNING_GROUPS) for (const f of g.fields) if (f.key === key) return f;
  throw new Error(`no tuning field ${key}`);
};

const decimals = (step: number) => Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
const snap = (v: number, min: number, max: number, step: number) => {
  const n = Math.round((v - min) / step) * step + min;
  return Number(Math.min(max, Math.max(min, n)).toFixed(decimals(step)));
};

/** A row that edits one key as it is. */
function plain(id: string, label: string, key: Key, unit: string): TuneRow {
  const f = field(key);
  return {
    id,
    label,
    key,
    unit,
    show: (t) => t[key] as number,
    apply: (t, shown) => ({ ...t, [key]: snap(shown, f.min, f.max, f.step) }),
    min: () => f.min,
    max: () => f.max,
    step: () => f.step,
  };
}

/** Dash · distance: speed × burst length, in metres; the slider edits the speed (the burst stays). */
const dashDistance: TuneRow = (() => {
  const f = field('dashSpeed');
  const per = (t: Tuning) => t.dashBurstTicks / TICK_RATE;
  return {
    id: 'dashDistance',
    label: 'Dash · distance',
    key: 'dashSpeed',
    unit: 'm',
    show: (t) => t.dashSpeed * per(t),
    apply: (t, shown) => ({ ...t, dashSpeed: snap(shown / per(t), f.min, f.max, f.step) }),
    min: (t) => f.min * per(t),
    max: (t) => f.max * per(t),
    step: (t) => f.step * per(t),
  };
})();

/** The kit's rows, in its order. */
export const TUNE_ROWS: readonly TuneRow[] = [
  plain('fuelMax', 'Jet fuel · max', 'fuelMax', ''),
  plain('fuelBurn', 'Jet fuel · burn', 'fuelBurn', '/s'),
  plain('fuelRegen', 'Jet fuel · regen', 'fuelRegenGround', '/s'),
  plain('jetThrust', 'Jet thrust', 'jetThrust', ''),
  plain('gravity', 'Gravity', 'gravity', 'm/s²'),
  plain('runSpeed', 'Run speed', 'walkMax', 'm/s'),
  dashDistance,
  plain('dashCooldown', 'Dash · cooldown', 'dashCooldown', 's'),
  plain('blastLaunch', 'Blast launch', 'blastImpulseScale', '×'),
  plain('throwSpeed', 'Grenade throw speed', 'grenadeThrowScale', '×'),
  plain('respawn', 'Respawn time', 'respawnDelay', 's'),
];

/** A shown value as a number, to the row's precision ("12", "2.7"). */
export function tuneNumber(row: TuneRow, t: Tuning, shown = row.show(t)): string {
  const d = row.id === 'dashDistance' ? 1 : decimals(row.step(t));
  return String(Number(shown.toFixed(d)));
}

/** A shown value in the row's words ("12 m/s²", "2.7 m", "1×"). */
export function formatTune(row: TuneRow, t: Tuning, shown = row.show(t)): string {
  const text = tuneNumber(row, t, shown);
  if (!row.unit) return text;
  // a no-break space: the value rolls by character (P4), and the unit stays with its number
  return row.unit === '×' ? `${text}×` : `${text}\u00a0${row.unit}`;
}

/** Is the row's key away from the default? */
export const rowChanged = (row: TuneRow, t: Tuning) => Math.abs((t[row.key] as number) - (defaultTuning[row.key] as number)) > 1e-9;

export type PresetId = 'classic' | 'floaty' | 'chaos';

/** The presets: partial tunings over the defaults (Classic is the defaults). */
export const PRESETS: Readonly<Record<PresetId, Partial<Tuning>>> = {
  classic: {},
  floaty: { gravity: 12, jetThrust: 30, fuelBurn: 34, walkMax: 4.5, dashCooldown: 1.2 },
  chaos: { gravity: 26, walkMax: 7, dashSpeed: 28, dashCooldown: 0.4, blastImpulseScale: 2.2, grenadeThrowScale: 1.5, respawnDelay: 1 },
};

export const PRESET_NAMES: Readonly<Record<PresetId | 'custom', string>> = { classic: 'Classic', floaty: 'Floaty', chaos: 'Chaos', custom: 'Custom' };

/** The tuning a preset makes (everything else back to the defaults). */
export const presetTuning = (id: PresetId): Tuning => createTuning(PRESETS[id]);

/** Which preset a tuning is, or 'custom'. */
export function presetOf(t: Tuning): PresetId | 'custom' {
  const changed = changedTuning(t);
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const p = PRESETS[id];
    const keys = new Set([...Object.keys(changed), ...Object.keys(p)]) as Set<Key>;
    if ([...keys].every((k) => Math.abs((t[k] as number) - ((p[k] ?? defaultTuning[k]) as number)) < 1e-9)) return id;
  }
  return 'custom';
}

/** What changed between two tunings, in the panel's words (rows first; other keys by their field label). */
export function tuneChanges(before: Tuning, after: Tuning): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const seen = new Set<Key>();
  for (const row of TUNE_ROWS) {
    seen.add(row.key);
    if (row.id === 'dashDistance') seen.add('dashBurstTicks');
    if (Math.abs(row.show(before) - row.show(after)) > 1e-9) out.push({ label: row.label.replace(' · ', ' '), value: formatTune(row, after) });
  }
  for (const g of TUNING_GROUPS)
    for (const f of g.fields) {
      if (seen.has(f.key) || Math.abs((before[f.key] as number) - (after[f.key] as number)) < 1e-9) continue;
      out.push({ label: `${g.title} · ${f.label.replace(/\s*\(.*\)$/, '')}`, value: String(after[f.key]) });
    }
  return out;
}

/** The guest's toast: "Ade changed Gravity to 12 m/s² · Dash cooldown to 0.6 s" (two at most, then "+N more"). */
export function tuneToastParts(who: string, changes: readonly { label: string; value: string }[]): { who: string; items: { label: string; value: string }[]; more: number } | null {
  if (changes.length === 0) return null;
  return { who, items: changes.slice(0, 2), more: Math.max(0, changes.length - 2) };
}
