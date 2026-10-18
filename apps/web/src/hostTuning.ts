/**
 * The tuning panel for a room's host: the owner tunes the game while playing with friends
 * (pnpm playtest --tune). "Tune the game" in the in-match menu opens it, docked right over the game
 * and the lobby; it steps aside while a menu is open (setCovered). Edits apply at once: in training to the local match, online to the whole
 * room (SetTuning; the server holds the host to the panel's keys and ranges and sends TUNING to
 * everyone else), so every client's prediction stays in step. "Copy values" copies what differs from
 * the defaults as JSON, ready to become the new defaults. The panel (tweakpane) loads on first use.
 */
import type { Tuning } from '@military-forge/content';
import type { LocalMode } from './localMode';
import { OnlineMode } from './onlineMode';

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

const icon = (name: string) => `<svg class="ic" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

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

export function createHostTuning(getMode: () => LocalMode | OnlineMode | null, parent: HTMLElement = document.body): HostTuning {
  let root: HTMLElement | null = null;
  let mode: LocalMode | OnlineMode | null = null;
  let covered = false;
  /** bumps on every open/close: a slow panel import never lands in a closed or newer one */
  let generation = 0;

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
      const gen = ++generation;
      mode = target;
      const online = target instanceof OnlineMode;
      root = document.createElement('div');
      root.className = 'mf mf-tune-root kit-v1';
      root.innerHTML = `
        <aside class="mf-tune panel" aria-label="Tune the game">
          <header class="mf-tune__head">
            <div>
              <p class="eyebrow">${icon('ev-gravity')} Host · live</p>
              <h2 class="h3">Tune the game</h2>
            </div>
            <button type="button" class="iconbtn" data-act="close" aria-label="Close the tuning panel">${icon('close')}</button>
          </header>
          <p class="mf-tune__note muted">${online ? 'Changes apply at once to everyone in this room.' : 'Changes apply at once to this training match.'}</p>
          <div class="mf-tune__pane"></div>
          <footer class="mf-tune__foot">
            <button type="button" class="btn btn--primary" data-act="copy">${icon('copy')} Copy values</button>
            <span class="mf-tune__status small" role="status"></span>
          </footer>
          <textarea class="mf-tune__out" readonly hidden aria-label="The changed values as JSON"></textarea>
        </aside>`;
      if (covered) root.style.display = 'none';
      parent.appendChild(root);
      const status = root.querySelector<HTMLElement>('.mf-tune__status')!;
      const out = root.querySelector<HTMLTextAreaElement>('.mf-tune__out')!;
      root.querySelector('[data-act="close"]')!.addEventListener('click', () => {
        close();
        api.onClose();
      });

      let panel: { refresh(): void; values(): Tuning } | null = null;
      root.querySelector('[data-act="copy"]')!.addEventListener('click', () => {
        if (!panel) return;
        void (async () => {
          const { tuningValuesJson } = await import('./tuningPanel');
          const json = tuningValuesJson(panel!.values());
          const changed = Object.keys(JSON.parse(json) as object).length;
          const what = changed === 0 ? 'Nothing changed yet (the defaults)' : `${changed} changed ${changed === 1 ? 'value' : 'values'}`;
          if (await copyText(json)) {
            out.hidden = true;
            status.textContent = `Copied: ${what}`;
          } else {
            // no clipboard here: show them, selected, for the keyboard's copy
            out.value = json;
            out.hidden = false;
            out.focus();
            out.select();
            status.textContent = `${what}: press Ctrl+C (⌘C on a Mac)`;
          }
        })();
      });

      void import('./tuningPanel').then(({ createTuningPanel }) => {
        if (gen !== generation || !root) return;
        panel = createTuningPanel(
          root.querySelector<HTMLElement>('.mf-tune__pane')!,
          null,
          {
            getTuning: () => target.tuning(),
            onTuningChanged: (t) => {
              if (target instanceof OnlineMode) target.setTuning(t);
            },
          },
          { title: null, expanded: ['Jetpack', 'Fuel'], labels: true },
        );
        // another host's edit, or the server putting ours back: show the room's values
        if (target instanceof OnlineMode) target.onTuningFromServer = () => panel?.refresh();
      });
    },
    close,
  };

  function close(): void {
    generation++;
    if (mode instanceof OnlineMode) mode.onTuningFromServer = () => {};
    mode = null;
    root?.remove();
    root = null;
  }

  return api;
}
