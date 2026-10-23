/** The title screen's build-time facts (vite.config.ts `titleInfo`). */
declare module 'virtual:title-info' {
  /** this build's git short hash ('dev' without git) */
  export const buildId: string;
  /**
   * The Forge's key art in public/art/key-art/: each picture's files, best format first (AVIF, then
   * WebP); empty = not there.
   */
  export const keyArt: {
    desktop: string[];
    phone: string[];
    desktopFg: string[];
    phoneFg: string[];
    /** the desktop's 5 s ambient loop (WebM, MP4) */
    desktopLoop: string[];
  };
}
