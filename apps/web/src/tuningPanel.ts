/**
 * Live tuning panel (docs/02 §19.2). In local mode it edits the running sim's tuning object
 * directly; online it sends a dev SetTuning command to the room.
 */
import { defaultTuning, weapons, type Tuning } from '@military-forge/content';
import { NET_PRESETS, copySettings, type ConditionerSettings, type LinkSettings } from '@military-forge/netcode';
import { Pane, type FolderApi } from 'tweakpane';
import type { RenderOptions } from './render';

type NumericKey = { [K in keyof Tuning]: Tuning[K] extends number ? K : never }[keyof Tuning];

interface Field {
  key: NumericKey;
  min: number;
  max: number;
  step: number;
}

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Ground',
    fields: [
      { key: 'walkMax', min: 1, max: 12, step: 0.1 },
      { key: 'crouchMax', min: 0.5, max: 6, step: 0.1 },
      { key: 'groundAccel', min: 5, max: 150, step: 1 },
      { key: 'groundDecel', min: 5, max: 150, step: 1 },
      { key: 'groundReverse', min: 5, max: 200, step: 1 },
    ],
  },
  {
    title: 'Air & gravity',
    fields: [
      { key: 'gravity', min: 2, max: 40, step: 0.5 },
      { key: 'terminalVy', min: -40, max: -4, step: 0.5 },
      { key: 'airAccel', min: 0, max: 80, step: 1 },
      { key: 'airMaxX', min: 1, max: 15, step: 0.1 },
      { key: 'airDragX', min: 0, max: 10, step: 0.1 },
      { key: 'launchSpeedX', min: 6, max: 30, step: 0.5 },
      { key: 'launchDragX', min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    title: 'Jetpack',
    fields: [
      { key: 'jetThrust', min: 10, max: 80, step: 0.5 },
      { key: 'jetKick', min: 1, max: 3, step: 0.05 },
      { key: 'jetKickTicks', min: 0, max: 30, step: 1 },
      { key: 'jetMaxVy', min: 2, max: 15, step: 0.1 },
      { key: 'jetTaperBand', min: 0.1, max: 5, step: 0.1 },
      { key: 'jetAirMaxX', min: 1, max: 15, step: 0.1 },
    ],
  },
  {
    title: 'Fuel',
    fields: [
      { key: 'fuelMax', min: 10, max: 300, step: 1 },
      { key: 'fuelBurn', min: 5, max: 120, step: 1 },
      { key: 'fuelMinIgnite', min: 0, max: 50, step: 1 },
      { key: 'fuelRegenGround', min: 0, max: 150, step: 1 },
      { key: 'fuelRegenDelayGround', min: 0, max: 2, step: 0.05 },
      { key: 'fuelRegenAir', min: 0, max: 80, step: 1 },
      { key: 'fuelRegenDelayAir', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    title: 'Collision feel',
    fields: [
      { key: 'maxWalkSlopeDeg', min: 20, max: 70, step: 1 },
      { key: 'stepHeight', min: 0, max: 0.5, step: 0.01 },
      { key: 'groundSnap', min: 0, max: 0.4, step: 0.01 },
      { key: 'ceilingBonkVxMul', min: 0, max: 1, step: 0.05 },
      { key: 'cornerCorrection', min: 0, max: 0.3, step: 0.01 },
      { key: 'knockbackCap', min: 2, max: 40, step: 0.5 },
    ],
  },
  {
    title: 'Health',
    fields: [
      { key: 'healthRegen', min: 0, max: 30, step: 0.5 },
      { key: 'healthRegenDelay', min: 0, max: 10, step: 0.1 },
      { key: 'respawnDelay', min: 0, max: 10, step: 0.1 },
    ],
  },
];

export interface PanelActions {
  getTuning(): Tuning;
  /** called after any edit (online mode forwards it to the server) */
  onTuningChanged(t: Tuning): void;
  respawn(): void;
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

export function createTuningPanel(container: HTMLElement, options: RenderOptions, actions: PanelActions): { pane: Pane; refresh(): void } {
  const pane = new Pane({ container, title: 'Live tuning (docs/02 §8)' });
  // Bind to a working copy, then write through, so online mode can forward changes.
  const working: Tuning = { ...actions.getTuning() };
  let debounce = 0;
  const commit = () => {
    const live = actions.getTuning();
    Object.assign(live, working);
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => actions.onTuningChanged({ ...working }), 120);
  };

  for (const group of GROUPS) {
    const folder = pane.addFolder({ title: group.title, expanded: group.title === 'Jetpack' || group.title === 'Ground' });
    for (const f of group.fields) folder.addBinding(working, f.key, { min: f.min, max: f.max, step: f.step }).on('change', commit);
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

  const view = pane.addFolder({ title: 'Debug view' });
  view.addBinding(options, 'showHitboxes', { label: 'hitboxes (H)' });
  view.addBinding(options, 'showGrid', { label: 'grid (B)' });
  view.addBinding(options, 'showNet', { label: 'net graph (N)' });

  const tools = pane.addFolder({ title: 'Tools' });
  tools.addButton({ title: 'Reset tuning to defaults' }).on('click', () => {
    Object.assign(working, defaultTuning);
    pane.refresh();
    commit();
  });
  tools.addButton({ title: 'Copy tuning JSON' }).on('click', () => {
    const diff: Partial<Tuning> = {};
    for (const k of Object.keys(defaultTuning) as (keyof Tuning)[]) if (working[k] !== defaultTuning[k]) diff[k] = working[k];
    void navigator.clipboard.writeText(JSON.stringify(diff, null, 2));
  });
  tools.addButton({ title: 'Respawn me (K)' }).on('click', () => actions.respawn());
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
  };
}
