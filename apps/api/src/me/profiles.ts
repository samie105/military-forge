/**
 * Profiles: the `Me` view, nickname availability and changes (docs/07 §3: unique names,
 * 7-day change cooldown, the first change away from a generated guest name is free).
 */
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/client';
import { identities, profiles, users } from '../db/schema';
import { ApiError } from '../http/errors';
import { nicknameVariants, type NicknamePolicy, type NicknameReason } from '../nickname/rules';

export const NICKNAME_COOLDOWN_MS = 7 * 86_400_000;
const SUGGESTIONS = 3;

/** What `GET /me` returns. */
export interface Me {
  id: string;
  nickname: string;
  isGuest: boolean;
  createdAt: string;
  /** null = the nickname can be changed now */
  nicknameChangeableAt: string | null;
  level: number;
  xp: number;
}

export interface NicknameAvailability {
  nickname: string;
  valid: boolean;
  available: boolean;
  reason?: NicknameReason;
  suggestions?: string[];
}

export class ProfileService {
  constructor(
    private readonly db: Db,
    readonly policy: NicknamePolicy,
    private readonly now: () => number,
  ) {}

  async me(userId: string): Promise<Me | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        createdAt: users.createdAt,
        nickname: profiles.nickname,
        nicknameChangedAt: profiles.nicknameChangedAt,
        level: profiles.level,
        xp: profiles.xp,
        isGuest: sql<boolean>`not exists (select 1 from ${identities} where ${identities.userId} = ${users.id} and ${identities.provider} <> 'guest')`,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    if (!row) return null;
    return {
      id: row.id,
      nickname: row.nickname,
      isGuest: row.isGuest,
      createdAt: row.createdAt.toISOString(),
      nicknameChangeableAt: this.changeableAt(row.nicknameChangedAt)?.toISOString() ?? null,
      level: row.level,
      xp: row.xp,
    };
  }

  /** Skeletons already used by someone other than `exceptUserId`. */
  async takenNorms(norms: string[], exceptUserId?: string): Promise<Set<string>> {
    if (norms.length === 0) return new Set();
    const where = exceptUserId
      ? and(inArray(profiles.nicknameNorm, norms), ne(profiles.userId, exceptUserId))
      : inArray(profiles.nicknameNorm, norms);
    const rows = await this.db.select({ norm: profiles.nicknameNorm }).from(profiles).where(where);
    return new Set(rows.map((r) => r.norm));
  }

  /** Up to 3 free, valid variants of a taken name. */
  async suggestions(nickname: string, exceptUserId?: string): Promise<string[]> {
    const candidates = nicknameVariants(nickname, SUGGESTIONS * 2).flatMap((name) => {
      const check = this.policy.check(name);
      return check.ok ? [check] : [];
    });
    const taken = await this.takenNorms(
      candidates.map((c) => c.norm),
      exceptUserId,
    );
    return candidates
      .filter((c) => !taken.has(c.norm))
      .slice(0, SUGGESTIONS)
      .map((c) => c.nickname);
  }

  async availability(raw: string, userId?: string): Promise<NicknameAvailability> {
    const check = this.policy.check(raw);
    if (!check.ok) return { nickname: raw, valid: false, available: false, reason: check.reason };
    const taken = await this.takenNorms([check.norm], userId);
    if (!taken.has(check.norm)) return { nickname: check.nickname, valid: true, available: true };
    return { nickname: check.nickname, valid: true, available: false, suggestions: await this.suggestions(check.nickname, userId) };
  }

  /** Validated, free nickname or a 400/409 ApiError. */
  async requireAvailable(raw: string, userId?: string): Promise<{ nickname: string; norm: string }> {
    const check = this.policy.check(raw);
    if (!check.ok) throw new ApiError(400, 'invalid_nickname', `Nickname rejected: ${check.reason}`, { reason: check.reason });
    if ((await this.takenNorms([check.norm], userId)).has(check.norm)) throw await this.takenError(check.nickname, userId);
    return check;
  }

  async takenError(nickname: string, userId?: string): Promise<ApiError> {
    return new ApiError(409, 'nickname_taken', 'That nickname (or one that looks the same) is taken', {
      suggestions: await this.suggestions(nickname, userId),
    });
  }

  async changeNickname(userId: string, raw: string): Promise<Me> {
    const [profile] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    if (!profile) throw new ApiError(404, 'not_found', 'No profile for this account');
    const check = this.policy.check(raw);
    if (check.ok && check.nickname === profile.nickname) return (await this.me(userId))!;

    const changeableAt = this.changeableAt(profile.nicknameChangedAt);
    if (changeableAt) throw this.cooldownError(changeableAt);
    const next = await this.requireAvailable(raw, userId);
    const now = this.now();
    let updated: { userId: string }[];
    try {
      // the cooldown is checked again in the UPDATE itself, so concurrent changes can't all pass the check above
      updated = await this.db
        .update(profiles)
        .set({ nickname: next.nickname, nicknameNorm: next.norm, nicknameChangedAt: new Date(now) })
        .where(
          and(
            eq(profiles.userId, userId),
            or(isNull(profiles.nicknameChangedAt), lte(profiles.nicknameChangedAt, new Date(now - NICKNAME_COOLDOWN_MS))),
          ),
        )
        .returning({ userId: profiles.userId });
    } catch (err) {
      if (isUniqueViolation(err)) throw await this.takenError(next.nickname, userId);
      throw err;
    }
    if (updated.length === 0) {
      const [latest] = await this.db.select({ changedAt: profiles.nicknameChangedAt }).from(profiles).where(eq(profiles.userId, userId));
      if (!latest) throw new ApiError(404, 'not_found', 'No profile for this account');
      throw this.cooldownError(this.changeableAt(latest.changedAt) ?? new Date(now));
    }
    return (await this.me(userId))!;
  }

  private cooldownError(changeableAt: Date): ApiError {
    return new ApiError(429, 'nickname_cooldown', 'Nicknames can be changed once every 7 days', {
      nicknameChangeableAt: changeableAt.toISOString(),
    });
  }

  /** When the next change is allowed, or null if it is allowed now. */
  private changeableAt(changedAt: Date | null): Date | null {
    if (!changedAt) return null;
    const at = changedAt.getTime() + NICKNAME_COOLDOWN_MS;
    return at > this.now() ? new Date(at) : null;
  }
}
