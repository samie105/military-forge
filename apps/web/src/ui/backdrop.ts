/**
 * The menus' backdrop (main.ts drawMenuBackdrop: the map drifting behind the menus) costs a full 3D
 * frame, and most of the time nobody can see it: the title screen and every menu screen
 * (.screen--menu) are opaque, and while the page boots the landing (index.html) is the picture. Drawing
 * it 60 times a second there took the frame budget from the menus' own motion on phones.
 *
 * So while it's covered it draws once a second: enough to keep the map's shaders and textures warm
 * for the moment a screen lets it show, nothing like the cost. Uncovered (a see-through game screen
 * with no mode running), every frame as before. Whether it's covered is read from the page at most
 * four times a second, not per frame.
 */

/**
 * What's opaque in front of the backdrop: the title, the menus (not the see-through game screens), a
 * full-screen route, and while the app boots the loading screen or the landing.
 */
export const COVERING = '#shell .mf-title, #shell .mf-fit > .screen--menu, .mf-route, #boot-splash, html.mf-boot-landing:not(.mf-app) #land-hero';

export const COVERED_DRAW_MS = 1000;
/** A covered backdrop's first draw waits this long: the page's first picture (the landing's key art) paints first. */
export const FIRST_COVERED_DRAW_MS = 1500;
const LOOK_MS = 250;

export class BackdropPacer {
  private coveredNow = true;
  private lookedAt = -Infinity;
  private drawnAt = -Infinity;

  constructor(
    /** whether the page covers the backdrop right now (a DOM query; read at most every 250 ms) */
    private readonly covered: () => boolean = () => document.querySelector(COVERING) !== null,
  ) {}

  /** Whether to draw the backdrop on this frame. */
  shouldDraw(now: number): boolean {
    if (now - this.lookedAt >= LOOK_MS || now < this.lookedAt) {
      this.lookedAt = now;
      this.coveredNow = this.covered();
    }
    // covered from the start: the first draw (shaders compiling, textures uploading) comes a moment in
    if (this.drawnAt === -Infinity && this.coveredNow) this.drawnAt = now - COVERED_DRAW_MS + FIRST_COVERED_DRAW_MS;
    if (this.coveredNow && now - this.drawnAt < COVERED_DRAW_MS) return false;
    this.drawnAt = now;
    return true;
  }
}
