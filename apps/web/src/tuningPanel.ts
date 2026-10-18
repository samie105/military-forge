/**
 * Live tuning panel (docs/02 §19.2). In local mode it edits the running sim's tuning object
 * directly; online it sends a SetTuning command to the room (dev rooms, or a playtest room's host:
 * hostTuning.ts). The values and their ranges are content's TUNING_GROUPS, which the game server
 * holds a host to.
 */
import { TUNING_GROUPS, changedTuning, defaultTuning, weapons, type Tuning } from '@military-forge/content';
import { NET_PRESETS, copySettings, type ConditionerSettings, type LinkSettings } from '@military-forge/netcode';
import { Pane, type FolderApi } from 'tweakpane';
import type { RenderOptions } from './render';

export interface PanelActions {
  getTuning(): Tuning;
  /** called after any edit (online mode forwards it to the server) */
  onTuningChanged(t: Tuning): void;
  /** dev: respawn in place (the host's panel has none) */
  respawn?(): void;
  toggleRecording?(): boolean;
  downloadReplay?(): void;
  /** online mode: the network conditioner's live settings (docs/05 §15.2) */
  netSim?: ConditionerSettings;
  /** local mode, dev give-weapon: the current [slot 1, slot 2] weapon indices and a setter */
  loadout?: [number, number];
  setLoadout?(loadout: [number, number]): void;
  /** online mode: low-bandwidth mode (docs/05 §2.2) */
  lowBandwidth?: { get(): boolean; set(on: boolean): void };
}

function addLinkBindings(folder: FolderApi, link: LinkSettings, label: string): void {
  folder.addBinding(link, 'latencyMs', { label: `${label} latency ms`, min: 0, max: 500, step: 1 });
  folder.addBinding(link, 'jitterMs', { label: `${label} jitter ±ms`, min: 0, max: 100, step: 1 });
  folder.addBinding(link, 'lossPct', { label: `${label} loss %`, min: 0, max: 30, step: 0.5 });
  folder.addBinding(link, 'dupPct', { label: `${label} dup %`, min: 0, max: 20, step: 0.5 });
  folder.addBinding(link, 'reorder', { label: `${label} reorder` });
  // set from the transport on connect (WebSocket = TCP), editable to compare
  link.stream ??= false;
  folder.addBinding(link as Required<LinkSettings>, 'stream', { label: `${label} TCP stalls` });
}

/** The tuning as JSON: only what differs from the defaults ("Copy values"). */
export function tuningValuesJson(t: Tuning): string {
  return JSON.stringify(changedTuning(t), null, 2);
}

/**
 * The panel in `container`. `options` adds the dev client's debug view toggles (null: the host's
 * panel, tuning only); `expanded` names the groups that start open; `labels` shows each value's
 * words (the host's panel) instead of its tuning key (the dev panel); `title` null: no title bar.
 */
export function createTuningPanel(
  container: HTMLElement,
  options: RenderOptions | null,
  actions: PanelActions,
  { title = 'Live tuning (docs/02 §8)', expanded = ['Jetpack', 'Ground'], labels = false }: { title?: string | null; expanded?: readonly string[]; labels?: boolean } = {},
): { pane: Pane; refresh(): void; values(): Tuning } {
  const pane = new Pane(title ? { container, title } : { container });
  // Bind to a working copy, then write through, so online mode can forward changes.
  const working: Tuning = { ...actions.getTuning() };
  let debounce = 0;
  const commit = () => {
    const live = actions.getTuning();
    Object.assign(live, working);
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => actions.onTuningChanged({ ...working }), 120);
  };

  for (const group of TUNING_GROUPS) {
    const folder = pane.addFolder({ title: group.title, expanded: expanded.includes(group.title) });
    for (const f of group.fields) folder.addBinding(working, f.key, { ...(labels ? { label: f.label } : {}), min: f.min, max: f.max, step: f.step }).on('change', commit);
  }

  if (actions.lowBandwidth) {
    const lb = actions.lowBandwidth;
    const state = { lowBandwidth: lb.get() };
    pane
      .addFolder({ title: 'Network', expanded: state.lowBandwidth })
      .addBinding(state, 'lowBandwidth', { label: 'low-bandwidth mode' })
      .on('change', (ev) => lb.set(ev.value));
  }

  if (actions.netSim) {
    const sim = actions.netSim;
    const net = pane.addFolder({ title: 'Network conditioner', expanded: sim.enabled });
    const state = { preset: 'custom' };
    const presets: Record<string, string> = { custom: 'custom' };
    for (const name of Object.keys(NET_PRESETS)) presets[name] = name;
    net.addBinding(state, 'preset', { options: presets }).on('change', (ev) => {
      const preset = NET_PRESETS[ev.value];
      if (!preset) return;
      copySettings(sim, preset);
      pane.refresh();
    });
    net.addBinding(sim, 'enabled', { label: 'enabled' });
    addLinkBindings(net, sim.up, 'up');
    addLinkBindings(net, sim.down, 'down');
  }

  if (actions.loadout && actions.setLoadout) {
    // dev give-weapon until map spawners land (docs/03 §12): full ammo now and on every respawn
    const options: Record<string, number> = {};
    for (const w of weapons) options[w.name] = w.index;
    const state = { slot1: actions.loadout[0], slot2: actions.loadout[1] };
    const give = pane.addFolder({ title: 'Give weapon (dev)', expanded: false });
    const apply = () => actions.setLoadout!([state.slot1, state.slot2]);
    give.addBinding(state, 'slot1', { label: 'slot 1', options }).on('change', apply);
    give.addBinding(state, 'slot2', { label: 'slot 2', options }).on('change', apply);
  }

  if (options) {
    const view = pane.addFolder({ title: 'Debug view' });
    view.addBinding(options, 'showHitboxes', { label: 'hitboxes (H)' });
    view.addBinding(options, 'showGrid', { label: 'grid (B)' });
    view.addBinding(options, 'showNet', { label: 'net graph (N)' });
  }

  const tools = pane.addFolder({ title: 'Tools' });
  tools.addButton({ title: 'Reset tuning to defaults' }).on('click', () => {
    Object.assign(working, defaultTuning);
    pane.refresh();
    commit();
  });
  if (options) tools.addButton({ title: 'Copy values (JSON)' }).on('click', () => void navigator.clipboard.writeText(tuningValuesJson(working)));
  if (actions.respawn) tools.addButton({ title: 'Respawn me (K)' }).on('click', () => actions.respawn!());
  if (actions.toggleRecording) {
    const rec = tools.addButton({ title: 'Start recording replay (P)' });
    rec.on('click', () => {
      const on = actions.toggleRecording!();
      rec.title = on ? 'Stop recording (P)' : 'Start recording replay (P)';
    });
  }
  if (actions.downloadReplay) tools.addButton({ title: 'Download last replay (O)' }).on('click', () => actions.downloadReplay!());

  return {
    pane,
    refresh() {
      Object.assign(working, actions.getTuning());
      pane.refresh();
    },
    values: () => ({ ...working }),
  };
}
