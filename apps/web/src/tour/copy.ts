/**
 * Every word the tour says, in one table, ready for translation (docs/design/onboarding-research.md
 * §3.7): titles 1–3 words, bodies ≤ 12, imperative and present; no exclamation marks, praise or "Let's";
 * success is a stamp, "Confirmed". Inputs show as the player's own key caps or pad glyphs (the
 * callout adds them after the body); touch names the dial or button. Numbers are numerals.
 */
import type { Device } from './log';

export interface FlightCopy {
  title: string;
  body: string;
  /** the second line a 20 s time-out adds, with "Skip this" */
  help: string;
}

type Words = { moveSide: 'left' | 'right'; fire: string; jetButton?: boolean; dashButton?: boolean };
const other = (side: 'left' | 'right') => (side === 'left' ? 'right' : 'left');

/** Fire on touch, per fire mode (touch/settings.ts FireMode; the aim dial's side) */
/**
 * Fire on touch, per fire mode (touch/settings.ts FireMode; the aim stick's side). Touch words are one
 * short line: on a phone they sit in a strip that must read whole in an 844×300 Safari view (the
 * owner's iPhone, 24 Oct), so the "3 hits" count follows as the tally.
 */
const TOUCH_FIRE = {
  auto: (aim: string) => `Aim the ${aim} stick at the target.`,
  pull: (aim: string) => `Push the ${aim} stick past its ring.`,
  button: () => 'Hold FIRE, drag to aim.',
  release: (aim: string) => `Aim the ${aim} stick, lift to fire.`,
} as const;

/** The five goals, per device. */
export const FLIGHT_COPY: Record<'run' | 'fly' | 'hit' | 'dash' | 'throw', (device: Device, touch: Words) => FlightCopy> = {
  run: (d, t) =>
    d === 'touch'
      ? { title: 'Run.', body: `Drag the ${t.moveSide} stick.`, help: `Thumb on the ${t.moveSide} half, slide.` }
      : { title: 'Run.', body: 'Reach the marker.', help: d === 'pad' ? 'Push the move stick either way.' : 'Hold a direction key. 3 m does it.' },
  fly: (d, t) =>
    d === 'touch'
      ? t.jetButton
        ? { title: 'Fly.', body: 'Hold JET.', help: `Or push the ${t.moveSide} stick up.` }
        : { title: 'Fly.', body: `Push the ${t.moveSide} stick up.`, help: 'Hold it up to climb.' }
      : { title: 'Fly.', body: 'Hold to fly. Watch the fuel.', help: 'Up to the marker. Fuel refills on the ground.' },
  hit: (d, t) =>
    d === 'touch'
      ? { title: 'Fire.', body: TOUCH_FIRE[t.fire as keyof typeof TOUCH_FIRE]?.(other(t.moveSide)) ?? TOUCH_FIRE.pull(other(t.moveSide)), help: '3 hits on the ringed target.' }
      : { title: 'Fire.', body: '3 hits on the target.', help: d === 'pad' ? 'Aim with the other stick. The ring marks the target.' : 'Aim with the mouse. The ring marks the target.' },
  dash: (d, t) =>
    d === 'touch'
      ? t.dashButton
        ? { title: 'Dash.', body: 'Tap DASH.', help: `Or flick the ${t.moveSide} stick.` }
        : { title: 'Dash.', body: `Flick the ${t.moveSide} stick.`, help: 'Push to the rim fast, let go.' }
      : { title: 'Dash.', body: 'Dodges fire. Any direction.', help: 'Hold a direction, then dash.' },
  throw: (d) =>
    d === 'touch'
      ? { title: 'Throw.', body: 'Tap the grenade button.', help: 'Hold it to aim the arc.' }
      : { title: 'Throw.', body: 'Tap to throw, hold to aim.', help: 'Hold, aim the arc at the target, let go.' },
};

export const TOUR_COPY = {
  /** the callout's eyebrow in First flight */
  orders: (n: number, of: number) => `Orders · ${n}/${of}`,
  /** "3 hits" as they land */
  tally: (n: number, of: number) => `${n}/${of}`,
  confirmed: 'Confirmed',
  complete: 'Flight complete',
  completeBody: (secs: number) => `${secs} s. Next: a match against 3 Easy bots.`,
  liveFire: 'Live fire',
  later: 'Later',
} as const;

export const DEVICE_NAMES: Record<Device, string> = { touch: 'Touch', keyboard: 'Keyboard and mouse', pad: 'Controller' };

/** The Briefing (§3.2 card 1; the owner's default wording, §8.3). */
export const BRIEFING_COPY = {
  eyebrow: 'Briefing',
  question: 'First time in a firefight?',
  recruit: 'Show me the ropes',
  recruitSub: 'Recruit · 90 s in the range, then a first match vs Easy bots',
  veteran: 'I know shooters',
  veteranSub: 'Veteran · Skip training, straight to Home',
  playingWith: 'Playing with:',
  change: 'Change',
  skipAll: 'Skip all training',
} as const;
