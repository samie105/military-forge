/**
 * The page's entry (index.html). The game itself (main.ts: three.js, the 3D view, the modes, the
 * shell) is a chunk of its own, fetched from here: the landing (index.html's real HTML, already the
 * title's first frame) paints before any of it downloads or runs, and the title's key art isn't
 * sharing the line with two megabytes of script (docs/design/mobile-audit-2026-10-23.md P1-17).
 * It waits for that first frame to be on screen (ui/firstPaint.ts), its lockup included on the
 * landing (public/boot.js marks which shows): the chunk holds the main thread and the GPU for
 * seconds on a slow device, and started any earlier it held the landing back. The landing's
 * decorative layers wait for that frame too (html.mf-painted, index.html).
 *
 * If it can't be fetched (no connection, or a page from before a new version of the game asking for
 * files that are gone), the landing says so and offers Try again, instead of "Loading the game…"
 * forever (public/boot.js listens for mf:boot-failed).
 */
import { afterFirstPaint } from './ui/firstPaint';

const landing = document.documentElement.classList.contains('mf-boot-landing');
void afterFirstPaint(landing ? 'landing-lockup' : null).then(() => {
  // the landing's extras (smoke, sweep, the parallax layer) join now (index.html)
  document.documentElement.classList.add('mf-painted');
  return import('./main').catch((error: unknown) => {
    console.error(error);
    window.dispatchEvent(new Event('mf:boot-failed'));
  });
});
