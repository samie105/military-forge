/**
 * The owner's admin page, server side (pnpm playtest → /admin; content admin.ts has the fields).
 *
 * One set of admin values for the whole process: `setAdminValues` clamps them, changes the content
 * numbers in place (weapons, grenades, projectiles, pickups: every room at once) and has every room
 * take the rest (its tuning, crate weights, bots, match limits) and tell its clients (TUNING and
 * OVERRIDES, v13). A room that opens later takes them when it's made; a client that joins or comes
 * back gets them in its WELCOME. Clients apply the content values to their own copy, so prediction
 * runs on the same numbers.
 *
 * The HTTP side (`startAdminServer`) listens on 127.0.0.1 only, behind the playtest proxy
 * (/admin/api/*), and answers only a request carrying the run's token: `Authorization: Bearer <token>`.
 * The token never travels in a URL (the page keeps it in its #fragment).
 */
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { ADMIN_FIELDS, ADMIN_PRESETS, clampAdmin, type AdminValues } from '@military-forge/content';
import { adminValues, setAdminValues } from './adminState';

export { adminJson, adminValues, onAdminValues, setAdminValues } from './adminState';

/** The values saved by "Save as defaults" in `file`, or none (a missing or broken file is no values). */
export function loadAdminDefaults(file: string, log: (msg: string) => void = () => {}): AdminValues {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return clampAdmin(JSON.parse(text));
  } catch (e) {
    log(`[admin] ${file}: not JSON (${(e as Error).message}); starting from the shipped defaults`);
    return {};
  }
}

export interface AdminServerOptions {
  /** the run's secret: every request needs `Authorization: Bearer <token>` (16+ characters) */
  token: string;
  port: number;
  /** default 127.0.0.1: reached through the playtest proxy only */
  host?: string;
  /** where "Save as defaults" writes (the playtest loads it on its next run); none: no saving */
  defaultsFile?: string;
  log?: (msg: string) => void;
}

export interface AdminServer {
  port: number;
  close(): void;
}

const MAX_BODY = 64 * 1024;

/** The fields as the page needs them (no getters). */
function catalogue() {
  return ADMIN_FIELDS.map(({ key, group, section, label, min, max, step, def, scope }) => ({ key, group, section, label, min, max, step, def, scope }));
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
}

/** The token check, in constant time. */
export function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A body over MAX_BODY: answered 413 once it has all arrived (the connection stays usable for the answer). */
class BodyTooLarge extends Error {}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c); // past it, the rest is read and dropped
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new BodyTooLarge(`body over ${MAX_BODY / 1024} KB`));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * The admin API:
 *   GET  /admin/api/state            the fields, the values in force, the presets, where defaults save
 *   PUT  /admin/api/values           replace the values (JSON `{ key: number }`), clamped; → state
 *   POST /admin/api/preset/<name>    classic, floaty or chaos; → state
 *   POST /admin/api/save             write the values to the defaults file
 */
export function startAdminServer(options: AdminServerOptions): Promise<AdminServer> {
  const log = options.log ?? (() => {});
  if (options.token.length < 16) throw new Error('admin token too short');
  const state = () => ({ fields: catalogue(), values: adminValues(), presets: Object.keys(ADMIN_PRESETS), defaultsFile: options.defaultsFile ?? null });
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (!path.startsWith('/admin/api/')) return reply(res, 404, { error: 'not found' });
    if (!tokenOk(req.headers.authorization, options.token)) return reply(res, 401, { error: 'the admin link of this run is needed' });
    const route = `${req.method} ${path.slice('/admin/api'.length)}`;
    try {
      if (route === 'GET /state') return reply(res, 200, state());
      if (req.method !== 'GET' && !/^application\/json\b/.test(req.headers['content-type'] ?? '')) return reply(res, 415, { error: 'JSON only' });
      if (route === 'PUT /values') {
        setAdminValues(await readJson(req));
        log(`[admin] ${Object.keys(adminValues()).length} values changed`);
        return reply(res, 200, state());
      }
      const preset = /^POST \/preset\/([a-z]+)$/.exec(route)?.[1];
      if (preset !== undefined) {
        const values = (ADMIN_PRESETS as Record<string, AdminValues>)[preset];
        if (!values) return reply(res, 404, { error: `no preset "${preset}"` });
        setAdminValues(values);
        log(`[admin] preset ${preset}`);
        return reply(res, 200, state());
      }
      if (route === 'POST /save') {
        if (!options.defaultsFile) return reply(res, 409, { error: 'this server has no defaults file' });
        mkdirSync(dirname(options.defaultsFile), { recursive: true });
        writeFileSync(options.defaultsFile, `${JSON.stringify(adminValues(), null, 2)}\n`);
        log(`[admin] saved ${Object.keys(adminValues()).length} values as the defaults (${options.defaultsFile})`);
        return reply(res, 200, { ok: true, file: options.defaultsFile, values: adminValues() });
      }
      return reply(res, 404, { error: 'not found' });
    } catch (e) {
      return reply(res, e instanceof BodyTooLarge ? 413 : 400, { error: (e as Error).message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}
