/**
 * The HUD's markup. The desktop is round two's "In-match HUD" (docs/design/military-forge-ui-v2.html,
 * 1920×1080, its scoreboard and map-event banner with it); the phone is still the first kit's
 * "14 · Phone HUD" (812×375, while the touch controls are up), the phone UI agent's to port.
 * Values arrive through attributes (bind.ts, state.ts):
 *
 *   data-bind="player.hp"            text
 *   data-bind-roll="match.myScore"   text whose changed digits roll (the motion system's P4)
 *   data-bind-attr="href: key"       an attribute (icons: <use href>, classes)
 *   data-bind-var="--x: key"         a CSS variable
 *   data-state="low-hp"              shown while that token is active on the root ("a+!b": a and not b)
 *
 * Bars and rings read the CSS variables on the HUD root (--hp, --hp-ghost, --fuel, --fuel-delay,
 * --shield-hp, --dash, --reload, --respawn, --event, --equip, --throw): one number each, never a
 * width. The lists that come and go (kill feed, banners, damage arcs, the belt, the scoreboard) are
 * filled by hud.ts into the empty containers marked here.
 */

import { eventFxTemplate, eventTemplate } from './eventTemplate';
import { phoneHudTemplate } from './templatePhone';


const ic = (name: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

/** A weapon glyph whose href is bound (`key`): weapons are 64×24, the tip lit with --c-tip. */
const wpn = (key: string, cls = 'ic--wpn') => `<svg class="${cls}" aria-hidden="true"><use data-bind-attr="href: ${key}"/></svg>`;

/** The quick stat compare under a crate (pickup-crate): the held gun against the one on the floor. */
const CMP_ROWS: readonly [label: string, key: string][] = [
  ['Damage', 'damage'],
  ['Fire rate', 'rate'],
  ['Range', 'range'],
  ['Weight', 'weight'],
  ['Mag', 'mag'],
];

/**
 * Round two's desktop HUD (docs/design/military-forge-ui-v2.html, data-screen="hud"): the kit's
 * markup with its bindings; parts the game has no data for yet (spectating someone, the gun's
 * finish, the stagger cue) are left out (the phase 2 PR lists them).
 */
function desktop(): string {
  const cmp = CMP_ROWS.map(
    ([label, k]) =>
      `<tr data-bind-var="--a: pickup.bar.${k}.a; --b: pickup.bar.${k}.b"><th>${label}</th><td class="num" data-bind="pickup.held.stats.${k}"></td><td class="cmp__bars"><i class="cmp__a"></i><i class="cmp__b"></i></td><td class="num" data-bind="pickup.weapon.stats.${k}"></td><td data-bind-attr="class: pickup.delta.${k}.class"><svg class="ic ic--sm" aria-hidden="true"><use data-bind-attr="href: pickup.delta.${k}.icon"/></svg><span data-bind="pickup.delta.${k}.text"></span></td></tr>`,
  ).join('');
  return `
<section class="screen screen--game mf-hud-desktop" data-screen="hud" aria-label="In-match HUD">
  <div class="vignette vignette--hp" data-state="low-hp" aria-hidden="true"></div>
  <div class="vignette vignette--gas" data-state="gas" aria-hidden="true"></div>
  <div class="vignette vignette--stagger" data-state="heavy-hit" aria-hidden="true"></div>
  <div class="blood" data-state="blood-on+low-hp blood-on+heavy-hit blood-on+hurt" aria-hidden="true"></div>
  ${eventFxTemplate()}
  <div class="mf-world" aria-hidden="true"></div>

  <div class="hud" role="group" aria-label="Match HUD">
    <div class="hud-tl">
      <div class="hud-net plate" data-state="fps"><span class="num" data-bind="fps.value"></span><span class="hud-net__loss">fps</span></div>
      <div class="hud-net plate" data-state="net" data-bind-attr="title: net.detail; data-detail: net.detail; data-tone: net.tone"><span class="sig" data-bind-attr="class: net.sig" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="num" data-bind="net.ping"></span><span class="hud-net__jit num" data-bind="net.jitter"></span><span class="hud-net__loss num"><span data-bind="net.loss"></span> loss</span><span class="hud-net__via" data-bind="net.via" data-bind-attr="title: net.viaTitle"></span></div>
      <div class="tuned plate mf-hud-admin" data-state="admin" title="This server runs its own gameplay settings">${ic('sliders', 'ic--sm')}<b>Tuned by admin</b></div>
      <div class="tuned plate m-p7" data-state="tuned">${ic('sliders', 'ic--sm')}<b>Tuned by host</b><span data-bind="match.tunedSummary"></span></div>
    </div>

    <div class="hud-match">
      <div class="hud-clock plate" data-state="match" data-tour="clock"><span class="hud-label" data-bind="match.mode"></span><b class="hud-clock__time num" data-bind-roll="match.timeLeft"></b><span class="hud-label" data-bind="match.limit"></span></div>
      <div class="hud-score" data-state="match" data-tour="scores">
        <div class="hud-score__cell plate is-you"><span class="hud-label">You</span><b class="num" data-bind-roll="match.myScore"></b></div>
        <div class="hud-score__cell plate"><span class="hud-label">Lead · <span data-bind="match.leaderShort"></span></span><b class="num" data-bind-roll="match.leaderScore"></b></div>
      </div>
      <div class="mf-hud-banners" aria-live="polite"></div>
    </div>

    <ol class="killfeed" aria-label="Kill feed" aria-live="polite"></ol>

    <div class="hud-bl">
      <div class="cue cue--hp plate" data-state="low-hp">${ic('hp')}<span><b>Low health</b><span data-bind="player.hpCue"></span></span></div>
      <div class="cue cue--gas plate" data-state="gas">${ic('b-gas')}<span><b>Toxic gas</b> · <span data-bind="player.gasCue"></span></span></div>
      <div class="cue cue--emp plate" data-state="emp">${ic('ev-emp')}<span><b>Jetpack offline</b> · <span data-bind="player.empCause"></span></span><b class="num" data-bind="player.jetDisabled"></b></div>
      <div class="cue cue--burn plate" data-state="burning">${ic('flame')}<span><b>On fire</b> · <span data-bind="player.burnCue"></span></span></div>
      <div class="cue cue--launch plate" data-state="launched">${ic('b-launch')}<span><b>Launched</b> by <span data-bind="hit.by"></span> · fly to recover</span></div>
      <div class="shieldbox plate" data-state="shield">
        <svg class="ic ic--lg ic--fill" aria-hidden="true"><use href="#icon-wpn-shield"/></svg>
        <div class="shieldbox__body">
          <div class="shieldbox__top"><span class="hud-label">Riot shield</span><b data-bind="player.shield.state"></b><span class="num"><b data-bind="player.shield.hp"></b>/<span data-bind="player.shield.max"></span></span></div>
          <div class="bar bar--shield" aria-hidden="true"><i></i></div>
          <span class="hud-label"><span data-bind="player.shield.covers"></span> · <kbd class="kbd" data-bind="bind.shield.0"></kbd> <span data-bind="player.shield.action"></span></span>
        </div>
      </div>
      <div class="hud-bl__row">
        <div class="vitals plate">
          <div class="vital vital--hp">${ic('hp')}<b class="vital__num num" data-bind="player.hp"></b>
            <div class="bar bar--hp" role="meter" aria-label="Health" aria-valuemin="0" aria-valuemax="100" data-bind-attr="aria-valuenow: player.hp"><i class="bar__ghost"></i><i class="bar__fill"></i><span class="bar__ticks"></span></div></div>
          <div class="vital vital--fuel" data-tour="fuel">${ic('fuel')}<b class="vital__num num" data-bind="player.fuel"></b>
            <div class="vital__stack"><div class="bar bar--fuel" role="meter" aria-label="Fuel" aria-valuemin="0" aria-valuemax="100" data-bind-attr="aria-valuenow: player.fuel"><i></i><span class="mf-fuel__cost" aria-hidden="true"></span><span class="mf-fuel__tick" aria-hidden="true"></span></div><div class="bar bar--delay" aria-hidden="true"><i></i></div></div></div>
        </div>
        <div class="dash plate" aria-label="Dash" data-tour="dash">
          <svg class="dash__ring" viewBox="0 0 100 100" aria-hidden="true">
            <g class="dash__rose">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<path transform="rotate(${a} 50 50)" d="M50 2v6"/>`).join('')}</g>
            <path class="dash__dir" data-state="dash-hint" data-bind-attr="transform: dash.hintRotate" d="M50 0v10"/>
          </svg>
          <svg class="ic ic--lg dash__icon" aria-hidden="true"><use href="#icon-dash"/></svg>
          <div class="dash__foot"><kbd class="kbd" data-bind="bind.dash.0"></kbd><span class="dash__air" aria-label="Dashes the fuel buys" data-bind="dash.left"></span></div>
          <span class="dash__hint" data-state="dash-hint" data-bind-var="--hint-rot: dash.hintArrow">${ic('arrow-right', 'ic--sm')}<span data-bind="dash.hintDir"></span></span>
        </div>
      </div>
    </div>

    <div class="hud-br">
      <div class="belt plate" aria-label="Grenade belt" data-state="belt" data-tour="belt">
        <div class="belt__head"><span class="belt__sel"><b data-bind="grenades.selected"></b> <span class="num"><span data-bind-roll="grenades.count"></span>/<span data-bind="grenades.max"></span></span></span>
          <span class="belt__keys"><kbd class="kbd" data-bind="bind.grenade.0"></kbd><span>tap · hold aims</span><kbd class="kbd" data-state="belt-many" data-bind="bind.cycleGrenade.0"></kbd><span data-state="belt-many">next</span></span></div>
        <div class="mf-belt"><ul class="belt__list"></ul><i class="m-p5 mf-belt__sel" aria-hidden="true"></i></div>
      </div>
      <div class="slots">
        <div class="slot slot--slung plate" data-state="slung" aria-label="The other slot, on your back">
          <span class="slot__back">${ic('backpack', 'ic--sm')}<span class="hud-label">On back</span></span>
          <span class="slot__wpn-sm"><svg class="ic--wpn" aria-hidden="true" data-state="slung-item"><use data-bind-attr="href: player.slot.1.icon"/></svg><span class="slot__none" data-state="slung-empty">Empty</span></span>
          <b class="slot__name-sm" data-bind="player.slot.1.name"></b>
          <span class="num slot__mini" data-state="slung-gun"><span data-bind="player.slot.1.mag"></span>/<span data-bind="player.slot.1.reserve"></span></span>
          <kbd class="kbd" data-bind="bind.swap.0"></kbd>
        </div>
        <div class="slot slot--held plate" data-state="weapon" data-tour="ammo">
          <i class="mf-drawbar" data-state="switching" aria-hidden="true"></i>
          <div class="slot__top">
            <span class="slot__idx" data-bind="player.slot.0.idx"></span>
            <b class="slot__name" data-bind="player.slot.0.name"></b>
            <span class="tag tag--paper" data-state="dual">Dual</span>
            <span class="slot__fam hud-label" data-bind="player.slot.0.family"></span>
            <span class="slot__zoom hud-label">${ic('zoom', 'ic--sm')}<b class="num" data-bind="weapon.zoom"></b></span>
          </div>
          <div class="slot__main">
            <span class="slot__art">
              <span class="mf-ghosts" data-state="switching+!dual" aria-hidden="true">${wpn('player.slot.0.icon', 'ic--wpn-lg mf-ghost')}${wpn('player.slot.0.icon', 'ic--wpn-lg mf-ghost mf-ghost--2')}</span>
              <svg class="ic--wpn-lg" aria-hidden="true" data-state="!dual"><use data-bind-attr="href: player.slot.0.icon"/></svg>
              <span class="slot__dual" data-state="dual">${wpn('player.slot.0.icon', 'ic--wpn-lg')}${wpn('player.dual.icon', 'ic--wpn-lg')}</span>
              <span class="equip" data-state="switching" role="progressbar" aria-label="Drawing" aria-valuemin="0" aria-valuemax="1">
                <svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="24" class="equip__track"/><circle cx="30" cy="30" r="24" pathLength="100" class="equip__fill"/></svg>
                <b class="num" data-bind="player.slot.0.equipLeft"></b>
              </span>
            </span>
            <span class="ammo" data-state="gun+!dual">
              <b class="ammo__mag num" data-bind-roll="player.slot.0.mag"></b><span class="ammo__size num">/<span data-bind="player.slot.0.magSize"></span></span>
              <span class="ammo__res"><span class="hud-label">Spare</span><b class="num" data-bind="player.slot.0.reserve"></b></span>
            </span>
            <span class="ammo ammo--dual" data-state="dual">
              <span><span class="hud-label">L</span><b class="ammo__mag num" data-bind-roll="player.slot.0.magL"></b></span><span><span class="hud-label">R</span><b class="ammo__mag num" data-bind-roll="player.slot.0.magR"></b></span>
              <span class="ammo__res"><span class="hud-label">Spare</span><b class="num" data-bind="player.slot.0.reserve"></b></span>
            </span>
            <span class="ammo ammo--melee" data-state="melee"><span class="hud-label" data-state="melee-only">Melee only</span><span class="hud-label" data-state="!melee-only">Melee</span><b><kbd class="kbd" data-bind="bind.fire.0"></kbd> Swing</b></span>
          </div>
          <div class="slot__cue slot__cue--windup" data-state="windup">${ic('bolt', 'ic--sm')}<b data-bind="player.slot.0.windup"></b><span>keep holding</span><kbd class="kbd" data-bind="bind.fire.0"></kbd></div>
          <div class="slot__cue slot__cue--reload" data-state="reloading"><div class="bar bar--reload"><i></i></div><span class="hud-label">Reloading</span></div>
          <div class="slot__cue slot__cue--low" data-state="low-ammo">${ic('warn', 'ic--sm')}<b>Low ammo</b><kbd class="kbd" data-bind="bind.reload.0"></kbd><span>Reload</span></div>
          <div class="slot__cue slot__cue--empty" data-state="empty">${ic('empty', 'ic--sm')}<b>Empty</b><kbd class="kbd" data-bind="bind.reload.0"></kbd><span>Reload</span><kbd class="kbd" data-bind="bind.swap.0"></kbd><span>Swap</span></div>
          <div class="slot__cue slot__cue--switch mf-drawcue" data-state="switching swap-hint">${ic('swap', 'ic--sm')}<b class="mf-drawcue__kick" data-state="switching">Drawing</b><b class="mf-drawcue__kick mf-drawcue__kick--ready" data-state="!switching">Ready</b><span class="mf-drawcue__what" data-bind="player.slot.0.fire"></span><span class="mf-drawcue__back" data-state="slung-item"><kbd class="kbd" data-bind="bind.swap.0"></kbd><span>back to <b data-bind="player.slot.1.name"></b></span></span></div>
          <div class="slot__cue slot__cue--melee" data-state="melee-only">${ic('crate', 'ic--sm')}<span>No guns left · find a crate</span></div>
        </div>
      </div>
    </div>

    <div class="mf-drawcard plate" data-state="switching+!dual drawn+!dual" role="status" aria-label="Drawing">
      <span class="mf-drawcard__kick"><b data-state="switching">Drawing</b><b class="mf-drawcard__ready" data-state="!switching">Ready</b><span class="mf-drawcard__slot">Slot <span data-bind="player.slot.0.idx"></span></span></span>
      <span class="mf-drawcard__art">${wpn('player.slot.0.icon', 'ic--wpn-lg mf-drawcard__ghost')}${wpn('player.slot.0.icon', 'ic--wpn-lg mf-drawcard__gun')}</span>
      <span class="mf-drawcard__id"><b class="display mf-drawcard__name" data-bind="player.slot.0.name"></b><span class="mf-chip" data-bind="player.slot.0.family"></span></span>
      <span class="mf-drawcard__ammo" data-state="gun+stats-open"><b class="display num" data-bind="player.slot.0.mag"></b><span class="num">/<span data-bind="player.slot.0.magSize"></span></span><span class="mf-drawcard__res"><span class="hud-label">Spare</span><b class="num" data-bind="player.slot.0.reserve"></b></span></span>
      <span class="mf-drawcard__ammo" data-state="melee+stats-open"><b class="display">Blade</b></span>
      <span class="mf-drawcard__foot"><button type="button" class="mf-statsbtn" data-hud-stats tabindex="-1" aria-label="Show or hide the gun's stats"><kbd class="kbd" data-bind="bind.stats.0"></kbd><span data-state="!stats-open">Stats</span><span data-state="stats-open">Hide stats</span></button><span data-state="stats-open" data-bind="player.slot.0.fire"></span><span data-state="slung-item"><kbd class="kbd" data-bind="bind.swap.0"></kbd> tap: back to <b data-bind="player.slot.1.name"></b> · hold: quick-select</span></span>
      <i class="mf-drawcard__bar" aria-hidden="true"></i>
    </div>

    <div class="mf-loadout" data-state="weapon+!spectating" aria-label="Loadout"><ol class="mf-loadout__guns"></ol><ol class="mf-loadout__nades"></ol></div>

    <div class="pickup plate m-p9 m-p9--bottom mf-cmpcard" data-state="pickup-crate" role="status" data-bind-attr="data-power: pickup.weapon.power">
      <div class="pickup__head mf-cmpcard__head">
        <span class="pickup__key"><svg class="mf-keyring" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/></svg><kbd class="kbd kbd--lg" data-bind="bind.interact.0"></kbd></span>
        <span class="mf-cmpcard__title"><span class="mf-cmpcard__verb" data-bind="pickup.verb"></span><span class="mf-cmpcard__name"><b class="display" data-bind="pickup.weapon.name"></b><span class="mf-chip m-p7" data-bind="pickup.weapon.family"></span></span></span>
        <span class="mf-cmpcard__gun m-p7">${wpn('pickup.weapon.icon', 'ic--wpn mf-cmpcard__wpn')}</span>
      </div>
      <p class="mf-cmpcard__swap"><span class="mf-cmpcard__for" data-state="pickup-swaps">${ic('swap', 'ic--sm')}for your <b data-bind="pickup.held.name"></b></span><button type="button" class="mf-statsbtn" data-hud-stats tabindex="-1" aria-label="Show or hide the gun's stats"><kbd class="kbd" data-bind="bind.stats.0"></kbd><span data-state="!stats-open">Stats</span><span data-state="stats-open">Hide stats</span></button></p>
      <p class="mf-cmpcard__sub" data-state="stats-open"><span data-bind="pickup.weapon.fire"></span><span data-bind="pickup.weapon.magWords"></span></p>
      <table class="cmp" data-state="pickup-cmp+stats-open" aria-label="The gun in your hand against the one here">
        <thead><tr><th class="vh">Stat</th><th data-bind="pickup.held.name"></th><th class="vh">Bars</th><th data-bind="pickup.weapon.name"></th><th class="vh">Change</th></tr></thead>
        <tbody>${cmp}</tbody>
      </table>
    </div>
    <div class="pickup plate m-p9 m-p9--bottom mf-pickup-item" data-state="pickup-item" role="status" data-bind-attr="data-tone: pickup.item.tone">
      <div class="pickup__head"><span class="mf-item__ic m-p7"><svg class="ic ic--lg" aria-hidden="true"><use data-bind-attr="href: pickup.icon"/></svg></span><span class="mf-item__text"><b data-bind="pickup.item.title"></b><span data-bind="pickup.item.line"></span></span></div>
    </div>

    <div class="respawn plate" data-state="spectating" role="status">
      <p class="respawn__by"><span class="hud-label" data-bind="death.label"></span> <b data-bind="death.killer"></b><svg class="ic--kf" aria-hidden="true" data-state="death-weapon"><use data-bind-attr="href: death.icon"/></svg></p>
      <p class="respawn__timer"><span data-bind="death.lead"></span> <b data-bind="player.respawnIn" data-bind-attr="class: death.numClass"></b> <span data-bind="death.unit"></span></p>
      <div class="bar bar--respawn"><i></i></div>
    </div>

    <div class="mf-kc" data-state="kill-confirm" role="status">
      <span class="mf-kc__tag">${ic('target', 'ic--sm')}Taken out</span>
      <b data-bind="kill.victim" data-bind-attr="class: kill.class"></b>
      <span class="mf-kc__more"><span class="mf-kc__head" data-state="kill-head">${ic('b-headshot', 'ic--sm')}Headshot</span><span class="mf-kc__streak" data-bind-show="kill.streak" data-bind="kill.streak"></span></span>
    </div>

    <div class="mf-spec plate m-p9 m-p9--bottom" data-state="spectate-bar" role="group" aria-label="Spectating">
      <button type="button" class="mf-spec__nav" data-spec="prev" aria-label="Previous soldier">${ic('chev-left', 'ic--sm')}Prev<kbd class="kbd">Q</kbd></button>
      <span class="mf-spec__who" role="status"><span class="hud-label" data-bind="spectate.label"></span><b class="display" data-bind="spectate.name"></b><i class="mf-spec__hp" data-state="spec-target" aria-hidden="true"></i><span class="mf-spec__line" data-bind="spectate.line"></span></span>
      <button type="button" class="mf-spec__nav" data-spec="next" aria-label="Next soldier"><kbd class="kbd">E</kbd>Next${ic('chev-right', 'ic--sm')}</button>
      <span class="mf-spec__sep" data-state="spec-watch" aria-hidden="true"></span>
      <button type="button" class="mf-spec__free" data-spec="free" data-state="spec-watch"><span data-bind="spectate.freeLabel"></span><kbd class="kbd">F</kbd></button>
      <span class="mf-spec__slot hud-label" data-state="spec-slot+spec-watch+!spec-queued">A slot is free</span>
      <button type="button" class="mf-spec__join" data-spec="join" data-state="spec-watch" data-bind-attr="data-queued: spectate.queued">${ic('play', 'ic--sm')}<span data-bind="spectate.join"></span><kbd class="kbd">↵</kbd></button>
    </div>
    <div class="mf-spec-tags" data-state="spec-watch" aria-hidden="true">
      <span class="mf-spec-tag plate"><i class="mf-spec-dot"></i>Spectating</span>
      <span class="mf-spec-tag mf-spec-tag--delay plate" data-bind-show="spectate.delay"><i class="mf-spec-dot"></i><span data-bind="spectate.delay"></span></span>
    </div>
    <div class="mf-spec-tag mf-spec-tag--eyes plate" data-state="spectate-bar" data-bind-show="spectate.watching" aria-hidden="true">${ic('eye', 'ic--sm')}<span data-bind="spectate.watching"></span></div>
  </div>

  ${eventTemplate()}

  <div class="mf-qs" data-state="quick-open" role="dialog" aria-label="Quick-select: point and let go">
    <div class="mf-qs__ring" aria-hidden="true"><i class="mf-qs__pointer"></i></div>
    <div class="mf-qs__items"></div>
    <div class="mf-qs__hub plate"><span class="hud-label">Quick-select</span><b class="display mf-qs__name" data-bind="quick.name"></b><span class="mf-qs__line" data-bind="quick.line"></span><span class="mf-qs__how"><kbd class="kbd" data-bind="bind.swap.0"></kbd> let go to take<span class="mf-qs__mouse"> · wheel steps · click takes it</span><span class="mf-qs__pad"> · the aim stick points</span></span></div>
  </div>

  <div class="feedback" aria-hidden="true">
    <svg class="dmg" viewBox="-400 -400 800 800"></svg>
    <div class="reticle" data-state="reticle">
      <svg class="reticle__x" viewBox="0 0 48 48"><g class="u"><path d="M24 6v10M24 32v10M6 24h10M32 24h10"/><circle cx="24" cy="24" r="2"/></g><g class="o"><path d="M24 6v10M24 32v10M6 24h10M32 24h10"/><circle cx="24" cy="24" r="2"/></g></svg>
      <svg class="reticle__ring" data-state="reloading" viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" pathLength="100"/></svg>
      <svg class="mk mk--hit mf-mk" data-state="hit+!headshot+!ricochet+!launch-mark" viewBox="0 0 64 64"><path class="u" d="M14 14l9 9M50 14l-9 9M14 50l9-9M50 50l-9-9"/><path class="o" d="M14 14l9 9M50 14l-9 9M14 50l9-9M50 50l-9-9"/></svg>
      <span class="mk mk--head mf-mk" data-state="headshot"><svg viewBox="0 0 64 64"><path class="u" d="M10 10l12 12M54 10L42 22M10 54l12-12M54 54L42 42"/><path class="o" d="M10 10l12 12M54 10L42 22M10 54l12-12M54 54L42 42"/></svg><span class="mk__tag mk__tag--head">${ic('b-headshot', 'ic--sm')}Head</span></span>
      <span class="mk mk--rico mf-mk" data-state="ricochet"><svg viewBox="0 0 64 64"><path class="u" d="M14 14l9 9M50 14l-9 9M20 46l6-12 8 6 6-12"/><path class="o" d="M14 14l9 9M50 14l-9 9M20 46l6-12 8 6 6-12"/></svg><span class="mk__tag">${ic('shield', 'ic--sm')}Ricochet</span></span>
      <span class="mk mk--launch mf-mk" data-state="launch-mark"><svg viewBox="0 0 64 64"><path class="u" d="M14 50C20 30 32 20 50 16M42 10l8 6-6 8"/><path class="o" d="M14 50C20 30 32 20 50 16M42 10l8 6-6 8"/></svg><span class="mk__tag">${ic('b-launch', 'ic--sm')}Launched</span></span>
      <svg class="mk mk--kill m-p7" data-state="kill" viewBox="0 0 80 80"><path class="u" d="M14 14l14 14M66 14L52 28M14 66l14-14M66 66L52 52"/><path class="o" d="M14 14l14 14M66 14L52 28M14 66l14-14M66 66L52 52"/><path class="d" d="M40 31l9 9-9 9-9-9z"/></svg>
      <div class="throw m-p1" data-state="aiming">
        <svg viewBox="0 0 120 120"><path class="throw__track" d="M60 10a50 50 0 0 1 0 100" pathLength="100"/><path class="throw__fill" d="M60 110a50 50 0 0 1 0-100" pathLength="100"/></svg>
        <span class="throw__lbl"><svg class="ic ic--fill ic--sm" aria-hidden="true"><use data-bind-attr="href: grenades.icon"/></svg><b class="num" data-bind="grenades.throwPercent"></b></span>
      </div>
      <div class="arcwarn" data-state="aiming+arc-warning">${ic('warn', 'ic--sm')}<b>Arc bends</b><span data-bind="grenades.arcCause"></span></div>
      <div class="quick m-p7" data-state="quick-throw"><span class="quick__burst" aria-hidden="true"></span><span class="quick__tag"><svg class="ic ic--fill ic--sm" aria-hidden="true"><use data-bind-attr="href: grenades.icon"/></svg>Quick throw</span></div>
    </div>
  </div>

  <div class="flash-reduced__tag plate mf-hud-flashed" data-state="flash-reduced">${ic('g-flash', 'ic--fill ic--sm')}Flashed</div>

  <div class="mf-board" data-state="board"><div class="cd__dim mf-board__dim"></div><div class="sb plate m-p1" role="dialog" aria-label="Scoreboard"></div></div>
</section>`;
}

/** The bars' numbers, as CSS variables on the HUD root (#hud, its data-bind-var): both layouts read them. */
export const HUD_VARS = '--spec-hp: v.specHp; --hp: v.hp; --hp-ghost: v.hpGhost; --fuel: v.fuel; --fuel-delay: v.fuelDelay; --shield-hp: v.shield; --dash: v.dash; --dash-cost: v.dashCost; --reload: v.reload; --respawn: v.respawn; --event: v.event; --equip: v.equip; --equip-ms: v.equipMs; --throw: v.throw';

export function hudTemplate(): string {
  return `<div class="mf-fit mf-hud-fit kit-v2">${desktop()}</div><div class="mf-fit mf-hud-fit mf-hud-fit--phone kit-v2">${phoneHudTemplate()}</div>`;
}
