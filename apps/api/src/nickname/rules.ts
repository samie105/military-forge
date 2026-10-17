/**
 * Nickname rules (docs/07 §3): 3–16 characters, Unicode letters of one script (UTS #39
 * "moderately restrictive": Latin may mix with one other script, but never with the
 * lookalike-heavy Cyrillic, Greek or Armenian), Latin limited to a–z, accented letters and a short
 * list of real-language extras (no small capitals or IPA), confusables folded for uniqueness,
 * profanity and impersonation filtered. Generated guest names come from here too.
 */
import { randomInt } from 'node:crypto';
import { GAME_NAME } from '@military-forge/shared';
import { ALLOWLIST, IMPERSONATION, PROFANITY, type TermList } from './blocklist';
import { cleanNickname, filterForm, skeleton, tokens, unusualLatin } from './normalize';

export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 16;
/** UTF-8 bytes; keeps a 16-character name in scripts with combining marks inside protocol string limits */
export const NICKNAME_MAX_BYTES = 48;

export type NicknameReason = 'too_short' | 'too_long' | 'invalid_characters' | 'mixed_scripts' | 'no_letters' | 'profanity' | 'reserved';

export type NicknameCheck = { ok: true; nickname: string; norm: string } | { ok: false; reason: NicknameReason };

/** letters, non-enclosing combining marks (no `⃝` circles around letters), digits, separators */
const ALLOWED_CHARS = /^[\p{L}\p{Mn}\p{Mc}0-9 _.-]+$/u;
/** a combining mark must sit on a letter, and at most 2 in a row (no "Zalgo" text) */
const BAD_MARKS = /(^|[^\p{L}\p{M}])\p{M}|\p{M}{3}/u;
const DOUBLE_SEPARATOR = /[ _.-]{2}/u;
const LETTER = /\p{L}/u;

const SCRIPTS = [
  'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Arabic', 'Hebrew', 'Ethiopic',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala',
  'Thai', 'Lao', 'Myanmar', 'Khmer', 'Han', 'Hiragana', 'Katakana', 'Hangul',
].map((name) => ({ name, re: new RegExp(`^\\p{Script=${name}}$`, 'u') }));
const JAPANESE = new Set(['Han', 'Hiragana', 'Katakana']);
const KOREAN = new Set(['Han', 'Hangul']);
/** scripts with letters that pass for Latin ones (`о`, `ο`, `օ`), so never mixed with Latin */
const LATIN_LOOKALIKE_SCRIPTS = ['Cyrillic', 'Greek', 'Armenian'];

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const encoder = new TextEncoder();

export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** The scripts a name's letters use, or null when a letter belongs to none we accept. */
function scriptsOf(name: string): Set<string> | null {
  const found = new Set<string>();
  for (const ch of name) {
    if (!LETTER.test(ch)) continue;
    const script = SCRIPTS.find((s) => s.re.test(ch));
    if (!script) return null;
    found.add(script.name);
  }
  return found;
}

function scriptsAllowed(scripts: Set<string>): boolean {
  const other = [...scripts].filter((s) => s !== 'Latin');
  const oneGroup = other.length <= 1 || other.every((s) => JAPANESE.has(s)) || other.every((s) => KOREAN.has(s));
  return oneGroup && !(scripts.has('Latin') && LATIN_LOOKALIKE_SCRIPTS.some((s) => scripts.has(s)));
}

/** Each letter of a term may repeat; a doubled letter must stay at least doubled. */
function termPattern(term: string): string {
  const runs = filterForm(term).match(/(.)\1*/gu) ?? [];
  return runs.map((run) => `${run[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}{${run.length},}`).join('');
}

const DIGITS_AT_ENDS = /^[0-9]+|[0-9]+$/g;

class TermMatcher {
  private readonly anywhere: RegExp | null;
  private readonly edge: RegExp | null;
  private readonly word: RegExp | null;
  private readonly allow: RegExp | null;

  constructor(list: TermList, allowlist: readonly string[]) {
    const alt = (terms: readonly string[]) => (terms.length ? terms.map(termPattern).join('|') : null);
    const anywhere = alt(list.anywhere);
    const edge = alt(list.edge);
    const word = alt([...list.edge, ...list.word]);
    const allow = alt(allowlist);
    this.anywhere = anywhere ? new RegExp(anywhere, 'u') : null;
    this.edge = edge ? new RegExp(`^(?:${edge})|(?:${edge})$`, 'u') : null;
    this.word = word ? new RegExp(`^(?:${word})$`, 'u') : null;
    this.allow = allow ? new RegExp(allow, 'u') : null;
  }

  matches(name: string): boolean {
    const form = filterForm(name);
    // allowlisted words are cut out, and the pieces either side are checked on their own
    const pieces = this.allow ? form.split(this.allow) : [form];
    if (pieces.some((p) => this.anywhere?.test(p) || this.edge?.test(p))) return true;
    const word = this.word;
    if (!word) return false;
    const words = tokens(name).flatMap((t) => [t, t.replace(DIGITS_AT_ENDS, '')]);
    return [form, ...words.map(filterForm)].some((w) => w !== '' && word.test(w));
  }
}

export class NicknamePolicy {
  private readonly profanity = new TermMatcher(PROFANITY, ALLOWLIST);
  private readonly impersonation: TermMatcher;

  /** @param reserved extra protected names (staff), matched like `admin`: as a word or at either end */
  constructor(reserved: readonly string[] = []) {
    this.impersonation = new TermMatcher(
      { ...IMPERSONATION, anywhere: [...IMPERSONATION.anywhere, GAME_NAME], edge: [...IMPERSONATION.edge, ...reserved] },
      ALLOWLIST,
    );
  }

  check(raw: string): NicknameCheck {
    const nickname = cleanNickname(raw);
    const length = graphemeLength(nickname);
    if (length < NICKNAME_MIN) return { ok: false, reason: 'too_short' };
    if (length > NICKNAME_MAX || encoder.encode(nickname).length > NICKNAME_MAX_BYTES) return { ok: false, reason: 'too_long' };
    if (!ALLOWED_CHARS.test(nickname) || BAD_MARKS.test(nickname) || DOUBLE_SEPARATOR.test(nickname)) {
      return { ok: false, reason: 'invalid_characters' };
    }
    const scripts = scriptsOf(nickname);
    if (!scripts) return { ok: false, reason: 'invalid_characters' };
    if (scripts.size === 0) return { ok: false, reason: 'no_letters' };
    if (!scriptsAllowed(scripts)) return { ok: false, reason: 'mixed_scripts' };
    if (unusualLatin(nickname)) return { ok: false, reason: 'invalid_characters' };
    if (this.profanity.matches(nickname)) return { ok: false, reason: 'profanity' };
    if (this.impersonation.matches(nickname)) return { ok: false, reason: 'reserved' };
    return { ok: true, nickname, norm: skeleton(nickname) };
  }
}

const ADJECTIVES = [
  'Swift', 'Brave', 'Silent', 'Rapid', 'Lucky', 'Bold', 'Fierce', 'Steady', 'Clever', 'Iron', 'Golden', 'Crimson',
  'Shadow', 'Wild', 'Frosty', 'Sly', 'Mighty', 'Rogue', 'Nimble', 'Stormy', 'Cosmic', 'Turbo', 'Sonic', 'Blazing',
];
const NOUNS = [
  'Falcon', 'Tiger', 'Cobra', 'Jackal', 'Panda', 'Rhino', 'Viper', 'Eagle', 'Wolf', 'Hawk', 'Lion', 'Shark',
  'Bison', 'Otter', 'Raven', 'Lynx', 'Mamba', 'Gecko', 'Fox', 'Bear', 'Puma', 'Orca', 'Comet', 'Rocket',
];
export const GUEST_NAME_PARTS = { adjectives: ADJECTIVES, nouns: NOUNS } as const;

/** "SwiftFalcon482": 24 × 24 × 900 ≈ 518k names, all ≤ 16 characters and filter-clean. */
export function randomGuestNickname(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}${NOUNS[randomInt(NOUNS.length)]}${randomInt(100, 1000)}`;
}

/** Candidate alternatives for a taken name: the name without trailing digits (shortened if needed) + 2–3 digits. */
export function nicknameVariants(nickname: string, count: number): string[] {
  const graphemes = [...segmenter.segment(nickname.replace(/[0-9]+$/, '') || nickname)].map((s) => s.segment);
  const out = new Set<string>();
  for (let i = 0; out.size < count && i < count * 4; i++) {
    const digits = String(randomInt(i < count ? 10 : 100, i < count ? 100 : 1000));
    out.add(graphemes.slice(0, NICKNAME_MAX - digits.length).join('').trimEnd() + digits);
  }
  return [...out];
}
