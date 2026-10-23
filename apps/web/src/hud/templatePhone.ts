/**
 * The phone HUD's markup (the phone UI's; template.ts puts it next to the desktop HUD): what you look
 * at from the owner's round-two kit's "M1 Phone HUD · thumb dials" (docs/design/military-forge-ui-v2.html,
 * 812×375, zoomed by --phone-fit), shown while the touch controls are up. What you press, the thumb
 * dials and their buttons, is the touch module's (touch/skin.ts): HP and fuel ride the move dial,
 * the ammo the aim dial, so nothing here duplicates them.
 *
 *   top left     the kill line (the newest kill only), or the low-health cue while it lasts; ping, and
 *                "Tuned by admin" under it while the owner's admin page has changed this server's numbers
 *   top centre   the clock and the score
 *   centre       the reticle (by transform: hud.ts) with the hit, headshot, ricochet, launch and kill
 *                markers (the desktop's), the damage arcs
 *   under clock  the arc warning while a throw is aimed through a map event (the HUD's arc-warning token)
 *   bottom       the respawn card while you're out; the pickup line for what has no button
 *
 * Bound the HUD's way (bind.ts, state.ts); hud.ts fills the kill line (.phud-feed) and the arcs.
 */
import { eventFxTemplate, eventTemplate } from './eventTemplate';
import './phone.css';

const ic = (name: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

const RETICLE = `<svg class="reticle__x" viewBox="0 0 48 48"><g class="u"><path d="M24 6v10M24 32v10M6 24h10M32 24h10"/></g><g class="o"><path d="M24 6v10M24 32v10M6 24h10M32 24h10"/></g></svg>`;

/** The hit markers round the reticle (template.ts's, the same tokens hud.ts sets): a hit, a headshot, a ricochet, a launch, a kill. */
const MARKERS = `<svg class="mk mk--hit mf-mk" data-state="hit+!headshot+!ricochet+!launch-mark" viewBox="0 0 64 64"><path class="u" d="M14 14l9 9M50 14l-9 9M14 50l9-9M50 50l-9-9"/><path class="o" d="M14 14l9 9M50 14l-9 9M14 50l9-9M50 50l-9-9"/></svg>
<span class="mk mk--head mf-mk" data-state="headshot"><svg viewBox="0 0 64 64"><path class="u" d="M10 10l12 12M54 10L42 22M10 54l12-12M54 54L42 42"/><path class="o" d="M10 10l12 12M54 10L42 22M10 54l12-12M54 54L42 42"/></svg><span class="mk__tag mk__tag--head">${ic('b-headshot', 'ic--sm')}Head</span></span>
<span class="mk mk--rico mf-mk" data-state="ricochet"><svg viewBox="0 0 64 64"><path class="u" d="M14 14l9 9M50 14l-9 9M20 46l6-12 8 6 6-12"/><path class="o" d="M14 14l9 9M50 14l-9 9M20 46l6-12 8 6 6-12"/></svg><span class="mk__tag">${ic('shield', 'ic--sm')}Ricochet</span></span>
<span class="mk mk--launch mf-mk" data-state="launch-mark"><svg viewBox="0 0 64 64"><path class="u" d="M14 50C20 30 32 20 50 16M42 10l8 6-6 8"/><path class="o" d="M14 50C20 30 32 20 50 16M42 10l8 6-6 8"/></svg><span class="mk__tag">${ic('b-launch', 'ic--sm')}Launched</span></span>
<svg class="mk mk--kill m-p7" data-state="kill" viewBox="0 0 80 80"><path class="u" d="M14 14l14 14M66 14L52 28M14 66l14-14M66 66L52 52"/><path class="o" d="M14 14l14 14M66 14L52 28M14 66l14-14M66 66L52 52"/><path class="d" d="M40 31l9 9-9 9-9-9z"/></svg>`;

/** The compact compare above the Take button (pickup-crate): damage, fire rate and mag, held (muted) against the floor's gun (volt). */
const PHONE_CMP = (
  [
    ['Dmg', 'damage'],
    ['Rate', 'rate'],
    ['Mag', 'mag'],
  ] as const
)
  .map(
    ([label, k]) =>
      `<div class="pt-cmp__row" data-state="pickup-cmp" data-bind-var="--a: pickup.bar.${k}.a; --b: pickup.bar.${k}.b"><span class="hud-label">${label}</span><span class="cmp__bars"><i class="cmp__a"></i><i class="cmp__b"></i></span><span data-bind-attr="class: pickup.delta.${k}.class" data-bind="pickup.delta.${k}.text"></span></div>`,
  )
  .join('');

export function phoneHudTemplate(): string {
  return `
<section class="screen screen--game screen--phone mf-hud-phone" data-screen="m-hud" aria-label="Phone HUD">
  <div class="vignette vignette--hp" data-state="low-hp" aria-hidden="true"></div>
  ${eventFxTemplate()}
  <div class="mf-world" aria-hidden="true"></div>
  <div class="hud ph">
    <ol class="phud-feed pt-feed" aria-label="Kill feed" data-state="!low-hp"></ol>
    <div class="pt-cue plate" data-state="low-hp+alive" role="status">${ic('hp', 'ic--sm')}<b>Low health</b><span data-bind="player.hpCue"></span></div>
    <div class="pt-clock plate" data-state="match"><b class="num" data-bind="match.timeLeft"></b><span><span class="hud-label">You</span> <b class="num" data-bind="match.myScore"></b><i></i><span class="hud-label" data-bind="match.leaderShort"></span> <b class="num" data-bind="match.leaderScore"></b></span></div>
    <span class="phud-admin hud-label" data-state="admin">Tuned by admin</span>
    <span class="pt-ping" data-state="net"><span data-bind-attr="class: net.phoneClass"><span class="sig" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span data-bind="net.ping"></span></span><span class="pt-ping__more num" data-bind="net.short"></span></span>
    <span class="pt-arcwarn mf-arcwarn" data-state="arc-warning" role="status">${ic('warn', 'ic--sm')}Arc bends<span data-bind-show="event.name"> · <span data-bind="event.name"></span></span></span>
    <div class="pickup plate pt-pickup" data-state="pickup" role="status" data-bind-attr="data-tone: pickup.item.tone"><svg class="ic ic--sm" aria-hidden="true"><use data-bind-attr="href: pickup.icon"/></svg><span data-state="pickup-item"><b data-bind="pickup.item.title"></b> <span class="pt-pickup__line" data-bind="pickup.item.line"></span></span><span data-state="!pickup-item" data-bind="pickup.text"></span></div>
    <div class="pt-draw plate" data-state="switching+alive drawn+alive" role="status">
      <b class="pt-draw__kick" data-state="switching">Drawing</b>
      <svg class="ic--kf" aria-hidden="true"><use data-bind-attr="href: player.slot.0.icon"/></svg>
      <b class="display pt-draw__name" data-bind="player.slot.0.name"></b>
      <span class="mf-chip" data-bind="player.slot.0.family"></span>
      <span class="num pt-draw__ammo" data-state="gun"><span data-bind="player.slot.0.mag"></span>/<span data-bind="player.slot.0.reserve"></span></span>
      <i class="pt-draw__bar" data-state="switching" aria-hidden="true"></i>
    </div>
    <div class="pt-cmp plate" data-state="pickup-crate+!switching+!drawn" role="status">
      <div class="pt-cmp__head"><svg class="ic--kf" aria-hidden="true"><use data-bind-attr="href: pickup.weapon.icon"/></svg><b class="display" data-bind="pickup.weapon.name"></b><span class="mf-chip" data-bind="pickup.weapon.family"></span><span class="pt-cmp__for" data-state="pickup-swaps">for your <span data-bind="pickup.held.name"></span></span></div>
      ${PHONE_CMP}
    </div>
    <div class="respawn plate" data-state="spectating" role="status">
      <p class="respawn__by"><span class="hud-label" data-bind="death.label"></span> <b data-bind="death.killer"></b></p>
      <p class="respawn__timer"><span data-bind="death.lead"></span> <b data-bind="player.respawnIn" data-bind-attr="class: death.numClass"></b> <span data-bind="death.unit"></span></p>
      <div class="bar bar--respawn"><i></i></div>
    </div>
  </div>
  ${eventTemplate()}
  <div class="feedback" aria-hidden="true">
    <svg class="dmg-arcs" viewBox="-200 -200 400 400"></svg>
    <div class="reticle reticle--sm" data-state="reticle">${RETICLE}${MARKERS}</div>
  </div>
</section>`;
}
