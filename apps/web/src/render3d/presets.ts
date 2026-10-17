/**
 * Graphics presets, dynamic resolution and the frame-time meter (docs/11 §3).
 * Milestone A stub: the three presets and their knobs exist and apply live (except MSAA, which
 * needs a new WebGL context: it applies on reload). Auto quality (measure 300 frames, then pick a
 * preset) comes with Milestone B.
 */
export type PresetName = 'low' | 'medium' | 'high';

export interface GraphicsPreset {
  name: PresetName;
  /** device pixel ratio cap */
  dprCap: number;
  /** MSAA on the default framebuffer (needs a reload to change) */
  antialias: boolean;
  /** blob/contact shadows under players, or one 1024² directional map over the gameplay frustum */
  shadows: 'blob' | 'map';
  /** dynamic resolution never goes below this render scale */
  minScale: number;
  /** remote players use the LOD1 mesh */
  remoteLod1: boolean;
  /** live particle budget (docs/11 §3: ≤ 1.5K Low, ≤ 5K High) */
  particles: number;
  /** effect density: particles per blast */
  vfxDetail: number;
  /** real point lights for blasts; Low/Medium tint the ambient light instead (docs/11 §2) */
  vfxLights: boolean;
}

export const PRESETS: Readonly<Record<PresetName, GraphicsPreset>> = {
  low: { name: 'low', dprCap: 1, antialias: false, shadows: 'blob', minScale: 0.6, remoteLod1: true, particles: 1500, vfxDetail: 0.6, vfxLights: false },
  medium: { name: 'medium', dprCap: 1.25, antialias: true, shadows: 'blob', minScale: 0.7, remoteLod1: false, particles: 3000, vfxDetail: 0.8, vfxLights: false },
  high: { name: 'high', dprCap: 1.5, antialias: true, shadows: 'map', minScale: 0.8, remoteLod1: false, particles: 5000, vfxDetail: 1, vfxLights: true },
};

/** `?gfx=` value → preset (Low until auto quality exists: the min-spec target is an iGPU laptop). */
export function parsePreset(value: string | null | undefined): GraphicsPreset {
  return PRESETS[(value ?? '').toLowerCase() as PresetName] ?? PRESETS.low;
}

/** Ring buffer of recent samples with percentiles (allocation-free after construction). */
export class SampleWindow {
  private readonly values: Float64Array;
  private readonly sorted: Float64Array;
  private count = 0;
  private next = 0;

  constructor(size: number) {
    this.values = new Float64Array(size);
    this.sorted = new Float64Array(size);
  }

  get length(): number {
    return this.count;
  }

  push(v: number): void {
    this.values[this.next] = v;
    this.next = (this.next + 1) % this.values.length;
    this.count = Math.min(this.count + 1, this.values.length);
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
  }

  /** p in 0…1, nearest-rank; NaN while empty */
  percentile(p: number): number {
    if (!this.count) return NaN;
    const s = this.sorted.subarray(0, this.count);
    s.set(this.values.subarray(0, this.count));
    s.sort();
    return s[Math.min(this.count - 1, Math.max(0, Math.ceil(p * this.count) - 1))]!;
  }

  mean(): number {
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.values[i]!;
    return this.count ? sum / this.count : NaN;
  }
}

/**
 * Dynamic resolution (docs/11 §3): steps the render scale between `minScale` and 1 from the p90
 * frame interval. Frame intervals are vsync-quantised, so headroom can't be seen directly: after
 * `probeAfter` clean windows it probes one step up, and backs off again if that misses frames.
 *
 * The budget is 60 fps or the display's own frame interval, whichever is longer: on a 50 Hz panel
 * every frame takes 20 ms however idle the GPU is, and that is not a miss. The display interval is
 * the shortest interval seen over the last `refreshWindows` windows (it starts at the 60 fps budget,
 * so a GPU-bound start still steps down). Intervals longer than `stallMs` (a hidden tab's 1 Hz
 * timer, a debugger pause) are not frames the GPU was late for: they restart the window.
 */
export class DynamicResolution {
  scale = 1;
  /** a fixed scale (screenshots, benchmarks): sampling leaves it alone */
  pinned: number | null = null;
  private readonly window: SampleWindow;
  private readonly mins: SampleWindow;
  private cleanWindows = 0;
  private refresh: number;

  constructor(
    public minScale: number,
    /** the frame budget: 60 fps */
    readonly budgetMs = 1000 / 60,
    readonly windowFrames = 60,
    readonly probeAfter = 5,
    readonly refreshWindows = 8,
    readonly stallMs = 250,
  ) {
    this.window = new SampleWindow(windowFrames);
    this.mins = new SampleWindow(refreshWindows);
    for (let i = 0; i < refreshWindows; i++) this.mins.push(budgetMs);
    this.refresh = budgetMs;
  }

  /** the display's frame interval as measured, ms (never below the 60 fps budget) */
  get refreshMs(): number {
    return this.refresh;
  }

  /** Drops the current window (tab hidden, resumed after a pause). */
  reset(): void {
    this.window.clear();
  }

  /** Feeds one frame interval; returns true when `scale` changed. */
  sample(frameMs: number): boolean {
    if (!(frameMs <= this.stallMs)) {
      this.window.clear();
      return false;
    }
    this.window.push(frameMs);
    if (this.window.length < this.windowFrames || this.pinned !== null) return false;
    const p90 = this.window.percentile(0.9);
    this.mins.push(this.window.percentile(0));
    this.window.clear();
    const before = this.scale;
    const refresh = Math.max(this.budgetMs, this.mins.percentile(0));
    if (refresh > this.refresh * 1.1) {
      // the display is slower than we assumed: the steps down so far were for misses that weren't
      this.scale = 1;
      this.cleanWindows = 0;
    }
    this.refresh = refresh;
    if (p90 > this.refresh * 1.1) {
      this.scale = Math.max(this.minScale, round2(this.scale - 0.1));
      this.cleanWindows = 0;
    } else if (++this.cleanWindows >= this.probeAfter && this.scale < 1) {
      this.scale = Math.min(1, round2(this.scale + 0.05));
      this.cleanWindows = 0;
    }
    return this.scale !== before;
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
