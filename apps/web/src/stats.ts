/**
 * Live numbers the menus and the HUD show about this device and connection: the frame rate (Show
 * FPS, the Graphics tab) and the last 30 seconds of ping and loss (the Network tab). main.ts feeds
 * them from the game loop; reading them costs nothing.
 */

let frames = 0;
let windowStart = 0;
let fps = 0;

/** Once per drawn frame. */
export function countFrame(now: number): void {
  if (windowStart === 0) windowStart = now;
  frames++;
  const span = now - windowStart;
  if (span >= 500) {
    fps = (frames * 1000) / span;
    frames = 0;
    windowStart = now;
  }
}

/** Frames per second over the last half second (0 before the first measure). */
export function framesPerSecond(): number {
  return fps;
}

export interface NetSample {
  pingMs: number;
  lossPct: number;
}

/** Seconds of history the Network tab draws. */
export const NET_HISTORY = 30;

const samples: NetSample[] = [];
let lastSampleAt = -Infinity;
let server = '';

/** Once per frame while online: keeps one sample a second. */
export function recordNet(now: number, pingMs: number, lossPct: number, host: string): void {
  if (host !== server) {
    samples.length = 0;
    server = host;
  }
  if (now - lastSampleAt < 1000 || !Number.isFinite(pingMs)) return;
  lastSampleAt = now;
  samples.push({ pingMs, lossPct });
  if (samples.length > NET_HISTORY) samples.shift();
}

/** Out of a room: the history stays for a look, marked not live. */
export function netHistory(now = performance.now()): { samples: readonly NetSample[]; server: string; live: boolean } {
  return { samples, server, live: now - lastSampleAt < 3000 };
}
