/**
 * The Locker as the game's #/locker route: what main.ts loads lazily. A module of its own (not
 * locker/index.ts itself) so the game's lazy import, which needs the bundler's module-namespace
 * helper, never puts that helper in the chunk locker.html shares: a shared chunk that imports the
 * game's entry chunk boots the game on the Locker's page (#132 review H1; scripts/built-pages.mjs).
 */
export { mountLockerRoute } from '.';
