/**
 * Settings → Controller's live check: each stick in a test circle that draws its zones (the dead
 * zone, the run lines, the stick-jet cone and its hold zone, the crouch wedge; on the aim stick the
 * push where it starts turning and where assist starts pulling) with the stick's dot on top, and the
 * live mapping: every action with its buttons, lit while held, and the Input the game would read.
 * "Test the controller" keeps presses from working the menu until Options ends it.
 */
import { Btn } from '@military-forge/sim';
import { useEffect, useRef, useState } from 'react';
import { padManager } from '.';
import { AIM_MIN_PUSH, MOVE_ZONES, STICK_OUTER, createMoveState, dashDirection, heldBits, moveStep, shapeAxes, type MoveState } from './mapping';
import { PAD_PULL_MIN } from './manager';
import { PadKbd } from './react';
import { PAD_ACTIONS, buttonMap, type PadSettings } from './settings';
import { BUTTON_COUNT } from './standard';

interface Live {
  axes: number[];
  held: boolean[];
  connected: boolean;
}

const IDLE: Live = { axes: [0, 0, 0, 0], held: new Array<boolean>(BUTTON_COUNT).fill(false), connected: false };

/** The pad's reading every frame while the page is open. */
function useLive(): Live {
  const [live, setLive] = useState<Live>(IDLE);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const m = padManager();
      const d = m?.debugState();
      if (d) setLive((prev) => (d.index < 0 && !prev.connected ? prev : { axes: d.axes, held: d.held, connected: d.index >= 0 }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return live;
}

const R = 100;
const rad = (deg: number) => (deg * Math.PI) / 180;
/** A point at raw push `push`, angle `deg` (0 = right, 90 = up), in the circle's SVG frame (y down). */
const pt = (push: number, deg: number) => `${(Math.cos(rad(deg)) * push * R).toFixed(1)} ${(-Math.sin(rad(deg)) * push * R).toFixed(1)}`;
/** A ring sector from raw push `from` to the rim, between two angles. */
function sector(from: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${pt(from, a0)} L${pt(1, a0)} A${R} ${R} 0 ${large} 0 ${pt(1, a1)} L${pt(from, a1)} A${from * R} ${from * R} 0 ${large} 1 ${pt(from, a0)}Z`;
}
/** The raw push at which a shaped push `t` begins (the dead zone `dz`, the outer 0.92). */
const rawAt = (t: number, dz: number) => dz + t * (STICK_OUTER - dz);

const BIT_NAMES: [number, string][] = [
  [Btn.Left, 'Left'],
  [Btn.Right, 'Right'],
  [Btn.Jet, 'Jet'],
  [Btn.Down, 'Crouch'],
  [Btn.Fire, 'Fire'],
  [Btn.Fire2, 'Spin-up'],
  [Btn.Dash, 'Dash'],
  [Btn.Reload, 'Reload'],
  [Btn.Swap, 'Swap'],
  [Btn.Melee, 'Melee'],
  [Btn.Interact, 'Take'],
  [Btn.Shield, 'Shield'],
  [Btn.Dual, 'Dual'],
  [Btn.CycleGrenade, 'Next grenade'],
];
const bitWords = (b: number) => BIT_NAMES.filter(([bit]) => b & bit).map(([, n]) => n);

/** One stick's test circle. `move`: the move stick's zones; otherwise the aim stick's. */
function StickTest({ x, y, dz, move, stickJet, label, words }: { x: number; y: number; dz: number; move: boolean; stickJet: boolean; label: string; words: string }) {
  const z = MOVE_ZONES;
  const run = rawAt(z.runOn, dz);
  const runX = (run * R).toFixed(1);
  const runY = (Math.sqrt(1 - run * run) * R).toFixed(1);
  const push = Math.hypot(x, y);
  const inDead = push < dz;
  return (
    <figure className="mf-padlive__stick">
      <svg viewBox="-112 -112 224 224" role="img" aria-label={`${label}: ${words || 'resting'}`}>
        <circle className="mf-padlive__rim" r={R} />
        <circle className="mf-padlive__outer" r={STICK_OUTER * R} />
        {move ? (
          <>
            {stickJet && <path className="mf-padlive__hold" d={sector(rawAt(z.jetHold.push, dz), z.jetHold.minDeg, z.jetHold.maxDeg)} />}
            {stickJet && <path className="mf-padlive__jet" d={sector(rawAt(z.jetStart.push, dz), z.jetStart.minDeg, z.jetStart.maxDeg)} />}
            <path className="mf-padlive__crouch" d={sector(rawAt(z.crouch.push, dz), -90 - z.crouch.halfDeg, -90 + z.crouch.halfDeg)} />
            <path className="mf-padlive__run" d={`M${runX} -${runY}V${runY}M-${runX} -${runY}V${runY}`} />
          </>
        ) : (
          <>
            <circle className="mf-padlive__ring" r={AIM_MIN_PUSH * R} />
            <circle className="mf-padlive__ring mf-padlive__ring--pull" r={PAD_PULL_MIN * R} />
          </>
        )}
        <circle className="mf-padlive__dead" r={dz * R} />
        <circle className={inDead ? 'mf-padlive__dot is-dead' : 'mf-padlive__dot'} cx={(x * R).toFixed(1)} cy={(y * R).toFixed(1)} r="9" />
      </svg>
      <figcaption>
        <b>{label}</b>
        <span className="num">
          {Math.round(push * 100)}% · {push < 0.05 ? '—' : `${Math.round((Math.atan2(-y, x) * 180) / Math.PI)}°`}
        </span>
        <span>{words || (inDead ? 'In the dead zone' : 'Nothing')}</span>
      </figcaption>
    </figure>
  );
}

export function PadLive({ pad }: { pad: PadSettings }) {
  const live = useLive();
  const [testing, setTesting] = useState(false);
  const moveState = useRef<MoveState>(createMoveState());
  const manager = padManager();
  useEffect(() => () => manager?.testInput(null), [manager]);

  const [lx, ly, rx, ry] = live.axes as [number, number, number, number];
  const [mx, my, ax, ay] = pad.swapSticks ? [rx, ry, lx, ly] : [lx, ly, rx, ry];
  const move = shapeAxes(mx, my, pad.moveDeadzone, 1, undefined, MOVE_ZONES.snapDeg);
  const map = buttonMap(pad.bindings, pad.holdTake);
  const moveBitsNow = moveStep(moveState.current, move, pad.stickJet);
  const bits = heldBits(live.held, map) | moveBitsNow;
  const held = (b: number) => live.held[b] ?? false;
  const aimPush = Math.hypot(ax, ay);
  const aimWords = aimPush >= AIM_MIN_PUSH ? `Aims ${Math.round((Math.atan2(-ay, ax) * 180) / Math.PI)}°${aimPush >= PAD_PULL_MIN && pad.assist === 'standard' ? ' · assist can pull' : ''}` : '';
  const dash = [...map.dash].some(held) ? bitWords(dashDirection(move)).join('-') || 'the way you face' : '';

  const toggleTest = () => {
    if (testing) {
      manager?.testInput(null);
      setTesting(false);
    } else {
      manager?.testInput(() => setTesting(false));
      setTesting(true);
    }
  };

  return (
    <section className={testing ? 'mf-padlive is-testing' : 'mf-padlive'} aria-label="Controller check">
      <div className="mf-padlive__head">
        <b>Live check</b>
        <span>{live.connected ? (testing ? 'Testing: buttons and sticks only show here. Press Options to finish.' : 'Move the sticks and press buttons: the zones and the mapping light up.') : 'Connect a controller and press any button to see it here.'}</span>
        <button type="button" className={testing ? 'btn btn--volt btn--sm' : 'btn btn--ghost btn--sm'} aria-pressed={testing} disabled={!live.connected} onClick={toggleTest}>
          {testing ? 'Done testing' : 'Test the controller'}
        </button>
      </div>
      <div className="mf-padlive__sticks">
        <StickTest x={mx} y={my} dz={pad.moveDeadzone} move stickJet={pad.stickJet} label={pad.swapSticks ? 'Move (right stick)' : 'Move (left stick)'} words={[...bitWords(moveBitsNow), dash && `dash ${dash}`].filter(Boolean).join(' · ')} />
        <StickTest x={ax} y={ay} dz={pad.aimDeadzone} move={false} stickJet={false} label={pad.swapSticks ? 'Aim (left stick)' : 'Aim (right stick)'} words={aimWords} />
        <ul className="mf-padlive__legend" aria-label="What the zones mean">
          <li><i className="mf-padlive__key mf-padlive__key--dead"></i>Dead zone ({Math.round(pad.moveDeadzone * 100)}%): nothing</li>
          <li><i className="mf-padlive__key mf-padlive__key--run"></i>Run past the lines (≈ {Math.round(rawAt(MOVE_ZONES.runOn, pad.moveDeadzone) * 100)}%)</li>
          {pad.stickJet && <li><i className="mf-padlive__key mf-padlive__key--jet"></i>Flight starts in the steep cone (55°–125°), keeps going in the wide one</li>}
          <li><i className="mf-padlive__key mf-padlive__key--crouch"></i>Crouch: straight down (±30°)</li>
          <li><i className="mf-padlive__key mf-padlive__key--ring"></i>Aim turns past {Math.round(AIM_MIN_PUSH * 100)}%; assist pulls past {Math.round(PAD_PULL_MIN * 100)}%</li>
        </ul>
      </div>
      <ul className="mf-padlive__map" aria-label="Live mapping">
        {PAD_ACTIONS.map((a) => {
          const buttons = a.id === 'interact' && pad.holdTake ? pad.bindings.reload.slice(0, 1) : pad.bindings[a.id];
          const on = buttons.some(held) || (a.bit !== undefined && (bits & a.bit) !== 0 && a.id !== 'interact');
          return (
            <li key={a.id} className={on ? 'is-on' : undefined}>
              <span>{a.label.replace(' (hold)', '')}</span>
              {a.id === 'interact' && pad.holdTake && pad.bindings.reload[0] !== undefined ? <PadKbd code={`PadHold${pad.bindings.reload[0]}`} /> : null}
              {pad.bindings[a.id].map((b) => (
                <PadKbd key={b} code={`Pad${b}`} />
              ))}
            </li>
          );
        })}
      </ul>
      <p className="mf-padlive__reads" aria-live="off">
        <b>The game reads:</b> {bitWords(bits).join(' + ') || 'nothing'}
      </p>
    </section>
  );
}
