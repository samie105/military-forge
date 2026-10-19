/**
 * Settings → Controls → Controller: the pad that's connected, which button does what (press a
 * binding, then the new button), the sticks' feel, the triggers' thresholds and the rumble. Saved
 * with the other settings (`Settings.pad`). The phone's Settings shows it as its own tab ("Pad")
 * once a pad has been used.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { Kbd, Cap } from '../ui/Kbd';
import { Slider } from '../ui/Slider';
import { Switch, blurAfter } from '../ui/Screen';
import { padManager } from '.';
import { padCode } from './glyphs';
import { PadKbd, useInputDevice } from './react';
import { DEFAULT_PAD_SETTINGS, MAX_PAD_BINDINGS, PAD_ACTIONS, PAD_LIMITS, rebindPad, unbindPad, type GlyphSetting, type PadActionDef, type PadActionId, type PadSettings } from './settings';
import { padFamily } from './standard';
import { padAimCode, PAD_MENU_CODE } from './prompts';

/** How long a rebind waits for a button (s). */
const CAPTURE_S = 6;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const FAMILY_NAME = { playstation: 'PlayStation', xbox: 'Xbox', nintendo: 'Nintendo', generic: 'Controller' } as const;

type Capture = { action: PadActionId; index: number } | null;

/** The pads connected now (re-read when one comes or goes). */
function usePads(): Gamepad[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('gamepadconnected', bump);
    window.addEventListener('gamepaddisconnected', bump);
    const off = padManager()?.onChange(bump);
    return () => {
      window.removeEventListener('gamepadconnected', bump);
      window.removeEventListener('gamepaddisconnected', bump);
      off?.();
    };
  }, []);
  return padManager()?.pads() ?? [];
}

/** A pad's name without the browser's decorations ("(STANDARD GAMEPAD Vendor: 054c …)"). */
export function padName(id: string): string {
  const name = id
    .replace(/\(.*?\)/g, '')
    .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '')
    .trim();
  return name || FAMILY_NAME[padFamily(id)];
}

function Row({ phone, label, desc, children }: { phone: boolean; label: ReactNode; desc?: ReactNode; children: ReactNode }) {
  if (phone)
    return (
      <div className="pm-set">
        <div className="pm-set__text">
          <b>{label}</b>
          {desc && <span>{desc}</span>}
        </div>
        <div className="pm-set__ctl">{children}</div>
      </div>
    );
  return (
    <div className="srow">
      <div className="srow__txt">
        <b>{label}</b>
        {desc && <span>{desc}</span>}
      </div>
      <div className="srow__ctrl">{children}</div>
    </div>
  );
}

/** A slider over [lo, hi] with its value beside it. */
function Range({ value, range: [lo, hi], step, onChange, label, show }: { value: number; range: readonly [number, number]; step: number; onChange: (v: number) => void; label: string; show: (v: number) => string }) {
  const t = (value - lo) / (hi - lo);
  return (
    <div className="volrow">
      <Slider value={t} step={step / (hi - lo)} onChange={(v) => onChange(Math.round((lo + v * (hi - lo)) / step) * step)} label={label} valueText={show(value)} min={Math.round(lo * 100)} max={Math.round(hi * 100)} now={Math.round(value * 100)} />
      <output className="volrow__val num">{show(value)}</output>
    </div>
  );
}

function BindButton({ action, index, button, capture, onCapture }: { action: PadActionDef; index: number; button: number | undefined; capture: Capture; onCapture: (c: Capture) => void }) {
  const listening = capture?.action === action.id && capture.index === index;
  if (listening)
    return (
      <button type="button" className="btn btn--volt btn--sm mf-bindbtn" aria-live="polite" onClick={() => onCapture(null)}>
        Press a button…
      </button>
    );
  return (
    <button type="button" className="btn btn--ghost btn--sm mf-bindbtn" aria-label={`${action.label}: ${button === undefined ? 'not set' : 'change'}`} onClick={() => onCapture({ action: action.id, index })}>
      {button === undefined ? 'Not set' : <PadKbd code={padCode(button)} />}
    </button>
  );
}

export function PadControls({ pad, onChange, reduceFlashes = false, phone = false }: { pad: PadSettings; onChange: (pad: PadSettings) => void; reduceFlashes?: boolean; phone?: boolean }) {
  const pads = usePads();
  const device = useInputDevice();
  const [capture, setCapture] = useState<Capture>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const set = (patch: Partial<PadSettings>) => onChange({ ...pad, ...patch });
  const manager = padManager();
  // the latest settings for a rebind that's listening (the listener stays put while the panel re-renders)
  const latest = useRef({ pad, onChange });
  latest.current = { pad, onChange };

  // a rebind: the pad's next button press (or Esc to cancel, Backspace to clear, or the time running out)
  useEffect(() => {
    if (!capture || !manager) return;
    const done = () => setCapture(null);
    manager.captureNext((button) => {
      done();
      const { pad, onChange } = latest.current;
      const { bindings, took } = rebindPad(pad.bindings, capture.action, button, capture.index);
      onChange({ ...pad, bindings });
      const from = took && PAD_ACTIONS.find((a) => a.id === took);
      setMoved(from ? `That button was set for ${from.label}: it moved here, so ${from.label} lost it.` : null);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' && e.code !== 'Backspace' && e.code !== 'Delete') return;
      e.preventDefault();
      e.stopPropagation();
      const { pad, onChange } = latest.current;
      if (e.code !== 'Escape' && capture.index < pad.bindings[capture.action].length) onChange({ ...pad, bindings: unbindPad(pad.bindings, capture.action, capture.index) });
      done();
    };
    window.addEventListener('keydown', onKey, true);
    const timer = window.setTimeout(done, CAPTURE_S * 1000);
    return () => {
      manager.captureNext(null);
      window.removeEventListener('keydown', onKey, true);
      window.clearTimeout(timer);
    };
  }, [capture, manager]);

  const active = manager?.active ?? pads[0] ?? null;
  const fixed: [string, string][] = [
    ['Move', pad.swapSticks ? 'PadRS' : 'PadLS'],
    ['Aim', padAimCode(pad)],
    ['Menu', PAD_MENU_CODE],
  ];

  const header = phone ? (
    <Row phone label="Use controllers" desc="PlayStation, Xbox and most other pads.">
      <Switch on={pad.enabled} onChange={(enabled) => set({ enabled })} label="Use controllers" />
    </Row>
  ) : (
    <div className="tabpanel__head">
      <h3 className="display set__h">Controller</h3>
      <span className="topbar__spacer"></span>
      <Switch on={pad.enabled} onChange={(enabled) => set({ enabled })} label="Use controllers" showState={false} />
    </div>
  );
  const binds = (a: PadActionDef) =>
    Array.from({ length: MAX_PAD_BINDINGS }, (_, i) => (i <= pad.bindings[a.id].length ? <BindButton key={i} action={a} index={i} button={pad.bindings[a.id][i]} capture={capture} onCapture={setCapture} /> : null));

  return (
    <section className="mf-padset" aria-label="Controller">
      {header}
      <p className={active ? 'status status--ok' : 'status status--info'} role="status">
        <Icon name={active ? 'ok' : 'info'} />
        {active
          ? `${padName(active.id)}${pads.length > 1 ? ` (and ${pads.length - 1} more: the last one used plays)` : ''}${active.mapping === 'standard' ? '' : '. Its buttons may be laid out differently: rebind any that are off below.'}`
          : 'No controller yet. Connect one (USB or Bluetooth) and press any button. PlayStation, Xbox and most other pads work.'}
      </p>
      {!phone && (
        <p className="mf-set__note">
          Press a button below, then the controller button you want. <Cap>Esc</Cap> cancels, <Cap>Backspace</Cap> clears it. In menus the D-pad or the left stick moves, {device.kind === 'pad' ? <PadKbd code="Pad0" /> : 'the bottom button'} selects, {device.kind === 'pad' ? <PadKbd code="Pad1" /> : 'the right one'} goes back.
        </p>
      )}
      {phone ? (
        <>
          {fixed.map(([what, code]) => (
            <Row key={what} phone label={what} desc="Can't be changed">
              <PadKbd code={code} />
            </Row>
          ))}
          {PAD_ACTIONS.map((a) => (
            <Row key={a.id} phone label={a.label}>
              {binds(a)}
            </Row>
          ))}
        </>
      ) : (
        <ul className="binds" aria-label="Controller buttons">
          {fixed.map(([what, code]) => (
            <li key={what}>
              <span>
                {what}
                <span className="bindtable__hint">Can't be changed</span>
              </span>
              <PadKbd code={code} />
            </li>
          ))}
          {PAD_ACTIONS.map((a) => (
            <li key={a.id}>
              <span>
                {a.label}
                {a.hint && <span className="bindtable__hint">{a.hint}</span>}
              </span>
              {binds(a)}
            </li>
          ))}
        </ul>
      )}
      {moved && (
        <p className="status status--warn bind-conflict" role="status">
          <Icon name="warn" />
          {moved}
        </p>
      )}
      <Row phone={phone} label="Button glyphs" desc="Which buttons the prompts show. Auto follows the controller you use.">
        <div className="seg" role="radiogroup" aria-label="Button glyphs">
          {(
            [
              ['auto', 'Auto'],
              ['playstation', 'PlayStation'],
              ['xbox', 'Xbox'],
            ] as [GlyphSetting, string][]
          ).map(([id, text]) => (
            <button key={id} type="button" className="seg__opt" role="radio" aria-checked={pad.glyphs === id} onClick={() => set({ glyphs: id })}>
              {text}
            </button>
          ))}
        </div>
      </Row>
      <Row phone={phone} label="Aim speed" desc="How fast the aim turns to where the stick points. All the way right: at once.">
        <Range value={pad.aimSpeed} range={PAD_LIMITS.aimSpeed} step={0.05} onChange={(aimSpeed) => set({ aimSpeed })} label="Aim speed" show={(v) => (v >= 1.95 ? 'Instant' : `${v.toFixed(2)}×`)} />
      </Row>
      <Row phone={phone} label="Aim response" desc="Higher: finer control near the centre. The reticle sits as far out as you push.">
        <Range value={pad.aimCurve} range={PAD_LIMITS.aimCurve} step={0.1} onChange={(aimCurve) => set({ aimCurve })} label="Aim response curve" show={(v) => (v <= 1.05 ? 'Linear' : v.toFixed(1))} />
      </Row>
      <Row phone={phone} label="Invert aim up/down">
        <Switch on={pad.invertY} onChange={(invertY) => set({ invertY })} label="Invert aim up/down" />
      </Row>
      <Row phone={phone} label="Swap sticks" desc="Move with the right stick, aim with the left.">
        <Switch on={pad.swapSticks} onChange={(swapSticks) => set({ swapSticks })} label="Swap sticks" />
      </Row>
      <Row phone={phone} label="Push up to jet" desc="Pushing the move stick up jets, as the jet button does.">
        <Switch on={pad.stickJet} onChange={(stickJet) => set({ stickJet })} label="Push up to jet" />
      </Row>
      <Row phone={phone} label="Aim assist" desc="The touch controls' light assist: the aim slows a little on a target. It never pulls.">
        <Switch on={pad.aimAssist} onChange={(aimAssist) => set({ aimAssist })} label="Aim assist" />
      </Row>
      <Row phone={phone} label="Move stick dead zone" desc="Raise it if you drift with the stick let go.">
        <Range value={pad.moveDeadzone} range={PAD_LIMITS.deadzone} step={0.01} onChange={(moveDeadzone) => set({ moveDeadzone })} label="Move stick dead zone" show={pct} />
      </Row>
      <Row phone={phone} label="Aim stick dead zone">
        <Range value={pad.aimDeadzone} range={PAD_LIMITS.deadzone} step={0.01} onChange={(aimDeadzone) => set({ aimDeadzone })} label="Aim stick dead zone" show={pct} />
      </Row>
      <Row phone={phone} label={<>Fire trigger <Kbd code={padCode(7)} /></>} desc="How far you pull it before it fires.">
        <Range value={pad.fireThreshold} range={PAD_LIMITS.threshold} step={0.05} onChange={(fireThreshold) => set({ fireThreshold })} label="Fire trigger threshold" show={pct} />
      </Row>
      <Row phone={phone} label={<>Aim trigger <Kbd code={padCode(6)} /></>}>
        <Range value={pad.aimThreshold} range={PAD_LIMITS.threshold} step={0.05} onChange={(aimThreshold) => set({ aimThreshold })} label="Aim trigger threshold" show={pct} />
      </Row>
      <Row phone={phone} label="Vibration" desc={reduceFlashes ? 'Off while Reduce flashes is on (Accessibility).' : 'When you fire, get hit, dash, and when blasts go off near you. Where the browser allows it.'}>
        <Switch on={pad.vibration} onChange={(vibration) => set({ vibration })} label="Vibration" />
      </Row>
      <Row phone={phone} label="Vibration strength">
        <Range value={pad.vibrationStrength} range={PAD_LIMITS.vibrationStrength} step={0.05} onChange={(vibrationStrength) => set({ vibrationStrength })} label="Vibration strength" show={pct} />
        <button type="button" className="btn btn--ghost btn--sm" disabled={!active || !manager?.canRumble(active) || !pad.vibration || reduceFlashes} onClick={() => manager?.rumble({ strong: 0.8 * pad.vibrationStrength, weak: 0.5 * pad.vibrationStrength, ms: 250 }, active)}>
          Test
        </button>
      </Row>
      <Row phone={phone} label="Controller check" desc="Every stick and button, live, to see what your controller sends.">
        <a className="btn btn--ghost btn--sm" href="/gamepad.html" target="_blank" rel="noopener">
          Open
        </a>
        <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(() => onChange({ ...DEFAULT_PAD_SETTINGS, enabled: pad.enabled }))}>
          <Icon name="refresh" />
          Reset controller
        </button>
      </Row>
    </section>
  );
}
