/**
 * The Armory as the game's #/armory route (mobile audit P0-6: no page load, so full screen survives):
 * what main.ts loads lazily. A module of its own, like locker/route.ts, so the lazy import's namespace
 * helper never lands in the chunk armory.html shares (#132 review H1; scripts/built-pages.mjs).
 */
export { mountArmoryRoute } from '.';
