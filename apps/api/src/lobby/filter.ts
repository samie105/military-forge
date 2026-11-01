/**
 * Free text in the Lobby (only with CHAT_FREE_TEXT on, after the gate in gate.ts): what a line may
 * hold, and what the word filter does to it. The nickname filter's normal forms and word lists
 * (nickname/normalize.ts, blocklist.ts) do the matching, so lookalike letters, accents, leetspeak and
 * stretched letters ("fuuuck") are folded the same way as in names.
 *
 * - at most 200 characters (graphemes), after the spaces are tidied;
 * - no links: web addresses, "something dot com", shortened and messaging links;
 * - no runs of 7 or more digits, spaces and dashes between them included (phone numbers, account numbers);
 * - a word on CHAT_REFUSE turns the whole line away; one on PROFANITY or CHAT_EXTRA is masked (•••);
 *   a word spelled out a letter at a time ("f u c k", "f.u.c.k") turns the line away too.
 */
import { LOBBY_LIMITS } from '@military-forge/shared';
import { ALLOWLIST, CHAT_EXTRA, CHAT_REFUSE, PROFANITY } from '../nickname/blocklist';
import { filterForm } from '../nickname/normalize';
import { TermMatcher, graphemeLength } from '../nickname/rules';

export type TextVerdict = { ok: true; text: string; masked: boolean } | { ok: false; code: 'empty' | 'too_long' | 'link' | 'digits' | 'refused'; message: string };

const refuse = new TermMatcher(CHAT_REFUSE, ALLOWLIST);
const mask = new TermMatcher(
  { anywhere: [...PROFANITY.anywhere, ...CHAT_EXTRA.anywhere], edge: [...PROFANITY.edge, ...CHAT_EXTRA.edge], word: [...PROFANITY.word, ...CHAT_EXTRA.word] },
  ALLOWLIST,
);

const TLDS = 'com|net|org|ng|io|gg|me|co|xyz|app|link|ly|tv|info|biz|site|online|shop|live|store|top|club|vip|ru|uk|us';
const LINK = new RegExp(String.raw`(?:https?:|www\.|\b(?:t|wa)\.me\b|\bbit\.ly\b|\b[\p{L}\p{N}-]+\s*(?:\.|\(\s*dot\s*\)|\[\s*dot\s*\]|\s+dot\s+)\s*(?:${TLDS})\b)`, 'iu');
/** digits with spaces, dots, dashes or brackets between them, folded together before counting */
const DIGIT_JOINERS = /(\d)[\s.\-()]+(?=\d)/g;

/** NFKC, invisible and control characters out, spaces tidied. */
export function cleanChatText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Runs of 3+ one-letter words ("f u c k"), and words that are letters split by dots or dashes ("f.u.c.k"), each joined up. */
function spelledOut(words: readonly string[]): string[] {
  const runs: string[] = [];
  let run = '';
  const flush = () => {
    if (run.length >= 3) runs.push(run);
    run = '';
  };
  for (const w of words) {
    if (filterForm(w).length === 1) run += w;
    else {
      flush();
      if (/^(?:\p{L}[.\-_*]){2,}\p{L}?$/u.test(w)) runs.push(w.replace(/[.\-_*]/g, ''));
    }
  }
  flush();
  return runs;
}

export function checkChatText(raw: string): TextVerdict {
  const text = cleanChatText(raw);
  if (!text) return { ok: false, code: 'empty', message: 'Write something first' };
  if (graphemeLength(text) > LOBBY_LIMITS.textMax) return { ok: false, code: 'too_long', message: `${LOBBY_LIMITS.textMax} characters at most` };
  if (LINK.test(text)) return { ok: false, code: 'link', message: 'Links can’t go in the Lobby' };
  if (/\d{7,}/.test(text.replace(DIGIT_JOINERS, '$1'))) return { ok: false, code: 'digits', message: 'Long numbers can’t go in the Lobby (phone numbers, accounts)' };
  const words = text.split(' ');
  if (words.some((w) => refuse.matches(w))) return { ok: false, code: 'refused', message: 'That can’t go in the Lobby' };
  let masked = false;
  const out = words.map((w) => {
    if (!mask.matches(w)) return w;
    masked = true;
    return '•••';
  });
  // runs of single letters, joined: a word spelled out a letter at a time shows up here
  for (const run of spelledOut(words)) if (mask.matches(run) || refuse.matches(run)) return { ok: false, code: 'refused', message: 'That can’t go in the Lobby' };
  return { ok: true, text: out.join(' '), masked };
}
