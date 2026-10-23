/**
 * The character creator as the game's #/creator route: what main.ts loads lazily. A module of its own
 * (like locker/route.ts) so the game's lazy import, which needs the bundler's module-namespace helper,
 * never puts that helper in a chunk a standalone page shares (#132 review H1; scripts/built-pages.mjs).
 */
export { mountCreatorRoute } from '.';
