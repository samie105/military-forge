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
});
