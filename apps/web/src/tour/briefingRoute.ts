/**
 * The Briefing as the game's #/briefing route: what main.ts loads lazily (a module of its own, like
 * creator/route.ts, so the lazy import's namespace helper stays out of shared chunks).
 */
export { mountBriefing } from './briefing';
