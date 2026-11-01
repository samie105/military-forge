/**
 * The game's public identity lives ONLY here and in the package scope (@military-forge/*), so a
 * rebrand stays a search-and-replace, not a refactor. "Forged Force" (the owner, 1 Nov 2026; it was
 * Military Forge from 17 Oct) passed a preliminary screen on 28 Oct; a full trademark search comes
 * before filing (docs/01 §12). The package scope keeps the old slug: it's internal only.
 */
export const GAME_NAME = 'Forged Force';
/** lowercase, URL/file/package-safe form */
export const GAME_SLUG = 'forged-force';
export const GAME_NAME_STATUS = 'preliminary screen passed; full trademark search pending';
