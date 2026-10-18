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
 *   centre       the reticle (by transform: hud.ts), the damage arcs
 *   under clock  the arc warning while a throw is aimed through a map event (the HUD's arc-warning token)
 *   bottom       the respawn card while you're out; the pickup line for what has no button
 *
 * Bound the HUD's way (bind.ts, state.ts); hud.ts fills the kill line (.phud-feed) and the arcs.
 */
import './phone.css';

const ic = (name: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

const RETICLE = `<svg class="reticle__x" viewBox="0 0 48 48"><g class="u"><path d="M24 6v10M24 32v10M6 24h10M32 24h10"/></g><g class="o"><path d="M24 6v10M24 32v10M6 24h10M32 24h10"/></g></svg>`;

export function phoneHudTemplate(): string {
  return `
<section class="screen screen--game screen--phone mf-hud-phone" data-screen="m-hud" aria-label="Phone HUD">
  <div class="vignette vignette--hp" data-state="low-hp" aria-hidden="true"></div>
  <div class="hud ph">
    <ol class="phud-feed pt-feed" aria-label="Kill feed" data-state="!low-hp"></ol>
    <div class="pt-cue plate" data-state="low-hp+alive" role="status">${ic('hp', 'ic--sm')}<b>Low health</b><span data-bind="player.hpCue"></span></div>
    <div class="pt-clock plate" data-state="match"><b class="num" data-bind="match.timeLeft"></b><span><span class="hud-label">You</span> <b class="num" data-bind="match.myScore"></b><i></i><span class="hud-label" data-bind="match.leaderShort"></span> <b class="num" data-bind="match.leaderScore"></b></span></div>
    <span class="phud-admin hud-label" data-state="admin">Tuned by admin</span>
    <span class="pt-ping" data-state="net"><span data-bind-attr="class: net.phoneClass"><span class="sig" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span data-bind="net.ping"></span></span></span>
    <span class="pt-arcwarn mf-arcwarn" data-state="arc-warning" role="status">${ic('warn', 'ic--sm')}Arc bends<span data-bind-show="event.name"> · <span data-bind="event.name"></span></span></span>
    <div class="pickup plate pt-pickup" data-state="pickup" role="status"><svg class="ic ic--sm" aria-hidden="true"><use data-bind-attr="href: pickup.icon"/></svg><span data-bind="pickup.text"></span></div>
    <div class="respawn plate" data-state="spectating" role="status">
      <p class="respawn__by"><span class="hud-label" data-bind="death.label"></span> <b data-bind="death.killer"></b></p>
      <p class="respawn__timer"><span data-bind="death.lead"></span> <b class="num" data-bind="player.respawnIn"></b> <span data-bind="death.unit"></span></p>
      <div class="bar bar--respawn"><i></i></div>
    </div>
  </div>
  <div class="feedback" aria-hidden="true">
    <svg class="dmg-arcs" viewBox="-200 -200 400 400"></svg>
    <div class="reticle reticle--sm" data-state="reticle">${RETICLE}</div>
  </div>
</section>`;
}
