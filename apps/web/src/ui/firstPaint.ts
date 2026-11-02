/**
 * When the page's first frame is on screen (src/boot.ts waits for it before the game runs). The game's chunk
 * runs for seconds on a slow phone (three.js, the 3D view, its WebGL context and shaders) and holds the main
 * thread and the GPU while it does: started before the landing's first frame was shown, it held that frame back
 * (first screen audit, 1 Nov 2026: the landing appeared only after ~4 s even on a desktop, with every file it
 * needed in hand at 0.2 s).
 *
 * `element`: the `elementtiming` name of the frame's main picture (the landing's lockup), and the wait is for
 * that picture on screen, not just the first text: a picture is drawn after the words around it, and the
 * game's work started in between held it back too. Without one (a room link's loading screen), or where the
 * browser has no element timing, the first contentful paint. Each is reported once its frame is presented.
 * At the latest after `capMs`, whatever happens: a tab opened in the background doesn't paint, and a browser
 * with no paint timing at all waits two animation frames and a task.
 */
export function afterFirstPaint(element: string | null = null, capMs = 2500): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let observer: PerformanceObserver | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      observer?.disconnect();
      resolve();
    };
    const cap = setTimeout(finish, capMs);
    try {
      const types = typeof PerformanceObserver === 'function' ? (PerformanceObserver.supportedEntryTypes ?? []) : [];
      const byElement = element !== null && types.includes('element');
      const type = byElement ? 'element' : 'paint';
      const seen = (entries: readonly PerformanceEntry[]) =>
        entries.some((e) => (byElement ? (e as PerformanceEntry & { identifier?: string }).identifier === element : e.name === 'first-contentful-paint'));
      if (types.includes(type)) {
        if (!byElement && seen(performance.getEntriesByType('paint'))) return finish();
        observer = new PerformanceObserver((list) => {
          if (seen(list.getEntries())) finish();
        });
        observer.observe({ type, buffered: true });
        return;
      }
    } catch {
      // paint timing that won't observe: fall back to frames below
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
    else finish();
  });
}
