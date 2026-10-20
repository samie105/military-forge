/**
 * The tuning panel for a room's host: the owner tunes the game while playing with friends
 * (pnpm playtest --tune). "Tune the game" in the in-match menu opens it: round two's panel
 * (shell/screens/Tune.tsx), docked at the right edge over the game and the lobby; it steps aside
 * while a menu is open (setCovered). Edits apply at once: in training to the local match, online to
 * the whole room (SetTuning; the server holds the host to the panel's keys and ranges and sends
 * TUNING to everyone else), so every client's prediction stays in step. "Copy values" copies what
 * differs from the defaults as JSON, ready to become the new defaults. "All values" opens the full
 * dev panel (tweakpane, every key), loaded on first use.
 */
import type { Tuning } from '@military-forge/content';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { typingInto } from './input';
import type { LocalMode } from './localMode';
import { OnlineMode } from './onlineMode';
import { TunePanel, type FullPanel } from './shell/screens/Tune';

/** Does this page offer the host's panel? The playtest's --tune flags the page (proxy.ts TUNE_META); dev builds always do. */
export function tuningOffered(doc: Document = document, dev = import.meta.env.DEV): boolean {
  return dev || doc.querySelector('meta[name="mf-tune"][content="host"]') !== null;
}

/** Copies `text`, or returns false where the browser won't (an http page on the LAN: no clipboard API). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface HostTuning {
  /** shows the panel for the game mode running now (nothing without one) */
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** a menu (the in-match menu, Settings) is open: the panel hides under it */
  setCovered(covered: boolean): void;
  /** called when the panel closes itself (its Close button) */
  onClose: () => void;
}

/** How long after the last edit a room hears it (a dragged slider sends its value, not every step). */
const SEND_MS = 120;

export function createHostTuning(getMode: () => LocalMode | OnlineMode | null, parent: HTMLElement = document.body): HostTuning {
  let root: HTMLElement | null = null;
  let react: Root | null = null;
  let mode: LocalMode | OnlineMode | null = null;
  let covered = false;
  let sendTimer = 0;
  /** the edit a room hasn't heard yet (sent when the pause ends, or as the panel closes) */
  let pending: (() => void) | null = null;

  const api: HostTuning = {
    onClose: () => {},
    get isOpen() {
      return root !== null;
    },
    setCovered(on) {
      covered = on;
      if (root) root.style.display = on ? 'none' : '';
    },
    open() {
      const target = getMode();
      if (!target) return;
      if (root && mode === target) return;
      close();
      mode = target;
      const online = target instanceof OnlineMode;
      root = document.createElement('div');
      root.className = 'mf mf-tune-root';
      if (covered) root.style.display = 'none';
      parent.appendChild(root);
      // the panel never keeps the game's keys: after a slider or a button it lets go of the keyboard
      // (a focused slider steps with the arrows: playing on with ← → would retune the room), and a
      // value typed into a field lets go on Enter
      const here = root;
      const letGo = () => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && here.contains(el) && !typingInto(el)) el.blur();
      };
      root.addEventListener('pointerup', () => window.setTimeout(letGo, 0));
      root.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === 'Escape') && e.target instanceof HTMLElement && typingInto(e.target)) e.target.blur();
      });

      // training takes a change at once; a room hears the last one after a short pause
      const setTuning = (t: Tuning) => {
        if (!(target instanceof OnlineMode)) {
          target.setTuning(t);
          return;
        }
        Object.assign(target.tuning(), t); // our prediction straight away
        window.clearTimeout(sendTimer);
        pending = () => target.setTuning({ ...t });
        sendTimer = window.setTimeout(flush, SEND_MS);
      };
      const subscribe = (fn: () => void) => (target instanceof OnlineMode ? target.onTuning(() => fn()) : () => {});
      const openAll = (el: HTMLElement, onChange: () => void): FullPanel => {
        let panel: { pane: { dispose(): void }; refresh(): void; values(): Tuning } | null = null;
        let gone = false;
        void import('./tuningPanel').then(({ createTuningPanel }) => {
          if (gone) return;
          panel = createTuningPanel(
            el,
            null,
            {
              getTuning: () => target.tuning(),
              onTuningChanged: (t) => {
                setTuning(t);
                onChange();
              },
            },
            { title: null, expanded: [], labels: true },
          );
        });
        return {
          refresh: () => panel?.refresh(),
          values: () => panel?.values() ?? target.tuning(),
          dispose: () => {
            gone = true;
            panel?.pane.dispose();
          },
        };
      };
      react = createRoot(root);
      react.render(
        createElement(TunePanel, {
          online,
          getTuning: () => target.tuning(),
          setTuning,
          subscribe,
          onClose: () => {
            close();
            api.onClose();
          },
          copy: copyText,
          openAll,
          // a room's bots (v17): what MATCH_STATE says, set with the host's MatchSettings
          ...(target instanceof OnlineMode
            ? {
                room: {
                  get: () => ({ bots: target.matchState?.rules.bots ?? 0, level: target.matchState?.rules.botLevel ?? 'normal' }),
                  set: (change: { bots?: number; botLevel?: 'easy' | 'normal' | 'hard' }) => target.setMatchSettings(change),
                },
              }
            : {}),
        }),
      );
    },
    close,
  };

  function flush(): void {
    window.clearTimeout(sendTimer);
    const send = pending;
    pending = null;
    send?.();
  }

  function close(): void {
    flush();
    mode = null;
    const r = react;
    react = null;
    // React lets go of the tree after the current render
    if (r) queueMicrotask(() => r.unmount());
    root?.remove();
    root = null;
  }

  return api;
}
