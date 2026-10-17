/**
 * Nickname normal forms (docs/07 §3, §9 step 1).
 *
 * - {@link cleanNickname}: the display form. NFKC (fullwidth/ligature/compatibility letters fold
 *   to plain ones), whitespace runs collapsed to one space, trimmed.
 * - {@link skeleton}: the uniqueness key (`profiles.nickname_norm`). Two names with the same
 *   skeleton look alike on screen, so only one of them may exist: case, accents on
 *   Latin/Greek/Cyrillic letters, Cyrillic/Greek lookalikes, `0/o`, `1/l/I/i`, `rn/m`, `vv/w`
 *   and separators are folded. Modelled on the UTS #39 skeleton, trimmed to what a 16-character
 *   game name needs.
 * - {@link filterForm}: what the profanity/impersonation filter matches. Like the skeleton, but
 *   with leetspeak folded (`3→e`, `4→a`, `$`-style digits) and without the `rn→m` style folds
 *   that would create false hits ("porn" must not become "pom").
 */

/** separators allowed inside a nickname */
export const SEPARATORS = /[ _.-]/gu;

export function cleanNickname(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/**
 * Letters that render like a Latin letter (lowercase forms). The Latin part doubles as the
 * repertoire of non-ASCII Latin letters a nickname may use at all (see {@link unusualLatin}).
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', г: 'r', е: 'e', ё: 'e', з: '3', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', п: 'n',
  р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ь: 'b', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l',
  // Greek
  α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u',
  χ: 'x', ω: 'w', ϲ: 'c',
  // Armenian
  օ: 'o', ս: 'u', ո: 'n', հ: 'h', ց: 'g', զ: 'q', ա: 'w',
  // Latin letters NFKD leaves alone: European ones, and the hooked/open letters of Hausa, Akan,
  // Ewe and the Pan-Nigerian alphabet
  ı: 'i', ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'p', ð: 'd', ŋ: 'n', ĸ: 'k',
  ɓ: 'b', ɗ: 'd', ƙ: 'k', ƴ: 'y', ɛ: 'e', ɔ: 'o', ə: 'e', ǝ: 'e',
};

/** Shared first steps: compatibility-decompose, drop marks on Latin/Greek/Cyrillic, lowercase, map lookalikes. */
function fold(name: string): string {
  const decomposed = cleanNickname(name)
    .normalize('NFKD')
    // only marks on alphabets with Latin lookalikes; Devanagari vowel signs etc. are real letters
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase();
  let out = '';
  for (const ch of decomposed) out += LOOKALIKES[ch] ?? ch;
  return out;
}

const UNUSUAL_LATIN = /(?![a-z])\p{Script=Latin}/u;

/**
 * True when the name uses a Latin letter outside plain a–z, accented letters (which decompose to
 * them) and the {@link LOOKALIKES} list: small capitals (`ᴀᴅᴍɪɴ`), IPA (`ɑ`, `ɡ`), Latin
 * Extended-B/D oddities (`ꜰ`, `ꜱ`, `ƒ`). Fancy-text generators use exactly these to dodge word
 * filters and copy other players' names, and no real name needs them.
 */
export function unusualLatin(name: string): boolean {
  return UNUSUAL_LATIN.test(fold(name));
}

export function skeleton(name: string): string {
  return fold(name)
    .replace(SEPARATORS, '')
    .replace(/[01i]/g, (c) => (c === '0' ? 'o' : 'l'))
    .replaceAll('rn', 'm')
    .replaceAll('vv', 'w');
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', l: 'i' };

/** Leet-folded form of one token (no separators inside). `l` folds to `i` so `NlGGA`-style swaps still match. */
export function filterForm(text: string): string {
  let out = '';
  for (const ch of fold(text).replace(SEPARATORS, '')) out += LEET[ch] ?? ch;
  return out;
}

/**
 * Splits a display name into words at separators and camelCase boundaries
 * ("SuperMod_Guy" → ["Super", "Mod", "Guy"], "xXAssXx" → ["x", "X", "Ass", "Xx"]). Digits stay attached ("Ass99", "A55"): the filter
 * also tries each word with leading/trailing digits removed.
 */
export function tokens(name: string): string[] {
  return cleanNickname(name)
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(SEPARATORS)
    .filter(Boolean);
}
