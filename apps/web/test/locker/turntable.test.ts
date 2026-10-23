import { afterEach, describe, expect, it, vi } from 'vitest';

const renderers: { calls: string[] }[] = [];

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    readonly calls: string[] = [];
    constructor() {
      renderers.push(this);
    }
    setPixelRatio(): void {}
    setSize(): void {}
    render(): void {}
    dispose(): void {
      this.calls.push('dispose');
    }
    forceContextLoss(): void {
      this.calls.push('forceContextLoss');
    }
  }
  return { ...three, WebGLRenderer: FakeRenderer };
});

describe('Turntable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('releases its WebGL context on dispose, so repeated Locker visits never evict the game context', async () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { Turntable } = await import('../../src/locker/turntable');
    const canvas = { clientWidth: 320, clientHeight: 240, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
    new Turntable(canvas).dispose();
    expect(renderers).toHaveLength(1);
    expect(renderers[0]!.calls).toEqual(['dispose', 'forceContextLoss']);
  });

  it('turns with one finger and zooms with a pinch (two fingers apart = closer)', async () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { Turntable } = await import('../../src/locker/turntable');
    const on: Record<string, (e: Partial<PointerEvent>) => void> = {};
    const canvas = {
      clientWidth: 320,
      clientHeight: 240,
      addEventListener: (type: string, fn: (e: Partial<PointerEvent>) => void) => (on[type] = fn),
      removeEventListener() {},
      setPointerCapture() {},
      hasPointerCapture: () => false,
      releasePointerCapture() {},
    } as unknown as HTMLCanvasElement;
    const t = new Turntable(canvas);
    const state = t as unknown as { yaw: number; zoom: number };
    const yaw = state.yaw;
    on.pointerdown!({ pointerId: 1, clientX: 100, clientY: 100 });
    on.pointermove!({ pointerId: 1, clientX: 150, clientY: 100 });
    expect(state.yaw).toBeCloseTo(yaw + 0.5, 5);
    on.pointerdown!({ pointerId: 2, clientX: 200, clientY: 100 });
    on.pointermove!({ pointerId: 2, clientX: 250, clientY: 100 }); // the fingers spread: 50 → 100 px
    expect(state.zoom).toBeCloseTo(0.55, 5); // 1 × 50/100, held at the closest
    expect(state.yaw).toBeCloseTo(yaw + 0.5, 5); // a pinch doesn't turn
    on.pointerup!({ pointerId: 2 });
    on.pointermove!({ pointerId: 1, clientX: 160, clientY: 100 }); // the finger left turns on from where it is
    expect(state.yaw).toBeCloseTo(yaw + 0.6, 5);
    t.zoomBy(10);
    expect(state.zoom).toBe(1.6);
    t.dispose();
  });
});

describe('Turntable: the creator stage', () => {
  afterEach(() => vi.unstubAllGlobals());

  const make = async () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { Turntable } = await import('../../src/locker/turntable');
    const canvas = { clientWidth: 320, clientHeight: 240, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
    const t = new Turntable(canvas);
    let ms = 0;
    const tick = (t as unknown as { tick: (ms: number) => void }).tick;
    /** runs the page at 60 Hz for `seconds`; the frames drawn */
    const run = (seconds: number): number => {
      const before = t.drawn;
      for (let k = 0; k < seconds * 60; k++) tick((ms += 1000 / 60));
      return t.drawn - before;
    };
    return { t, run, state: t as unknown as { targetY: number; distance: number; yaw: number; touch: boolean } };
  };

  it('frames a tab over 450 ms: the head and shoulders for hair', async () => {
    const { t, run, state } = await make();
    const { SHOTS } = await import('../../src/locker/stage');
    run(1);
    t.frameTab('hair');
    run(0.2);
    expect(state.targetY).toBeGreaterThan(SHOTS.full.y);
    expect(state.targetY).toBeLessThan(SHOTS.head.y - 0.01); // still on its way
    run(0.3);
    expect(state.targetY).toBeCloseTo(SHOTS.head.y, 5);
    expect(state.distance).toBeCloseTo(SHOTS.head.distance, 5);
    expect(state.yaw).toBeCloseTo(SHOTS.head.yaw, 5);
    t.dispose();
  });

  it('draws nothing at rest under Reduce motion, and at most 30 fps idle on a phone', async () => {
    const { t, run, state } = await make();
    t.setReducedMotion(true);
    run(4);
    expect(run(5)).toBe(0);
    t.zoomBy(0.9); // an input wakes it
    expect(run(0.5)).toBe(30);
    t.setReducedMotion(false);
    state.touch = true;
    run(1);
    expect(run(2)).toBeLessThanOrEqual(60);
    t.dispose();
  });
});
