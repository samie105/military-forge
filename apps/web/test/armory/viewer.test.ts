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

describe('ArmoryViewer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('releases its WebGL context on dispose, like the Locker', async () => {
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
    const { ArmoryViewer } = await import('../../src/armory/viewer');
    const canvas = { clientWidth: 320, clientHeight: 240, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
    new ArmoryViewer(canvas).dispose();
    expect(renderers).toHaveLength(1);
    expect(renderers[0]!.calls).toEqual(['dispose', 'forceContextLoss']);
  });

  describe('model and attachment lifetimes', () => {
    type Loaded = { scene: import('three').Object3D };
    async function setup() {
      vi.stubGlobal('window', { devicePixelRatio: 1 });
      vi.stubGlobal('requestAnimationFrame', () => 1);
      vi.stubGlobal('cancelAnimationFrame', () => {});
      vi.stubGlobal('ResizeObserver', class {
        observe(): void {}
        disconnect(): void {}
      });
      const three = await import('three');
      const { ArmoryViewer } = await import('../../src/armory/viewer');
      const canvas = { clientWidth: 320, clientHeight: 240, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
      const viewer = new ArmoryViewer(canvas);
      const loader = (viewer as unknown as { loader: { loadAsync: (url: string) => Promise<Loaded> } }).loader;
      const model = () => {
        const geo = new three.BoxGeometry(0.1, 0.1, 0.4);
        geo.setAttribute('_camo', new three.Float32BufferAttribute(new Array(geo.attributes.position!.count).fill(1), 1));
        const mat = new three.MeshStandardMaterial();
        const mesh = new three.Mesh(geo, mat);
        const scene = new three.Group().add(mesh);
        return { scene, geo, mat, mesh };
      };
      const attachments = () => (viewer as unknown as { attachments: import('three').Object3D[] }).attachments;
      return { viewer, loader, model, attachments };
    }
    const entry = { mount: 'rail_top' as const, file: 'x.glb', nodes: {} };
    const sockets = { rail_top: { pos: [0, 0.1, 0.08] as [number, number, number] } };

    it('frees the previous weapon, its factory material and its camo copy when switching', async () => {
      const { viewer, loader, model } = await setup();
      const a = model();
      const b = model();
      loader.loadAsync = vi.fn().mockResolvedValueOnce({ scene: a.scene }).mockResolvedValueOnce({ scene: b.scene });
      await viewer.setWeapon('a.glb', sockets);
      viewer.setCamo((m) => m.clone());
      const copy = a.mesh.material as import('three').Material;
      expect(copy).not.toBe(a.mat);
      const spies = [vi.spyOn(a.geo, 'dispose'), vi.spyOn(a.mat, 'dispose'), vi.spyOn(copy, 'dispose')];
      await viewer.setWeapon('b.glb', sockets);
      for (const s of spies) expect(s).toHaveBeenCalled();
      viewer.dispose();
    });

    it('keeps the latest attachment set when an older toggle resolves later', async () => {
      const { viewer, loader, model, attachments } = await setup();
      const gun = model();
      const older = model();
      const newer = model();
      const pending: Record<string, (v: Loaded) => void> = {};
      loader.loadAsync = vi.fn((url: string) =>
        url === 'gun.glb' ? Promise.resolve({ scene: gun.scene }) : new Promise<Loaded>((res) => (pending[url] = res)));
      await viewer.setWeapon('gun.glb', sockets);
      const first = viewer.setAttachments([{ id: 'sight_long', url: 'older.glb', entry }]);
      const second = viewer.setAttachments([{ id: 'sight_dot', url: 'newer.glb', entry }]);
      pending['newer.glb']!({ scene: newer.scene });
      await second;
      const freed = vi.spyOn(older.geo, 'dispose');
      pending['older.glb']!({ scene: older.scene });
      await first;
      expect(attachments()).toEqual([newer.scene]);
      expect(freed).toHaveBeenCalled();
      viewer.dispose();
    });

    it('skips an attachment that fails to load and reports it', async () => {
      const { viewer, loader, model, attachments } = await setup();
      const gun = model();
      const ok = model();
      loader.loadAsync = vi.fn((url: string) =>
        url === 'bad.glb' ? Promise.reject(new Error('404')) : Promise.resolve({ scene: url === 'gun.glb' ? gun.scene : ok.scene }));
      await viewer.setWeapon('gun.glb', sockets);
      const failed = await viewer.setAttachments([
        { id: 'laser', url: 'bad.glb', entry },
        { id: 'sight_dot', url: 'ok.glb', entry },
      ]);
      expect(failed).toEqual(['laser']);
      expect(attachments()).toEqual([ok.scene]);
      viewer.dispose();
    });
  });
});
