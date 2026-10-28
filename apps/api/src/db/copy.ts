/**
 * Copies every table of the schema from one database into another, parents before children
 * (foreign keys), skipping rows the target already has. It moves a PGlite directory into real
 * Postgres once (scripts/import-pglite.ts, run by the trial server's setup): both sides are
 * migrated to the same schema first, so the rows fit as they are, and serial ids' sequences are moved past the
 * copied rows (the ledger's, the store audit's). Safe to run twice.
 */
import { getTableName, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client';
import * as schema from './schema';

/** rows per INSERT: well under Postgres' 65535 bind parameters for any of our tables */
const BATCH = 500;

/** The schema's tables, each after the tables its foreign keys point at. */
export function tablesInCopyOrder(): PgTable[] {
  const tables = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable));
  const done = new Set<PgTable>();
  const order: PgTable[] = [];
  const visit = (t: PgTable, path: Set<PgTable>) => {
    if (done.has(t)) return;
    if (path.has(t)) throw new Error(`foreign-key cycle at ${getTableName(t)}`);
    path.add(t);
    for (const fk of getTableConfig(t).foreignKeys) {
      const parent = fk.reference().foreignTable;
      if (parent !== t) visit(parent, path);
    }
    path.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return order;
}

/** Copies all rows; returns, per table, how many it read and how many were new to the target. */
export async function copyAllTables(from: Db, to: Db): Promise<Record<string, { read: number; added: number }>> {
  const counts: Record<string, { read: number; added: number }> = {};
  for (const table of tablesInCopyOrder()) {
    const rows = await from.select().from(table);
    let added = 0;
    await to.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH) {
        const inserted = await tx
          .insert(table)
          // rows read from the same table; Drizzle can't type a table chosen at run time
          .values(rows.slice(i, i + BATCH) as never)
          .onConflictDoNothing()
          .returning();
        added += inserted.length;
      }
    });
    counts[getTableName(table)] = { read: rows.length, added };
    // rows came with their ids: a serial column's sequence moves past them, or the next insert would collide
    for (const col of getTableConfig(table).columns) {
      if (!col.columnType.startsWith('PgBigSerial') && !col.columnType.startsWith('PgSerial')) continue;
      const name = getTableName(table);
      await to.execute(sql`select setval(pg_get_serial_sequence(${name}, ${col.name}), coalesce((select max(${sql.identifier(col.name)}) from ${sql.identifier(name)}), 0) + 1, false)`);
    }
  }
  return counts;
}
