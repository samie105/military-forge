/**
 * The HUD's markup: the kit's "7 · In-match HUD" (desktop, 1920×1080) and "14 · Phone HUD"
 * (812×375, while the touch controls are up), as shipped in docs/design/military-forge-ui.html.
 * Values arrive through attributes (bind.ts, state.ts):
 *
 *   data-bind="player.hp"            text
 *   data-bind-attr="href: key"       an attribute (icons: <use href>, classes)
 *   data-bind-var="--x: key"         a CSS variable
 *   data-state="low-hp"              shown while that token is active on the root
 *
 * Bars read the CSS variables on the HUD root (--hp, --hp-ghost, --fuel, --fuel-delay, --shield-hp,
 * --dash, --reload, --respawn, --event): one number each, never a width. The lists that come and go
 * (kill feed, banners, damage arcs, the belt, the scoreboard) are filled by hud.ts into the empty
 * containers marked here.
 */

const RETICLE = `<svg viewBox="0 0 48 48"><g class="reticle__under"><path d="M24 4v12M24 32v12M4 24h12M32 24h12"/><circle cx="24" cy="24" r="2"/></g><g class="reticle__over"><path d="M24 4v12M24 32v12M4 24h12M32 24h12"/><circle cx="24" cy="24" r="2"/></g></svg>`;

const ic = (name: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

function desktop(): string {
  return `
<section class="screen screen--game mf-hud-desktop" data-screen="hud" aria-label="In-match HUD">
  <div class="vignette vignette--hp" data-state="low-hp" aria-hidden="true"></div>
  <div class="hud" role="group" aria-label="Match HUD">

    <div class="mf-hud-corner">
      <div class="hud-net hud-plate" data-state="fps"><span class="num" data-bind="fps.value"></span><span class="hud-net__loss">fps</span></div>
      <div class="hud-net hud-plate" data-state="net" data-bind-attr="title: net.detail; data-detail: net.detail">
        <span data-bind-attr="class: net.class"><span class="sig" data-bind-attr="data-bars: net.bars"><i></i><i></i><i></i><i></i></span><span class="num" data-bind="net.ping"></span></span>
        <span class="hud-net__loss num"><span data-bind="net.loss"></span> loss</span>
      </div>
    </div>

    <div class="hud-match">
      <div class="hud-clock hud-plate" data-state="match">
        <span class="hud-label" data-bind="match.mode"></span>
        <span class="hud-clock__time num" data-bind="match.timeLeft"></span>
        <span class="hud-label" data-bind="match.limit"></span>
      </div>
      <div class="hud-score" data-state="match">
        <div class="hud-score__cell hud-plate is-you"><span class="hud-label">You</span><b class="num" data-bind="match.myScore"></b></div>
        <div class="hud-score__cell hud-plate"><span class="hud-label" data-bind="match.leaderLabel"></span><b class="num" data-bind="match.leaderScore"></b></div>
      </div>
      <div data-state="event" data-bind-attr="class: event.class" data-bind-var="--ev: event.color" role="status">
        <span class="event-banner__icon"><svg class="ic ic--lg" aria-hidden="true"><use data-bind-attr="href: event.icon"/></svg></span>
        <div class="event-banner__text">
          <p class="event-banner__title"><b data-bind="event.name"></b><span class="event-banner__time num" data-bind="event.time"></span></p>
          <p class="event-banner__desc" data-bind="event.description"></p>
        </div>
        <div class="bar bar--event" data-state="event-active" aria-hidden="true"><i></i></div>
      </div>
      <div class="mf-hud-banners" aria-live="polite"></div>
    </div>

    <ol class="killfeed" aria-label="Kill feed" aria-live="polite"></ol>

    <div class="hud-vitals">
      <div class="hud-cue hud-cue--hp hud-plate" data-state="low-hp">${ic('hp')}<span><b>Low health</b><span data-bind="player.hpCue"></span></span></div>
      <div class="hud-cue hud-cue--gas hud-plate" data-state="gas">${ic('g-gas')}<span><b>Toxic gas</b> · <span data-bind="player.gasCue"></span></span></div>
      <div class="hud-cue hud-cue--emp hud-plate" data-state="emp">${ic('ev-emp')}<span><b>Jetpack offline</b> · <span data-bind="player.empCause"></span></span><b class="num" data-bind="player.jetDisabled"></b></div>

      <div class="hud-shield hud-plate" data-state="shield">
        ${ic('shield', 'ic--lg')}
        <div class="hud-shield__body">
          <div class="hud-shield__top"><span class="hud-label">Riot shield</span><span class="hud-shield__state" data-bind="player.shield.state"></span><span class="hud-shield__hp num"><b data-bind="player.shield.hp"></b> / <span data-bind="player.shield.max"></span></span></div>
          <div class="bar bar--shield" aria-hidden="true"><i></i></div>
          <span class="hud-label"><span data-bind="player.shield.covers"></span> · <kbd class="kbd" data-bind="bind.shield.0"></kbd> <span data-bind="player.shield.action"></span></span>
        </div>
      </div>

      <div class="hud-vitals__row">
        <div class="hud-vitals__main hud-plate">
          <div class="vital vital--hp">
            ${ic('hp')}
            <span class="vital__num num" data-bind="player.hp"></span>
            <div class="bar bar--ticks bar--hp" aria-hidden="true"><i class="bar__ghost"></i><i></i></div>
          </div>
          <div class="vital vital--fuel">
            ${ic('fuel')}
            <span class="vital__num num" data-bind="player.fuel"></span>
            <div class="vital__stack">
              <div class="bar bar--fuel" aria-hidden="true"><i></i></div>
              <div class="bar bar--delay" aria-hidden="true"><i></i></div>
            </div>
          </div>
        </div>

        <div class="hud-dash hud-plate" aria-label="Dash">
          <svg class="dash-ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="dash-ring__track" cx="32" cy="32" r="27"/><circle class="dash-ring__fill" cx="32" cy="32" r="27" pathLength="100"/></svg>
          ${ic('dash', 'ic--lg hud-dash__icon')}
          <span class="hud-dash__block" aria-hidden="true"></span>
          <span class="hud-dash__cd num" data-state="dash-cooldown" data-bind="player.dashCooldown"></span>
          <kbd class="kbd hud-dash__key" data-bind="bind.dash.0"></kbd>
          <span data-bind-attr="class: player.airClass">Air</span>
        </div>
      </div>
    </div>

    <div class="hud-arms">
      <div class="belt hud-plate" aria-label="Grenade belt" data-state="belt">
        <div class="belt__head">
          <span class="belt__sel"><b data-bind="belt.selected"></b> <span class="num">×<span data-bind="belt.count"></span></span></span>
          <span class="keys"><kbd class="kbd" data-bind="bind.grenade.0"></kbd><span class="hud-label">Throw</span><kbd class="kbd" data-state="belt-many" data-bind="bind.cycleGrenade.0"></kbd><span class="hud-label" data-state="belt-many">Next</span></span>
        </div>
        <ul class="belt__list"></ul>
      </div>

      <div class="weapon-slot weapon-slot--off hud-plate" data-state="second-weapon">
        <span class="slot__idx" data-bind="weapon.1.slot"></span>
        <svg class="ic ic--wpn" aria-hidden="true" data-state="second-icon"><use data-bind-attr="href: weapon.1.icon"/></svg>
        <span class="slot__name" data-bind="weapon.1.name"></span>
        <span class="num slot__mini" data-bind="weapon.1.ammo"></span>
        <kbd class="kbd" data-bind="bind.swap.0"></kbd>
      </div>

      <div class="weapon-slot weapon-slot--on hud-plate" data-state="weapon">
        <div class="slot__top">
          <span class="slot__idx" data-bind="weapon.0.slot"></span>
          <span class="slot__name" data-bind="weapon.0.name"></span>
          <span class="badge badge--you" data-state="dual">Dual</span>
          <span class="slot__zoom">${ic('zoom', 'ic--sm')}<b class="num" data-bind="weapon.zoom"></b></span>
        </div>
        <div class="slot__ammo">
          <svg class="ic ic--wpn slot__wpn" aria-hidden="true" data-state="weapon-icon"><use data-bind-attr="href: weapon.0.icon"/></svg>
          <span class="ammo__mag num" data-bind="weapon.0.mag"></span>
          <span class="ammo__size num" data-state="gun">/ <span data-bind="weapon.0.magSize"></span></span>
          <span class="ammo__reserve num" data-state="gun"><span class="hud-label">Spare</span><b data-bind="weapon.0.reserve"></b></span>
        </div>
        <div class="slot__reload" data-state="reloading"><div class="bar bar--reload"><i></i></div><span class="hud-label">Reloading</span></div>
        <div class="slot__cue" data-state="low-ammo">${ic('warn', 'ic--sm')}<span>Low ammo</span><kbd class="kbd" data-bind="bind.reload.0"></kbd><span>Reload</span></div>
      </div>
    </div>

    <div class="pickup hud-plate" data-state="pickup" role="status">
      <svg class="ic ic--lg" aria-hidden="true"><use data-bind-attr="href: pickup.icon"/></svg>
      <span data-bind="pickup.text"></span>
    </div>

    <div class="respawn hud-plate" data-state="spectating" role="status">
      <p class="respawn__by"><span class="hud-label" data-bind="death.label"></span> <b data-bind="death.killer"></b> <svg class="ic ic--wpn" aria-hidden="true" data-state="death-weapon"><use data-bind-attr="href: death.icon"/></svg></p>
      <p class="respawn__timer"><span data-bind="death.lead"></span> <b class="num" data-bind="player.respawnIn"></b> <span data-bind="death.unit"></span></p>
      <div class="bar bar--respawn"><i></i></div>
    </div>

    <div class="flash-reduced__tag hud-plate mf-hud-flashed" data-state="flash-reduced">${ic('g-flash')}Flashed</div>
  </div>

  <div class="feedback" aria-hidden="true">
    <svg class="dmg-arcs" viewBox="-200 -200 400 400"></svg>
    <div class="reticle" data-state="reticle">
      ${RETICLE}
      <svg class="reticle__reload" data-state="reloading" viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" pathLength="100"/></svg>
      <svg class="marker-hit" data-state="hit-marker" viewBox="0 0 64 64"><path class="mk-u" d="M14 14l9 9M50 14l-9 9M14 50l9-9M50 50l-9-9"/><path class="mk-o" d="M14 14l9 9M50 14l-9 9M14 50l9-9M50 50l-9-9"/></svg>
      <svg class="marker-kill" data-state="kill-marker" viewBox="0 0 80 80"><path class="mk-u" d="M14 14l14 14M66 14L52 28M14 66l14-14M66 66L52 52"/><path class="mk-o" d="M14 14l14 14M66 14L52 28M14 66l14-14M66 66L52 52"/><path class="mk-d" d="M40 31l9 9-9 9-9-9z"/></svg>
    </div>
  </div>

  <div class="mf-board" data-state="board"><div class="mf-board__dim"></div><div class="scoreboard panel" role="dialog" aria-label="Scoreboard"></div></div>
</section>`;
}

function phone(): string {
  return `
<section class="screen screen--game screen--phone mf-hud-phone" data-screen="phone-hud" aria-label="Phone HUD">
  <div class="vignette vignette--hp" data-state="low-hp" aria-hidden="true"></div>
  <div class="hud phud">
    <div class="phud-vitals hud-plate" data-state="alive">
      <div class="phud-vital phud-vital--hp">${ic('hp', 'ic--sm')}<b class="num" data-bind="player.hp"></b><div class="bar bar--hp"><i></i></div></div>
      <div class="phud-vital phud-vital--fuel">${ic('fuel', 'ic--sm')}<b class="num" data-bind="player.fuel"></b><div class="bar bar--fuel"><i></i></div></div>
    </div>
    <ol class="phud-feed" aria-label="Kill feed"></ol>
    <div class="phud-match hud-plate" data-state="match"><b class="num" data-bind="match.timeLeft"></b><span class="num">You <b data-bind="match.myScore"></b> · <span data-bind="match.leaderShort"></span> <b data-bind="match.leaderScore"></b></span></div>
    <div class="phud-ammo hud-plate" data-state="weapon"><svg class="ic ic--wpn" aria-hidden="true" data-state="weapon-icon"><use data-bind-attr="href: weapon.0.icon"/></svg><b class="num" data-bind="weapon.0.mag"></b><span class="num" data-bind="weapon.0.tail"></span></div>
    <span data-state="net" data-bind-attr="class: net.phoneClass" data-bind="net.ping"></span>
    <div class="pickup hud-plate" data-state="pickup" role="status"><svg class="ic" aria-hidden="true"><use data-bind-attr="href: pickup.icon"/></svg><span data-bind="pickup.text"></span></div>
    <div class="respawn hud-plate" data-state="spectating" role="status">
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

/** The bars' numbers, as CSS variables on the HUD root (#hud, its data-bind-var): both layouts read them. */
export const HUD_VARS = '--hp: v.hp; --hp-ghost: v.hpGhost; --fuel: v.fuel; --fuel-delay: v.fuelDelay; --shield-hp: v.shield; --dash: v.dash; --reload: v.reload; --respawn: v.respawn; --event: v.event';

export function hudTemplate(): string {
  return `<div class="mf-fit mf-hud-fit kit-v1">${desktop()}</div><div class="mf-fit mf-hud-fit mf-hud-fit--phone kit-v1">${phone()}</div>`;
}
