/**
 * The controller check (/gamepad.html): every connected pad's sticks, triggers and buttons, live, with
 * the glyph each button gets, what the game reads from them with this device's settings (dead zones,
 * thresholds, bindings), and rumble buttons. For players ("does my pad work?") and for testing a pad
 * the game hasn't seen before (a mapping other than "standard").
 */
import { Btn } from '@military-forge/sim';
import { GAME_NAME } from '@military-forge/shared';
import { loadSettings } from '../shell/controller';
import { applyPageSettings } from '../ui/pageSettings';
import { currentDevice, notePad, onInputDevice, startDeviceTracking } from './device';
import { glyphFamily, padCode, padGlyphSvg, padLabel } from './glyphs';
import { PadManager } from './manager';
import { MOVE_ZONES, dashDirection, heldBits, moveBits, padDashStrength, shapeAxes, triggerHeld } from './mapping';
import { PAD_ACTIONS, buttonMap } from './settings';
import { B, BUTTON_COUNT, isDualSense, padFamily } from './standard';

applyPageSettings();
document.title = `Controller check · ${GAME_NAME}`;
startDeviceTracking();

const root = document.getElementById('padcheck')!;
const pad = loadSettings().pad;
const map = buttonMap(pad.bindings, pad.holdTake);
const rumbler = new PadManager({ menuScope: () => null, back: () => {}, pause: () => {} });

const BIT_NAMES = Object.entries(Btn).filter(([n]) => n !== 'Repeat') as [string, number][];
const actionOf = (button: number) =>
  PAD_ACTIONS.filter((a) => pad.bindings[a.id].includes(button))
    .map((a) => a.label)
    .join(', ') || (button === B.Start ? 'Menu' : '');

root.innerHTML = `
  <header class="padcheck__top">
    <a class="btn btn--ghost btn--sm" href="/">Back to the game</a>
    <h1 class="display">Controller check</h1>
  </header>
  <p class="padcheck__lead">Connect a controller (USB or Bluetooth) and press any button: browsers only show a pad after a press.
  Everything below is live. The game reads the sticks with your dead zones and the triggers with your thresholds
  (Settings → Controls → Controller).</p>
  <p class="padcheck__device" data-device></p>
  <div data-pads class="padcheck__pads"></div>`;
const padsEl = root.querySelector<HTMLElement>('[data-pads]')!;
const deviceEl = root.querySelector<HTMLElement>('[data-device]')!;

const showDevice = () => {
  const d = currentDevice();
  deviceEl.textContent = `Last input: ${d.kind === 'pad' ? `controller (${d.pad})` : d.kind === 'touch' ? 'touch' : 'keyboard and mouse'}`;
};
onInputDevice(showDevice);
showDevice();

interface Card {
  el: HTMLElement;
  axes: HTMLElement[];
  buttons: HTMLElement[];
  sticks: [HTMLElement, HTMLElement];
  bits: HTMLElement;
  meta: HTMLElement;
}
const cards = new Map<number, Card>();
const held = new Map<number, boolean[]>();

function card(p: Gamepad): Card {
  const family = padFamily(p.id);
  const f = glyphFamily(family);
  const opts = { dualSense: isDualSense(p.id) };
  const el = document.createElement('section');
  el.className = 'padcheck__pad card card--print';
  el.innerHTML = `
    <h2 class="padcheck__name"></h2>
    <p class="padcheck__meta" data-meta></p>
    <div class="padcheck__sticks">
      <div class="padcheck__stick" data-stick="0"><span class="padcheck__dz" style="--dz:${pad.moveDeadzone}"></span><i></i><b>Left stick</b></div>
      <div class="padcheck__stick" data-stick="1"><span class="padcheck__dz" style="--dz:${pad.aimDeadzone}"></span><i></i><b>Right stick</b></div>
    </div>
    <h3>Axes</h3>
    <ol class="padcheck__axes">${p.axes.map((_, i) => `<li><span>Axis ${i}</span><span class="padcheck__bar"><i></i></span><output class="num">0.00</output></li>`).join('')}</ol>
    <h3>Buttons</h3>
    <ol class="padcheck__buttons">${p.buttons
      .map((_, i) => {
        const code = padCode(i);
        const known = i < BUTTON_COUNT;
        return `<li data-b="${i}"><span class="mf-padglyph" aria-hidden="true">${known ? padGlyphSvg(code, f) : ''}</span><span class="padcheck__bname">${known ? padLabel(code, f, opts) : `Button ${i}`}<small>#${i}${known && actionOf(i) ? ` · ${actionOf(i)}` : ''}</small></span><output class="num">0.00</output></li>`;
      })
      .join('')}</ol>
    <h3>What the game reads</h3>
    <p class="padcheck__bits" data-bits>Nothing pressed</p>
    <div class="padcheck__rumble">
      <button type="button" class="btn btn--ghost btn--sm" data-rumble="light">Rumble: light</button>
      <button type="button" class="btn btn--ghost btn--sm" data-rumble="heavy">Rumble: heavy</button>
      <span class="muted small" data-rumble-note></span>
    </div>`;
  el.querySelector('h2')!.textContent = p.id || 'Controller';
  const c: Card = {
    el,
    axes: Array.from(el.querySelectorAll<HTMLElement>('.padcheck__axes li')),
    buttons: Array.from(el.querySelectorAll<HTMLElement>('.padcheck__buttons li')),
    sticks: [el.querySelector<HTMLElement>('[data-stick="0"] i')!, el.querySelector<HTMLElement>('[data-stick="1"] i')!],
    bits: el.querySelector<HTMLElement>('[data-bits]')!,
    meta: el.querySelector<HTMLElement>('[data-meta]')!,
  };
  const note = el.querySelector<HTMLElement>('[data-rumble-note]')!;
  note.textContent = rumbler.canRumble(p) ? '' : 'This browser can’t make this pad rumble.';
  el.querySelectorAll<HTMLButtonElement>('[data-rumble]').forEach((b) =>
    b.addEventListener('click', () => {
      const live = navigator.getGamepads()[p.index];
      rumbler.rumble(b.dataset.rumble === 'heavy' ? { strong: 1, weak: 0.6, ms: 400 } : { strong: 0.1, weak: 0.35, ms: 120 }, live ?? null);
    }),
  );
  return c;
}

function frame(): void {
  const pads = Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
  for (const [i, c] of cards) {
    if (!pads.some((p) => p.index === i)) {
      c.el.remove();
      cards.delete(i);
    }
  }
  if (!pads.length && !padsEl.querySelector('.padcheck__none')) padsEl.innerHTML = '<p class="padcheck__none status status--info">No controller yet: press a button on one.</p>';
  if (pads.length) padsEl.querySelector('.padcheck__none')?.remove();
  for (const p of pads) {
    let c = cards.get(p.index);
    if (!c) {
      c = card(p);
      cards.set(p.index, c);
      padsEl.appendChild(c.el);
    }
    c.meta.textContent = `Pad ${p.index} · mapping "${p.mapping || 'none'}"${p.mapping === 'standard' ? '' : ' (not standard: the buttons may sit elsewhere; rebind them in Settings)'} · ${padFamily(p.id)} · ${p.axes.length} axes, ${p.buttons.length} buttons`;
    p.axes.forEach((v, i) => {
      const li = c.axes[i];
      if (!li) return;
      li.querySelector<HTMLElement>('i')!.style.setProperty('--v', String(v));
      li.querySelector('output')!.textContent = v.toFixed(2);
    });
    const h = held.get(p.index) ?? new Array<boolean>(BUTTON_COUNT).fill(false);
    let any = false;
    p.buttons.forEach((b, i) => {
      const li = c.buttons[i];
      if (!li) return;
      li.classList.toggle('is-on', b.pressed);
      li.style.setProperty('--v', String(b.value));
      li.querySelector('output')!.textContent = b.value.toFixed(2);
      if (i < BUTTON_COUNT) h[i] = triggerHeld(b.value, b.pressed, h[i]!, i === B.R2 ? pad.fireThreshold : i === B.L2 ? pad.aimThreshold : 0.5);
      any ||= b.pressed;
    });
    held.set(p.index, h);
    if (any) notePad(padFamily(p.id), isDualSense(p.id));
    const [lx, ly, rx, ry] = pad.swapSticks ? [p.axes[2] ?? 0, p.axes[3] ?? 0, p.axes[0] ?? 0, p.axes[1] ?? 0] : [p.axes[0] ?? 0, p.axes[1] ?? 0, p.axes[2] ?? 0, p.axes[3] ?? 0];
    const move = shapeAxes(lx, ly, pad.moveDeadzone, 1, undefined, MOVE_ZONES.snapDeg);
    const aim = shapeAxes(rx, pad.invertY ? -ry : ry, pad.aimDeadzone, pad.aimCurve);
    c.sticks[0].style.transform = `translate(${(lx * 40).toFixed(1)}px, ${(ly * 40).toFixed(1)}px)`;
    c.sticks[1].style.transform = `translate(${(rx * 40).toFixed(1)}px, ${(ry * 40).toFixed(1)}px)`;
    const bits = heldBits(h, map) | moveBits(move, pad.stickJet);
    const names = BIT_NAMES.filter(([, bit]) => bits & bit).map(([n]) => n);
    if ([...map.grenade].some((g) => h[g])) names.push('Grenade (held: aiming the arc)');
    if ([...map.dash].some((g) => h[g])) names.push(`dash way ${dashDirection(move) || 'facing'}, strength ${padDashStrength(move.mag, 0)}/7`);
    if (aim.mag > 0) names.push(`aim ${Math.round((Math.atan2(aim.y, aim.x) * 180) / Math.PI)}° at ${Math.round(aim.mag * 100)}%`);
    c.bits.textContent = names.length ? names.join(' · ') : 'Nothing pressed';
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
