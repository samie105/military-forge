/**
 * The game's sound, put together (loaded lazily, after the first tap or key): the engine, the
 * director (game events and frames), the music bed and the interface sounds, following the
 * player's settings and the shell's state.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { AudioSettings, ShellState } from '../shell/store';
import type { Frame } from '../view';
import type { MapDef } from '@military-forge/content';
import { Acoustics } from './acoustics';
import { AudioDirector, type AudioEvent, type FrameExtras } from './director';
import { AudioEngine, type Volumes } from './engine';
import { weaponSoundIds } from './families';
import { MusicBed } from './music';
import { SOUNDS, type SoundId } from './sounds';
import { mountUiSounds, musicFor, shellCues } from './ui';

/** Settings → Audio's volumes and mutes as the engine's bus volumes. */
export function volumesFrom(a: AudioSettings): Volumes {
  const v = (on: number, muted: boolean) => (muted ? 0 : on);
  return {
    master: v(a.master, a.masterMuted),
    sfx: v(a.effects, a.effectsMuted),
    music: v(a.music, a.musicMuted),
    ui: v(a.ui, a.uiMuted),
    voice: v(a.voice, a.voiceMuted),
  };
}

/** Sounds worth rendering before they're first needed: the common ones. */
const WARM: readonly SoundId[] = [
  'ui.click',
  'ui.hover',
  'ui.toast',
  'ui.count',
  'ui.go',
  'ui.flood',
  'sting.start',
  'music.drum',
  'music.snare',
  'music.tick',
  'music.hit',
  'step',
  'land',
  'jet.start',
  'jet.loop',
  'jet.stop',
  'dash',
  'pistol.fire',
  'smg.fire',
  'rifle.fire',
  'brass.tinkle',
  'hit.marker',
  'hit.taken',
  'impact.wall',
  'grenade.throw',
  'frag.explode',
  'kill.confirm',
];

export class AudioRuntime {
  readonly engine: AudioEngine;
  readonly director: AudioDirector;
  readonly music: MusicBed;
  private settings: AudioSettings | null = null;
  private lastShell: ShellState | null = null;
  private inGame = false;
  private previewAt = 0;
  private map: MapDef | null = null;
  private acoustics: Acoustics | null = null;
  private enclosureAt = 0;
  /** the guns in the local player's hands last warmed (their defs) */
  private armed = '';
  private readonly cleanups: (() => void)[] = [];

  constructor(ctx: AudioContext, store: StoreApi<ShellState> | null) {
    this.engine = new AudioEngine(ctx);
    this.director = new AudioDirector(this.engine);
    this.music = new MusicBed(this.engine);
    this.engine.warm(WARM);
    this.cleanups.push(mountUiSounds((id) => this.engine.play(id)));
    const onVisibility = () => this.engine.setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', () => this.engine.setHidden(true));
    window.addEventListener('pageshow', () => this.engine.setHidden(document.hidden));
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    onVisibility();
    if (store) {
      this.lastShell = store.getState();
      this.cleanups.push(
        store.subscribe((s) => {
          for (const id of shellCues(this.lastShell, s)) this.engine.play(id);
          this.lastShell = s;
          this.music.setMode(musicFor(this.inGame, s));
        }),
      );
      this.music.setMode(musicFor(false, this.lastShell));
      // the title's press is the gesture that made this context: its hit, if it was just now
      const hit = this.lastShell.titleHit;
      if (hit && performance.now() - hit < 1500) this.engine.play('sting.start');
    }
  }

  applySettings(a: AudioSettings, softBursts: boolean): void {
    const before = this.settings;
    this.settings = { ...a };
    this.engine.setVolumes(volumesFrom(a));
    this.engine.setSoft(softBursts);
    this.engine.setHrtf(a.headphones);
    if (!before) return;
    // a volume moved: a short sample of what it sets, so the player hears the level
    const now = performance.now();
    if (now - this.previewAt < 160) return;
    const preview: [keyof AudioSettings, SoundId][] = [
      ['effects', 'pickup.grenades'],
      ['ui', 'ui.click'],
      ['voice', 'voice.hurt'],
      ['master', 'ui.toast'],
    ];
    for (const [k, id] of preview)
      if (before[k] !== a[k]) {
        this.previewAt = now;
        this.engine.play(id);
        break;
      }
  }

  onEvents(events: readonly AudioEvent[], localId: number): void {
    if (this.engine.isHidden) return;
    this.director.onEvents(events, localId);
  }

  onFrame(frame: Frame | null, dt: number, extras: FrameExtras | null): void {
    // sounds asked for before the context ran play now, if it does
    if (this.engine.waiting) this.engine.wake();
    const inGame = frame !== null;
    if (inGame !== this.inGame) {
      this.inGame = inGame;
      if (!inGame) {
        this.director.reset();
        this.engine.occluder = null;
        this.engine.setEnclosure(0);
        this.map = null;
        this.acoustics = null;
      }
      if (this.lastShell) this.music.setMode(musicFor(inGame, this.lastShell));
    }
    if (frame && extras && !this.engine.isHidden) {
      this.warmHands(frame);
      this.director.onFrame(frame, dt, extras);
      this.listen(extras.map ?? null);
    }
  }

  /**
   * The guns in your hands: their shots, reload steps, draw and empty click rendered ahead, in idle
   * time, so the first reload of a gun (the steps start the frame it begins) has its takes ready.
   */
  private warmHands(frame: Frame): void {
    const me = frame.players.find((p) => p.id === frame.localId);
    if (!me) return;
    let key = '';
    for (const w of me.weapons) key += `${w.def},`;
    if (key === this.armed) return;
    this.armed = key;
    for (const w of me.weapons) {
      const ws = this.director.soundsFor(me.id, w.def);
      if (ws) this.engine.warm(weaponSoundIds(ws));
    }
  }

  /** The map's acoustics: walls between you and each sound, and the space you're standing in. */
  private listen(map: MapDef | null): void {
    const e = this.engine;
    if (map !== this.map) {
      this.map = map;
      try {
        this.acoustics = map ? Acoustics.forMap(map) : null;
      } catch {
        this.acoustics = null;
      }
      const a = this.acoustics;
      e.occluder = a ? (x, y) => (e.listener ? a.occlusion(e.listener.x, e.listener.y, x, y, e.now) : 0) : null;
    }
    const l = e.listener;
    if (this.acoustics && l && e.now - this.enclosureAt > 0.3) {
      this.enclosureAt = e.now;
      e.setEnclosure(this.acoustics.enclosure(l.x, l.y));
    }
  }

  reset(): void {
    this.director.reset();
    this.engine.stopAll(0.1);
  }

  /** Plays one sound by id (the board, the Locker's inspect chime, and console poking). */
  play(id: string): void {
    if (id in SOUNDS) this.engine.play(id as SoundId);
  }

  /** Plays a world sound by id at (x, y) (a kill effect's sound, where the victim fell). */
  playAt(id: string, x: number, y: number): void {
    if (id in SOUNDS && !this.engine.isHidden) this.engine.play(id as SoundId, { x, y });
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.music.dispose();
    this.engine.stopAll(0.05);
  }
}
