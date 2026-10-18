/**
 * The admin page's logic without a DOM (main.ts draws it): the token, the API calls, searching,
 * formatting. The game server's admin API (apps/game-server admin.ts) is behind the playtest proxy
 * at /admin/api; every call carries the run's token as `Authorization: Bearer`.
 */

export interface AdminFieldView {
  key: string;
  group: string;
  section: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  scope: 'tuning' | 'content' | 'server';
}

export interface AdminStateView {
  fields: AdminFieldView[];
  values: Record<string, number>;
  presets: string[];
  defaultsFile: string | null;
}

const TOKEN_KEY = 'mf.admin.token';

/**
 * The token: from the link's #t=… (then kept in this tab's session storage and taken off the
 * address bar, so a screenshot or a shared tab doesn't carry it), else from the session.
 */
export function readToken(hash: string, store: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{16,})/.exec(hash);
  if (m) {
    try {
      store?.setItem(TOKEN_KEY, m[1]!);
    } catch {
      /* private mode: the hash stays the only copy */
    }
    return m[1]!;
  }
  try {
    return store?.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One admin API call: JSON in and out, the token in the Authorization header. */
export async function adminCall<T>(token: string, method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(`/admin/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new AdminApiError(res.status, (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Decimals a step shows with (0.05 → 2). */
export function decimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** A value as the number box shows it. */
export function formatValue(f: Pick<AdminFieldView, 'step'>, v: number): string {
  return v.toFixed(decimals(f.step));
}

/** `v` inside the field's range, on its step for whole-number fields (as the server keeps it). */
export function clampValue(f: Pick<AdminFieldView, 'min' | 'max' | 'step'>, v: number): number {
  const within = Math.min(f.max, Math.max(f.min, v));
  return Number.isInteger(f.step) ? Math.round(within) : within;
}

/** Does a search match a field (words in any order, in its group, section, label or key)? */
export function matches(f: AdminFieldView, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${f.group} ${f.section} ${f.label} ${f.key}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The fields by group, then section, in the server's order. */
export function grouped(fields: readonly AdminFieldView[]): Map<string, Map<string, AdminFieldView[]>> {
  const out = new Map<string, Map<string, AdminFieldView[]>>();
  for (const f of fields) {
    let g = out.get(f.group);
    if (!g) out.set(f.group, (g = new Map()));
    let s = g.get(f.section);
    if (!s) g.set(f.section, (s = []));
    s.push(f);
  }
  return out;
}

/** The values with `key` set (or dropped, back at its default). */
export function withValue(values: Record<string, number>, f: AdminFieldView, v: number): Record<string, number> {
  const next = { ...values };
  if (v === f.def) delete next[f.key];
  else next[f.key] = v;
  return next;
}
