/**
 * Avatars from the live character (owner, 23 Oct; docs/design/character-feel-research.md §7): every
 * player's portrait is their real, current soldier, the same everywhere (lobby, scoreboard, results,
 * friends, the VS poster), rendered on this device from their look (protocol v19) and cached by it.
 *
 *   peekPortrait(req)            the cached picture now, or null (show the fallback, then getPortrait)
 *   getPortrait(req, priority)   renders if needed; never rejects (falls back to the silhouette)
 *   warmPortraits(reqs)          a whole lobby's, ahead of time
 *   getAvatar(look) / peekAvatar the 128 px head-and-shoulders portrait: the friends list's (social)
 *   onPortrait(listener)         hears every new picture (DOM views that peek, like the HUD)
 *
 * main.ts installs the renderer (installPortraitsFrom) with the game's WebGL renderer and assembler; a page
 * without 3D gets the silhouettes. setPortraitPolicy says when rendering may run (§7.3.3): freely in
 * menus and lobbies, one job per frame while the player is dead, in the scoreboard or between fights,
 * and not at all mid-fight (jobs wait).
 */
import type { CosmeticLoadout } from '@military-forge/content';
import type { WebGLRenderer } from 'three';
import type { CharacterAssembler } from '../character';
import { PortraitDisk, PortraitMemory } from './cache';
import { silhouetteUrl } from './fallback';
import { lookOf, portraitDims, portraitKey, textHash, type PortraitImage, type PortraitPose, type PortraitRequest, type PortraitSize } from './key';
import type { PortraitRenderer, RenderedPortrait } from './render';

export { defaultPosterPose, isPoster, portraitDims, portraitKey, POSTER_POSES, RENDER_VERSION, type PortraitImage, type PortraitPose, type PortraitRequest, type PortraitSize } from './key';
export { PORTRAIT_TINTS, initialOf, silhouetteUrl, type PortraitTint } from './fallback';

/** 'menus': render freely · 'idle': in a match but not fighting (dead, scoreboard, lobby) · 'busy': mid-fight, wait */
export type PortraitPolicy = 'menus' | 'idle' | 'busy';

/** What renders the pictures (render.ts's PortraitRenderer; tests pass a fake). */
export interface PortraitBackend {
  render(look: CosmeticLoadout, pose: PortraitPose, width: number, height: number): Promise<RenderedPortrait>;
}

interface Job {
  key: string;
  req: PortraitRequest;
  now: boolean;
  promise: Promise<PortraitImage>;
  resolve: (img: PortraitImage) => void;
}

/** A failed render is tried again after this long (the art may arrive). */
const RETRY_MS = 30_000;

export class PortraitService {
  readonly memory: PortraitMemory;
  private backend: PortraitBackend | null = null;
  private art: string | null = null;
  private artReady: Promise<string> | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = false;
  private pumping = false;
  private readonly failed = new Map<string, number>();
  private readonly listeners = new Set<(key: string) => void>();
  private readonly installWaiters = new Set<() => void>();
  policy: () => PortraitPolicy = () => 'menus';
  /** renders done (tests, the perf readout) */
  renders = 0;

  constructor(
    private readonly disk: Pick<PortraitDisk, 'get' | 'put' | 'prune'> = new PortraitDisk(),
    memory?: PortraitMemory,
    private readonly nextFrame: (fn: () => void) => void = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)),
    private readonly objectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.memory = memory ?? new PortraitMemory();
  }

  /** The renderer, and the art version its pictures are keyed by (the manifests' text hash). */
  install(backend: PortraitBackend, artVersion: Promise<string> | string): void {
    this.backend = backend;
    this.artReady = Promise.resolve(artVersion).then(
      (v) => {
        this.art = v;
        // pictures of older art go (§7.3.4: invalidated when the art version changes)
        void this.disk.prune((key) => key.includes(`:${v}:`));
        return v;
      },
      () => (this.art = 'a0'),
    );
    this.pump();
    // a picture asked for before the renderer was here got the silhouette: its view asks again now
    for (const w of [...this.installWaiters]) w();
    this.installWaiters.clear();
  }

  /**
   * Resolves once a renderer is installed (at once if it is): a view that got the silhouette because it
   * asked first (the game's chunk, or its 3D, still loading) asks again then. Never resolves on a page
   * without WebGL.
   */
  whenInstalled(): Promise<void> {
    if (this.backend) return Promise.resolve();
    return new Promise((resolve) => this.installWaiters.add(resolve));
  }

  get installed(): boolean {
    return this.backend !== null;
  }

  peek(req: PortraitRequest): PortraitImage | null {
    if (!this.art) return null;
    const key = portraitKey(req, this.art);
    const hit = this.memory.get(key);
    return hit ? { key, ...hit } : null;
  }

  async get(req: PortraitRequest, priority: 'now' | 'idle' = 'idle'): Promise<PortraitImage> {
    if (!this.backend || !this.artReady) return fallbackImage(req);
    const art = await this.artReady;
    const key = portraitKey(req, art);
    const hit = this.memory.get(key);
    if (hit) return { key, ...hit };
    const pending = this.jobs.get(key);
    if (pending) {
      if (priority === 'now' && !pending.now) this.promote(pending);
      return pending.promise;
    }
    const failedAt = this.failed.get(key);
    if (failedAt !== undefined && this.now() - failedAt < RETRY_MS) return fallbackImage(req);
    let resolve!: (img: PortraitImage) => void;
    const job: Job = { key, req, now: priority === 'now', promise: new Promise((r) => (resolve = r)), resolve };
    this.jobs.set(key, job);
    void this.disk.get(key).then((blob) => {
      if (blob) return this.finish(job, blob);
      if (job.now) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
    return job.promise;
  }

  warm(reqs: readonly PortraitRequest[]): void {
    for (const r of reqs) void this.get(r, 'idle');
  }

  /** Hears the key of every picture that lands; returns the unsubscribe. */
  subscribe(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private promote(job: Job): void {
    job.now = true;
    const at = this.queue.indexOf(job);
    if (at > 0) {
      this.queue.splice(at, 1);
      this.queue.unshift(job);
    }
  }

  private finish(job: Job, blob: Blob): void {
    const { width, height } = portraitDims(job.req.size, job.req.pose);
    const stored = { url: this.objectUrl(blob), width, height };
    this.memory.set(job.key, stored);
    this.jobs.delete(job.key);
    this.failed.delete(job.key);
    job.resolve({ key: job.key, ...stored });
    for (const l of [...this.listeners]) l(job.key);
  }

  /** One job at a time, started on a frame the policy allows (§7.3.3); the readback never blocks. */
  private pump(): void {
    if (this.pumping || !this.backend) return;
    this.pumping = true;
    this.nextFrame(() => {
      this.pumping = false;
      if (this.running || this.queue.length === 0) return;
      const policy = this.policy();
      const job = policy === 'busy' ? null : this.queue.shift();
      if (!job) {
        if (this.queue.length) this.pump(); // mid-fight: try again next frame
        return;
      }
      this.running = true;
      const { width, height } = portraitDims(job.req.size, job.req.pose);
      this.backend!.render(lookOf(job.req), job.req.pose ?? 'portrait', width, height).then(
        (out) => {
          this.renders++;
          this.finish(job, out.blob);
          void this.disk.put(job.key, out.blob);
        },
        (err: unknown) => {
          console.warn('portrait: render failed, showing the silhouette', err);
          this.failed.set(job.key, this.now());
          this.jobs.delete(job.key);
          job.resolve(fallbackImage(job.req));
        },
      ).finally(() => {
        this.running = false;
        this.pump();
      });
    });
  }
}

function fallbackImage(req: PortraitRequest): PortraitImage {
  const { width, height } = portraitDims(req.size, req.pose);
  return { key: 'fallback', url: silhouetteUrl('', 'none', height > width), width, height, fallback: true };
}

/** The page's one portrait service. */
export const portraits = new PortraitService();

export const peekPortrait = (req: PortraitRequest): PortraitImage | null => portraits.peek(req);
export const getPortrait = (req: PortraitRequest, priority: 'now' | 'idle' = 'idle'): Promise<PortraitImage> => portraits.get(req, priority);
export const warmPortraits = (reqs: readonly PortraitRequest[]): void => portraits.warm(reqs);
export const onPortrait = (listener: (key: string) => void): (() => void) => portraits.subscribe(listener);
export const setPortraitPolicy = (policy: () => PortraitPolicy): void => void (portraits.policy = policy);

/**
 * A player's avatar: their soldier, head and shoulders (128 px unless asked; 64 and 256 too), from their
 * look or its wire ids. For the friends list (social), the lobby and anywhere a face stands for a player.
 */
export function getAvatar(look: CosmeticLoadout | readonly number[], size: Exclude<PortraitSize, 512> = 128): Promise<PortraitImage> {
  return portraits.get({ look, size, pose: 'portrait' }, 'now');
}

/** The avatar if it's ready now (null: show the silhouette and call getAvatar). */
export function peekAvatar(look: CosmeticLoadout | readonly number[], size: Exclude<PortraitSize, 512> = 128): PortraitImage | null {
  return portraits.peek({ look, size, pose: 'portrait' });
}

/** The art version: a hash of the bodies' manifests and the parts index (a new art drop renders every portrait again). */
export async function artVersion(base: string): Promise<string> {
  const texts = await Promise.all(['characters/rookie/rookie.json', 'characters/rookie_female/rookie_female.json', 'cosmetics/index.json'].map((p) => fetch(`${base}${p}`).then((r) => (r.ok ? r.text() : '')).catch(() => '')));
  return textHash(texts.join('\n'));
}

/** What portraits draw with: a WebGL renderer and the soldiers' assembler (shared caches with the 3D view's). */
export interface PortraitGl {
  renderer: WebGLRenderer;
  assembler: CharacterAssembler;
}

/**
 * Starts portraits on this page: the game's renderer and assembler (one WebGL context, shared
 * caches), or, on a page drawing in 2D, a function making a renderer of their own on the first picture. Loads the renderer's code lazily, so a page that never shows a portrait never pays for it.
 */
export function installPortraits(renderer: WebGLRenderer | (() => WebGLRenderer), assembler: CharacterAssembler, assetBase = `${import.meta.env.BASE_URL}assets/`): void {
  installPortraitsFrom(() => ({ renderer: typeof renderer === 'function' ? renderer() : renderer, assembler }), assetBase);
}

/**
 * Starts portraits now, with what they draw with arriving later (main.ts: the 3D view's chunk, audit 28 Oct):
 * pictures already on this device show at once, and the first one to render waits for `gl`. A `gl` that
 * fails (the chunk didn't come) gives the silhouette, and the next render asks again.
 */
export function installPortraitsFrom(gl: () => PortraitGl | Promise<PortraitGl>, assetBase = `${import.meta.env.BASE_URL}assets/`): void {
  let made: Promise<PortraitRenderer> | null = null;
  const lazy: PortraitBackend = {
    render: async (look, pose, w, h) => {
      if (!made) {
        const making = Promise.all([import('./render'), gl()]).then(([{ PortraitRenderer }, g]) => new PortraitRenderer(g.renderer, g.assembler));
        made = making;
        making.catch(() => {
          if (made === making) made = null;
        });
      }
      return (await made).render(look, pose, w, h);
    },
  };
  portraits.install(lazy, artVersion(assetBase));
}
