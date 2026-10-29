/**
 * The 3D view's stand-in. three.js and render3d come as a chunk of their own (view3d/start.ts), so the
 * landing and the title paint and answer without them (audit 28 Oct: the game chunk carried them, and
 * a phone parsed and ran them before the title took a tap). main.ts holds this from boot and starts the
 * chunk early (the title sitting idle, the first tap or key, a room link at once).
 *
 * Calls made before the view exists are kept, the latest of each kind in the order made, and applied
 * when it arrives: quality and Auto, blood, kill effects, Reduce motion, camera shake, the phone's caps,
 * loading the models. Until then it draws nothing and says it is drawing, so the 2D canvas stays an
 * overlay: the same blank world the view itself shows before its models are in.
 */
import type { Renderer3D } from '../render3d';
import type { Frame } from '../view';

/** The view, or null when WebGL didn't start after all (the page draws in 2D). */
export type View3dMaker = () => Promise<Renderer3D | null>;

export class View3dSlot {
  /** the 3D view once its chunk is in and WebGL started; null before, and for good on a page drawing in 2D */
  view: Renderer3D | null = null;
  /** the chunk didn't come (offline, a page from an older build): the 2D view until a start succeeds */
  private missing = false;
  /** WebGL didn't start: the 2D view for good */
  private failed = false;
  private starting: Promise<Renderer3D | null> | null = null;
  private readonly calls = new Map<string, (v: Renderer3D) => void>();
  private readonly ready: ((v: Renderer3D) => void)[] = [];
  private readonly settled: ((v: Renderer3D | null) => void)[] = [];

  /** `make`: fetches the chunk and makes the view; null: this page draws in 2D (?render=2d, no WebGL 2) */
  constructor(private readonly make: View3dMaker | null) {}

  /** Whether this page means to draw in 3D (the view may still be on its way). */
  get wanted(): boolean {
    return this.make !== null && !this.failed;
  }

  /** whether the chunk has been asked for */
  get started(): boolean {
    return this.starting !== null || this.view !== null;
  }

  /** Drawing the world: the view's own answer once it's here; on its way, yes (nothing drawn yet, as before its models). */
  get drawing(): boolean {
    if (this.view) return this.view.drawing;
    return this.wanted && !this.missing;
  }

  /** Fetches the chunk and makes the view (once; again after a failed fetch). */
  start(): Promise<Renderer3D | null> {
    if (!this.make || this.failed) return Promise.resolve(this.view);
    this.starting ??= this.make().then(
      (view) => {
        this.missing = false;
        if (!view) {
          this.failed = true;
          this.calls.clear();
        } else this.arrive(view);
        for (const w of this.settled.splice(0)) w(view);
        return view;
      },
      (err: unknown) => {
        console.warn('view3d: the 3D view did not load; drawing in 2D for now', err);
        this.missing = true;
        this.starting = null;
        for (const w of this.settled.splice(0)) w(null);
        return null;
      },
    );
    return this.starting;
  }

  private arrive(view: Renderer3D): void {
    this.view = view;
    for (const fn of this.ready.splice(0)) fn(view);
    const calls = [...this.calls.values()];
    this.calls.clear();
    for (const fn of calls) fn(view);
  }

  /** Runs `fn` with the view as soon as it's here (now, if it is), before the calls kept for it. */
  onReady(fn: (view: Renderer3D) => void): void {
    if (this.view) fn(this.view);
    else if (this.wanted) this.ready.push(fn);
  }

  /**
   * The view when the next start settles (at once if it's here, or can't come); null when it can't be
   * had now. Doesn't start it: the portraits wait for it without fetching three for a picture.
   */
  whenSettled(): Promise<Renderer3D | null> {
    if (this.view || !this.wanted) return Promise.resolve(this.view);
    return new Promise((resolve) => this.settled.push(resolve));
  }

  /** The view's method now, or kept until it arrives (the latest call of each kind, in the order made). */
  private call(kind: string, fn: (view: Renderer3D) => void): void {
    if (this.view) return fn(this.view);
    if (!this.wanted) return;
    this.calls.delete(kind);
    this.calls.set(kind, fn);
  }

  // the settings and loading calls, kept until the view is here

  setPreset(...args: Parameters<Renderer3D['setPreset']>): void {
    this.call('preset', (v) => v.setPreset(...args));
  }
  setAutoTier(...args: Parameters<Renderer3D['setAutoTier']>): void {
    this.call('autoTier', (v) => v.setAutoTier(...args));
  }
  setBlood(on: boolean): void {
    this.call('blood', (v) => v.setBlood(on));
  }
  setShowKillEffects(on: boolean): void {
    this.call('killEffects', (v) => v.setShowKillEffects(on));
  }
  setReducedMotion(on: boolean): void {
    this.call('reducedMotion', (v) => v.setReducedMotion(on));
  }
  setShakeScale(k: number): void {
    this.call('shake', (v) => v.setShakeScale(k));
  }
  setDprCap(cap: number | null): void {
    this.call('dprCap', (v) => v.setDprCap(cap));
  }
  setTouchDevice(on: boolean): void {
    this.call('touch', (v) => v.setTouchDevice(on));
  }
  /** The models, effects and shader warm-up (prepareForPlay), from where `spawn` says when the view is here. */
  load(spawn: () => { x: number; y: number }): void {
    this.call('load', (v) => void v.load(spawn()));
  }

  // per frame: nothing to do until the view is here (it's made on the map and size of that moment)

  render(frame: Frame, dt: number): void {
    this.view?.render(frame, dt);
  }
  resize(): void {
    this.view?.resize();
  }
  setMap(...args: Parameters<Renderer3D['setMap']>): void {
    this.view?.setMap(...args);
  }
}
