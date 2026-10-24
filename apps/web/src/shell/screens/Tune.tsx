/**
 * Tune the game (round two's data-screen="tune"): the host's panel docked at the right edge, never
 * over the centre. Presets (Classic, Floaty, Chaos; Custom once anything else moves), the kit's rows
 * on the real tuning keys with content's own ranges and steps, each with its default marked, Reset,
 * and Copy values (the JSON of what differs). "All values" opens the full dev panel (every key)
 * under the rows. Motion (ui-motion-spec.md §4.1): the panel slides in from the right edge (P9), the
 * rows rise in turn (P3), a changed value rolls (P4); everyone in the room sees "Tuned by host" (P7,
 * the HUD) and a guest gets TuneToast, below.
 */
import { changedTuning, defaultTuning, type Tuning } from '@military-forge/content';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/Icon';
import { Screen, blurAfter } from '../../ui/Screen';
import { Slider } from '../../ui/Slider';
import { useTicker } from '../context';
import { BotSettings, type BotLevel } from '../roomBots';
import type { TuneNote } from '../store';
import { useRoomSetting } from './Lobby';
import { PRESET_NAMES, TUNE_ROWS, formatTune, presetOf, presetTuning, rowChanged, tuneNumber, type PresetId, type TuneRow } from '../tune';
import { RollNum } from './frame';

export interface TunePanelProps {
  /** online: a room (the changes go to everyone); otherwise this training match */
  online: boolean;
  getTuning(): Tuning;
  setTuning(t: Tuning): void;
  /** hears the tuning change from elsewhere (the server putting a value back); returns the way to stop */
  subscribe(fn: () => void): () => void;
  onClose(): void;
  copy(text: string): Promise<boolean>;
  /** a room's bots (v17), the host's: read live (the room answers), set at once; absent in training */
  room?: { get(): { bots: number; level: BotLevel }; set(change: { bots?: number; botLevel?: BotLevel }): void };
  /** mounts the full dev panel (every key) in `el`, calling `onChange` after its edits */
  openAll?(el: HTMLElement, onChange: () => void): FullPanel;
}

/** The full dev panel under "All values": shows the tuning again after an edit here, and goes away. */
export interface FullPanel {
  refresh(): void;
  values(): Tuning;
  dispose(): void;
}

const same = (a: Tuning, b: Tuning) => JSON.stringify(a) === JSON.stringify(b);

/** How long Copy values says "Copied" (as the lobby's Copy link). */
const COPIED_MS = 1600;

export function TunePanel({ online, getTuning, setTuning, subscribe, onClose, copy, openAll, room }: TunePanelProps) {
  const [t, setT] = useState<Tuning>(() => ({ ...getTuning() }));
  const [copied, setCopied] = useState<'no' | 'yes' | 'shown'>('no');
  const [json, setJson] = useState('');
  const [all, setAll] = useState(false);
  const allEl = useRef<HTMLDivElement>(null);
  const full = useRef<FullPanel | null>(null);
  // what the panel shows follows the room's tuning (the server putting a value back, the full panel)
  const follow = () => setT((was) => (same(was, getTuning()) ? was : { ...getTuning() }));
  useEffect(() => subscribe(follow), [subscribe]);
  useLayoutEffect(() => {
    if (!all || !allEl.current || !openAll) return undefined;
    const panel = openAll(allEl.current, follow);
    full.current = panel;
    return () => {
      full.current = null;
      panel.dispose();
    };
  }, [all, openAll]);
  useEffect(() => {
    if (full.current && !same(full.current.values(), t)) full.current.refresh();
  }, [t]);

  const apply = (next: Tuning) => {
    setT(next);
    setTuning(next);
  };
  const preset = presetOf(t);
  const pick = (id: PresetId) => apply(presetTuning(id));
  const doCopy = async () => {
    const text = JSON.stringify(changedTuning(t), null, 2);
    if (await copy(text)) {
      setCopied('yes');
      window.setTimeout(() => setCopied('no'), COPIED_MS);
    } else {
      setJson(text);
      setCopied('shown');
    }
  };
  const changed = Object.keys(changedTuning(t)).length;

  return (
    <Screen name="tune" kind="game" states={[online ? 'host-open' : 'training-open', preset, copied === 'yes' ? 'copied' : 'idle']} label="Tune the game">
      <aside className="tune m-p9 m-p9--right" aria-labelledby="tune-t">
        <header className="tune__head">
          <div>
            {online && (
              <span className="tag tag--host">
                <Icon name="crown" />
                Host
              </span>
            )}
            <h2 id="tune-t" className="display tune__title">
              Tune the game
            </h2>
            <p className="tune__sub">
              <span className="dot"></span>
              {online ? 'Live for everyone in the room' : 'Live in this training match'}
            </p>
          </div>
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Close" onClick={blurAfter(onClose)}>
            <Icon name="close" />
          </button>
        </header>
        {room && <RoomBots room={room} />}
        <div className="tune__presets">
          <span className="label" id="tune-presets">
            Presets
          </span>
          <div className="seg seg--block" role="radiogroup" aria-labelledby="tune-presets">
            {(['classic', 'floaty', 'chaos', 'custom'] as const).map((id) => (
              <button
                key={id}
                className="seg__opt m-p8"
                type="button"
                role="radio"
                data-tab={id}
                aria-checked={preset === id}
                disabled={id === 'custom'}
                onClick={id === 'custom' ? undefined : blurAfter(() => pick(id))}
              >
                {PRESET_NAMES[id]}
              </button>
            ))}
          </div>
        </div>
        <ol className="tune__list">
          {TUNE_ROWS.map((row, i) => (
            <TuneRowView key={row.id} row={row} t={t} i={i} onChange={(shown) => apply(row.apply(t, shown))} />
          ))}
          {openAll && (
            <li className="mf-tune__all">
              <button className="btn btn--ghost btn--sm m-p8" type="button" aria-expanded={all} onClick={blurAfter(() => setAll((a) => !a))}>
                <Icon name="sliders" />
                {all ? 'Fewer values' : 'All values'}
              </button>
              {all && <div ref={allEl} className="mf-tune__pane"></div>}
            </li>
          )}
        </ol>
        <footer className="tune__foot">
          <button className="btn btn--ghost btn--sm m-p8" type="button" disabled={changed === 0} onClick={blurAfter(() => apply({ ...defaultTuning }))}>
            <Icon name="refresh" />
            Reset
          </button>
          {copied === 'yes' ? (
            <button className="btn btn--paper btn--sm tune__copied mf-swap-in" type="button" key="copied" onClick={blurAfter(() => void doCopy())}>
              <Icon name="check" />
              Copied · paste anywhere
            </button>
          ) : (
            <button className="btn btn--paper btn--sm m-p8 mf-swap-in" type="button" key="copy" onClick={blurAfter(() => void doCopy())}>
              <Icon name="copy" />
              Copy values
            </button>
          )}
          {copied === 'shown' && (
            <label className="mf-tune__out">
              <span>{changed === 0 ? 'Nothing changed yet (the defaults)' : 'No clipboard here: press Ctrl+C (⌘C on a Mac)'}</span>
              <textarea readOnly value={json} rows={4} ref={(el) => el?.select()} aria-label="The changed values, as text" />
            </label>
          )}
        </footer>
      </aside>
    </Screen>
  );
}

function TuneRowView({ row, t, i, onChange }: { row: TuneRow; t: Tuning; i: number; onChange(shown: number): void }) {
  const min = row.min(t);
  const max = row.max(t);
  const shown = row.show(t);
  const span = max - min || 1;
  const def = row.show({ ...t, [row.key]: defaultTuning[row.key] });
  const isChanged = rowChanged(row, t);
  const text = formatTune(row, t);
  return (
    <li className={isChanged ? 'trow is-changed m-p3' : 'trow m-p3'} style={{ '--i': i } as CSSProperties} data-bind={`tuning.${row.id}`}>
      <div className="trow__top">
        <b>{row.label}</b>
        {isChanged && <span className="trow__dot" title="Changed"></span>}
        <span className="trow__def">
          default <b>{tuneNumber(row, t, def)}</b>
        </span>
        <b className="trow__val">
          <RollNum value={text} />
        </b>
      </div>
      <div className="trow__sl">
        <span className="num">{tuneNumber(row, t, min)}</span>
        <Slider
          value={(shown - min) / span}
          def={(def - min) / span}
          onChange={(v) => onChange(min + v * span)}
          label={row.label}
          valueText={text}
          step={row.step(t) / span}
          min={min}
          max={max}
          now={shown}
        />
        <span className="num">{tuneNumber(row, t, max)}</span>
      </div>
    </li>
  );
}

/** How long a guest's toast stays up, and its exit (P9 leaving). */
const TOAST_MS = 3200;
const TOAST_LEAVE_MS = 170;
/** the last note shown (a screen remounting doesn't show it twice) */
let lastNote = 0;

/**
 * A guest's word that the host just retuned the room (the kit's toast under the clock): "Ade changed
 * Gravity to 12 m/s² · Dash chain window to 0.6 s". It comes in from the top (P9) and leaves after 3.2 s;
 * "Tuned by host" stays on the HUD.
 */
export function TuneToast({ note }: { note: TuneNote | null }) {
  const [shown, setShown] = useState<TuneNote | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!note || note.id === lastNote) return undefined;
    lastNote = note.id;
    setShown(note);
    setLeaving(false);
    const a = window.setTimeout(() => setLeaving(true), TOAST_MS);
    const b = window.setTimeout(() => setShown(null), TOAST_MS + TOAST_LEAVE_MS);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [note]);
  if (!shown) return null;
  return (
    <Screen name="tune-toast" kind="game" states={[leaving ? 'leaving' : 'guest-view']} label="The host retuned the room">
      <div className={leaving ? 'toast plate m-p9 is-leaving' : 'toast plate m-p9'} role="status">
        <Icon name="sliders" size="sm" />
        <span>
          <b>{shown.who}</b> changed{' '}
          {shown.items.map((it, i) => (
            <Fragment key={it.label}>
              {i > 0 && ' · '}
              <b>{it.label}</b> to {it.value}
            </Fragment>
          ))}
          {shown.more > 0 && ` · ${shown.more} more`}
        </span>
      </div>
    </Screen>
  );
}

/** The room's bots in the Tune panel (the host's; live, mid-match too): what the room says, or what was just picked. */
function RoomBots({ room }: { room: NonNullable<TunePanelProps['room']> }) {
  useTicker(500);
  const now = room.get();
  const [bots, showBots] = useRoomSetting(now.bots);
  const [level, showLevel] = useRoomSetting<BotLevel>(now.level);
  return (
    <div className="tune__presets mf-tune__bots">
      <BotSettings
        id="tune"
        bots={bots}
        level={level}
        onBots={(n) => {
          showBots(n);
          room.set({ bots: n });
        }}
        onLevel={(l) => {
          showLevel(l);
          room.set({ botLevel: l });
        }}
        segClass="seg seg--block"
        optClass="m-p8"
      />
    </div>
  );
}
