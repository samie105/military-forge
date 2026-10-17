/**
 * Word lists for the nickname filter (docs/07 §3 and §9). Terms are matched on `filterForm`
 * (normalize.ts), so case, accents, lookalike letters and leetspeak are already folded, and every
 * letter may repeat ("fuuuck"). Double letters in a term must stay double, so "Nigeria" never
 * matches a slur.
 *
 * - `anywhere`: never part of an innocent word; matched inside the whole name.
 * - `edge`: matched at the start or end of the whole name, or as a word ("AdminJoe", but not
 *   "Badminton").
 * - `word`: only as a whole word, because innocent words contain them ("Assassin", "Kshitij",
 *   "Dickens", "Modric").
 *
 * A starter list for the launch locales (English, Nigerian Pidgin/Yoruba, Hindi/Hinglish). It
 * needs native-speaker review and a fuller multi-language list before launch; extend it here.
 */
export interface TermList {
  anywhere: readonly string[];
  edge: readonly string[];
  word: readonly string[];
}

export const PROFANITY: TermList = {
  anywhere: [
    'fuck', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'bitch', 'slut', 'pussy', 'penis', 'vagina',
    'asshole', 'molest', 'pedophil', 'paedophil', 'hitler', 'kkk',
    'chutiya', 'chutia', 'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'benchod', 'bhosdi', 'bhosadi',
  ],
  edge: ['shit', 'retard'],
  // "porn"/"rapist" are words only: Thai given names (Pornchai) and "therapist" contain them
  word: [
    'ass', 'arse', 'cock', 'dick', 'fag', 'tits', 'cum', 'sex', 'porn', 'porno', 'rape', 'rapist', 'pedo', 'paedo', 'nazi',
    'gandu', 'ashawo', 'olosho',
  ],
};

/** Staff and system names (docs/07 §3 "admin", "mod", staff names). The game name is added in rules.ts. */
export const IMPERSONATION: TermList = {
  anywhere: ['administrator', 'moderator', 'gamemaster', 'developer', 'official', 'helpdesk'],
  edge: ['admin'],
  // not "dev": it is a common Indian given name
  word: ['mod', 'mods', 'staff', 'support', 'gm', 'system', 'server', 'owner', 'bot'],
};

/** Innocent words that contain an `anywhere` or `edge` term; cut out of the name before matching. */
export const ALLOWLIST: readonly string[] = ['scunthorpe', 'shiitake'];
