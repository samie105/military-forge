/**
 * The page's entry (index.html). The game itself (main.ts: three.js, the 3D view, the modes, the
 * shell) is a chunk of its own, fetched from here: the landing (index.html's real HTML, already the
 * title's first frame) paints before any of it downloads or runs, and the title's key art isn't
 * sharing the line with two megabytes of script (docs/design/mobile-audit-2026-10-23.md P1-17).
 */
void import('./main');
