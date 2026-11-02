/**
 * The landing's lockup as a picture (vite.config.ts fills index.html's %LOCKUP% with it): the pipeline's colour
 * file drawn at 1000 px (public/art/brand/forged-force-lockup-1000.{avif,webp}, art/pipeline/lockup.py: the same
 * paths and colours ui/Lockup.tsx draws on the title). The AVIF (~17 KB) goes inline in the page, so it needs
 * no request and is in the first frame; a browser without AVIF fetches the WebP.
 *
 * A picture, not inline SVG paths, for two reasons measured in the first screen audit (1 Nov 2026):
 *   - the lockup is the landing's biggest piece of content, and browsers time a page's largest paint (LCP) by
 *     images and text only: inline SVG paths never count, nor does the full-bleed key art (a picture the size
 *     of the window reads as a background). With inline paths the page's "largest" paint was a line of small
 *     text, then whatever the app drew later (on an upright phone, the turn-your-phone card, ~11 s in);
 *   - a bitmap is one textured quad to draw, where the outlined, shadowed paths took a slow GPU (or a software
 *     one, like Lighthouse's) a second or two, holding the whole first frame back (FCP 2.5 s against 4.2 s).
 * The title takes over with the vector lockup, sharp at any size.
 */

/** The picture's size in pixels (the file is drawn 1000 px wide from the lockup's viewBox). */
export const LOCKUP_PICTURE = { width: 1000, height: 504 } as const;

/**
 * `<picture>` markup: the inline AVIF first, the WebP file as the fallback. Decoration: the h1's words are beside
 * it (`alt=""`). `timing`: its `elementtiming` name, so the page can tell when it is on screen (src/boot.ts waits
 * for that before the game's chunk runs).
 */
export function lockupPictureMarkup(avifBase64: string, webpUrl: string, className: string, timing?: string): string {
  const inline = `data:image/avif;base64,${avifBase64}`;
  const named = timing ? ` elementtiming="${timing}"` : '';
  const { width, height } = LOCKUP_PICTURE;
  return (
    `<picture><source type="image/avif" srcset="${inline}" />` +
    `<img class="${className}" src="${webpUrl}" width="${width}" height="${height}" alt=""${named} fetchpriority="high" draggable="false" /></picture>`
  );
}
