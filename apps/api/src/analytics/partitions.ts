/**
 * The raw events' day partitions (docs/16 §4.1): one per UTC day, made ahead of time (and on demand
 * for a day an insert needs), dropped once past the retention window. Dropping a partition is
 * instant and leaves no dead rows to vacuum, which is why the table is partitioned at all.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' (UTC) of an epoch time. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

export function partitionName(day: string): string {
  return `analytics_events_p${day.replaceAll('-', '')}`;
}

/** A query's rows, from either driver (postgres-js answers an array, PGlite `{ rows }`). */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export class Partitions {
  private readonly known = new Set<string>();

  constructor(private readonly db: Db) {}

  /** Makes the day's partition if it isn't there. */
  async ensure(day: string): Promise<void> {
    if (this.known.has(day)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${day}`);
    const next = addDays(day, 1);
    // names and bounds come from a checked date, never from a request
    await this.db.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS "${partitionName(day)}" PARTITION OF "analytics_events" FOR VALUES FROM ('${day} 00:00:00+00') TO ('${next} 00:00:00+00')`),
    );
    this.known.add(day);
  }

  /** The partitions there are, by day, oldest first. */
  async list(): Promise<string[]> {
    const rows = rowsOf<{ name: string }>(
      await this.db.execute(sql`select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent where p.relname = 'analytics_events' order by c.relname`),
    );
    return rows.flatMap((r) => {
      const m = /^analytics_events_p(\d{4})(\d{2})(\d{2})$/.exec(r.name);
      return m ? [`${m[1]}-${m[2]}-${m[3]}`] : [];
    });
  }

  /** Today and the next `ahead` days exist; days before `keepFrom` are dropped. Returns the days dropped. */
  async maintain(today: string, keepFrom: string, ahead = 2): Promise<string[]> {
    for (let i = 0; i <= ahead; i++) await this.ensure(addDays(today, i));
    const dropped: string[] = [];
    for (const day of await this.list()) {
      if (day >= keepFrom) continue;
      await this.db.execute(sql.raw(`DROP TABLE IF EXISTS "${partitionName(day)}"`));
      this.known.delete(day);
      dropped.push(day);
    }
    return dropped;
  }
}
