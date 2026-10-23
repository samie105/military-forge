/**
 * The fire modes' little moving pictures (controls spec §4.4, §4.10: "each choice has a 2-second
 * looping picture"): the aim dial, a thumb's knob, a target and the shots, as one SVG each. Used by
 * the first-run chooser (touch overlays) and Settings → Touch (shell). Under Reduce motion the loop
 * stops on the moment that explains the mode (fireArt.css).
 */
import type { FireMode } from './settings';
import './fireArt.css';

/** What each mode is called and does, in a line (the chooser and Settings say the same). */
export const FIRE_MODE_TEXT: Readonly<Record<FireMode, { name: string; line: string }>> = {
  auto: { name: 'Auto', line: 'Aim at someone: you fire by yourself. Push to the rim to fire anyway.' },
  pull: { name: 'Pull', line: 'Push the aim stick past its ring to fire.' },
  button: { name: 'Fire button', line: 'The stick only aims. Hold FIRE to shoot; drag it to aim while you shoot.' },
  release: { name: 'Release', line: 'Drag to aim, lift to fire one shot. Back to the middle and lift: no shot.' },
};

/** A mode's picture: SVG markup (decorative: aria-hidden). */
export function fireArt(mode: FireMode): string {
  const target = '<g class="fa-target"><circle cx="104" cy="22" r="5"/><rect x="99" y="28" width="10" height="16" rx="3"/></g>';
  const shot = '<line class="fa-shot" x1="44" y1="38" x2="98" y2="30"/>';
  const dial = '<circle class="fa-base" cx="34" cy="42" r="22"/>';
  const ring = mode === 'pull' ? '<circle class="fa-ring" cx="34" cy="42" r="12"/>' : mode === 'release' ? '<circle class="fa-cancel" cx="34" cy="42" r="4"/>' : '';
  const knob = '<circle class="fa-knob" cx="34" cy="42" r="8"/>';
  const extra =
    mode === 'button'
      ? '<g class="fa-fire"><circle cx="70" cy="56" r="11"/><text x="70" y="59.5">FIRE</text></g>'
      : mode === 'auto'
        ? '<g class="fa-tag"><rect x="21" y="66" width="26" height="9" rx="2"/><text x="34" y="73">AUTO</text></g>'
        : '';
  return `<svg class="fa fa--${mode}" viewBox="0 0 120 80" aria-hidden="true">${target}${dial}${ring}${extra}${shot}${knob}</svg>`;
}
