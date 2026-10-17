/**
 * Error contract: every failure is `{ error: { code, message, ...extra } }` with a stable
 * snake_case `code` that clients branch on (`message` is for humans and logs).
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from './context';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(c: Context, status: ContentfulStatusCode, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: { code, message, ...extra } }, status);
}

/**
 * Reads a JSON body and validates it. An empty body counts as `{}`, so routes whose fields are
 * all optional can be called without one.
 */
export async function readJson<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'Request body failed validation', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
