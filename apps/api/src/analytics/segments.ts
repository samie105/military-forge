/**
 * Segments for the house-ad rotation (docs/16 §7): a few plain words about how a player plays,
 * computed from their own day rows of the last 28 days, and only the days they said yes. Each one
 * can be explained in a sentence, nothing is inferred about who they are, and a missing answer is
 * null rather than a guess.
 *
 *   device       touch | keyboard | pad                 the input used most
 *   sessionBand  short (< 10 min) | medium | long (> 30) average active time per session
 *   timeOfDay    morning | afternoon | evening | night   the local hours played most
 *   modePref     ffa | team | local | training           the mode played most
 *   tenure       new (first seen ≤ 7 days ago) | returning
 */
import { INPUT_KINDS, type InputKind } from '@military-forge/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { addDays, rowsOf } from './partitions';

export type SessionBand = 'short' | 'medium' | 'long';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';
export type ModePref = 'ffa' | 'team' | 'local' | 'training';

export interface Segments {
  device: InputKind | null;
  sessionBand: SessionBand | null;
  timeOfDay: TimeOfDay | null;
  modePref: ModePref | null;
  tenure: 'new' | 'returning';
}

export const SEGMENT_WINDOW_DAYS = 28;

/** Local hours of each part of the day. */
export const DAY_PARTS: Readonly<Record<TimeOfDay, readonly number[]>> = {
  morning: [5, 6, 7, 8, 9, 10, 11],
  afternoon: [12, 13, 14, 15, 16],
  evening: [17, 18, 19, 20, 21],
  night: [22, 23, 0, 1, 2, 3, 4],
};

export interface SegmentDay {
  sessions: number;
  activeS: number;
  input: string | null;
  hours: number;
  modes: Record<string, number>;
}

function most<K extends string>(counts: Map<K, number>): K | null {
  let best: K | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

/** The segments from a player's consented day rows (pure: tests drive it). */
export function segmentsFrom(days: readonly SegmentDay[], firstDay: string | null, today: string): Segments | null {
  if (!days.length) return null;
  const inputs = new Map<InputKind, number>();
  const parts = new Map<TimeOfDay, number>();
  const modes = new Map<ModePref, number>();
  let sessions = 0;
  let active = 0;
  for (const d of days) {
    if (d.input && (INPUT_KINDS as readonly string[]).includes(d.input)) inputs.set(d.input as InputKind, (inputs.get(d.input as InputKind) ?? 0) + 1);
    sessions += d.sessions;
    active += d.activeS;
    for (const [part, hours] of Object.entries(DAY_PARTS) as [TimeOfDay, readonly number[]][]) {
      const n = hours.filter((h) => d.hours & (1 << h)).length;
      if (n) parts.set(part, (parts.get(part) ?? 0) + n);
    }
    for (const [mode, n] of Object.entries(d.modes)) {
      const pref: ModePref | null = mode === 'ffa' ? 'ffa' : mode.startsWith('team') ? 'team' : mode === 'local' ? 'local' : mode === 'training' ? 'training' : null;
      if (pref && n > 0) modes.set(pref, (modes.get(pref) ?? 0) + n);
    }
  }
  const avg = sessions > 0 ? active / sessions : null;
  return {
    device: most(inputs),
    sessionBand: avg === null || active === 0 ? null : avg < 600 ? 'short' : avg <= 1800 ? 'medium' : 'long',
    timeOfDay: most(parts),
    modePref: most(modes),
    tenure: firstDay !== null && firstDay >= addDays(today, -7) ? 'new' : 'returning',
  };
}

/** A player's segments now, or null (no consented days in the window). */
export async function segmentsFor(db: Db, uid: string, today: string): Promise<Segments | null> {
  const from = addDays(today, -(SEGMENT_WINDOW_DAYS - 1));
  const days = rowsOf<{ sessions: number; active_s: number; input: string | null; hours: number; modes: Record<string, number> | string }>(
    await db.execute(sql`select sessions, active_s, input, hours, modes from analytics_player_days where uid = ${uid} and consented and day >= ${from}::date`),
  );
  const first = rowsOf<{ first_day: string }>(await db.execute(sql`select first_day::text as first_day from analytics_players where uid = ${uid}`))[0];
  return segmentsFrom(
    days.map((d) => ({ sessions: Number(d.sessions), activeS: Number(d.active_s), input: d.input, hours: Number(d.hours), modes: typeof d.modes === 'string' ? (JSON.parse(d.modes) as Record<string, number>) : d.modes })),
    first?.first_day ?? null,
    today,
  );
}
