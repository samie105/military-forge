/**
 * The HUD's markup. Layout only: values arrive through data-bind attributes (bind.ts) under the UI
 * brief's names, and the look is hud.css (tokens on `.hud`). A new design replaces this file and the
 * CSS; hud.ts and model.ts stay. Lists that grow and shrink (feed, banners, arcs, scoreboard) are
 * filled by hud.ts into the empty containers marked here.
 *
 *   top centre    match clock and score; the map event banner and announcements under it
 *   top right     kill feed                      top left    net graph (N)
 *   bottom left   health, shield, jet fuel, dash, conditions (EMP, blinded, gas)
 *   bottom right  weapons (ammo, reload ring), zoom, dual, the grenade belt
 *   bottom centre the pickup prompt              centre      damage arcs, kill confirmations, death card
 */
import { BELT } from './model';

function weaponSlot(i: number): string {
  const w = `weapons.${i}`;
  return `
    <div class="hud-weapon" data-bind-show="${w}.name" data-bind-state="${w}.state" data-bind-var="--reload: ${w}.reload">
      <div class="hud-ammo">
        <svg class="hud-ring" viewBox="0 0 44 44" aria-hidden="true">
          <circle class="hud-ring-track" cx="22" cy="22" r="19" pathLength="1"></circle>
          <circle class="hud-ring-fill" cx="22" cy="22" r="19" pathLength="1"></circle>
        </svg>
        <b class="hud-mag" data-bind="${w}.mag"></b>
      </div>
      <div class="hud-weapon-info">
        <span class="hud-weapon-name" data-bind="${w}.name"></span>
        <span class="hud-reserve" data-bind="${w}.reserve"></span>
        <span class="hud-weapon-note" data-bind="${w}.note"></span>
      </div>
    </div>`;
}

function beltSlot(i: number): string {
  const g = `grenades.${i}`;
  return `
      <span class="hud-belt-slot hud-belt-${BELT[i]!.id}" data-bind-show="${g}.present" data-bind-state="${g}.state">
        <i class="hud-belt-icon"></i><b data-bind="${g}.count"></b><small data-bind="${g}.name"></small>
      </span>`;
}

export function hudTemplate(): string {
  return `
  <div class="hud-top" data-bind-show="match.on">
    <div class="hud-timer" data-bind="match.timeLeft"></div>
    <div class="hud-score" data-bind="match.score"></div>
  </div>
  <div class="hud-center-stack">
    <div class="hud-event" data-bind-show="event.title" data-bind-state="event.phase" data-bind-var="--hud-event: event.color">
      <div class="hud-event-title"><span data-bind="event.title"></span><span class="hud-event-in" data-bind="event.in"></span></div>
      <div class="hud-event-line"><span data-bind="event.line"></span><span class="hud-event-left" data-bind="event.left"></span></div>
    </div>
    <div class="hud-banners"></div>
  </div>
  <ol class="hud-feed"></ol>
  <pre class="hud-net" data-bind-show="net.on" data-bind="net.text"></pre>

  <div class="hud-vitals">
    <div class="hud-meter hud-hp" data-bind-state="player.hpState" data-bind-var="--fill: player.hpFill">
      <div class="hud-meter-head"><span class="hud-label">Health</span><span class="hud-meter-note" data-bind="player.regen"></span><b class="hud-num" data-bind="player.hp"></b></div>
      <div class="hud-bar"><i class="hud-fill"></i></div>
    </div>
    <div class="hud-meter hud-shield" data-bind-show="player.shield.hp" data-bind-state="player.shield.state" data-bind-var="--fill: player.shield.fill">
      <div class="hud-meter-head"><span class="hud-label">Shield</span><span class="hud-meter-note" data-bind="player.shield.label"></span><b class="hud-num-small" data-bind="player.shield.hp"></b><kbd data-bind="keys.shield"></kbd></div>
      <div class="hud-bar hud-bar-thin"><i class="hud-fill"></i></div>
    </div>
    <div class="hud-meter hud-fuel" data-bind-state="player.fuelState" data-bind-var="--fill: player.fuel; --delay-at: player.fuelDelayAt; --delay: player.fuelDelay; --ignite: player.ignite">
      <div class="hud-meter-head"><span class="hud-label">Jet fuel</span><span class="hud-meter-note" data-bind="player.fuelNote"></span></div>
      <div class="hud-bar hud-bar-thin"><i class="hud-fill"></i><i class="hud-delay"></i><i class="hud-ignite"></i></div>
    </div>
    <div class="hud-dash" data-bind-state="player.dashState" data-bind-var="--fill: player.dashCooldown">
      <kbd data-bind="keys.dash"></kbd><span class="hud-label">Dash</span><span class="hud-dash-bar"><i class="hud-fill"></i></span><span class="hud-meter-note" data-bind="player.dashNote"></span>
    </div>
    <div class="hud-conditions">
      <span class="hud-chip hud-chip-emp" data-bind-show="player.jetDisabled" data-bind="player.jetDisabled"></span>
      <span class="hud-chip hud-chip-blind" data-bind-show="player.blindNote" data-bind="player.blindNote" data-bind-var="--blind: player.blind"></span>
      <span class="hud-chip hud-chip-gas" data-bind-show="player.inGas" data-bind="player.inGas"></span>
    </div>
  </div>

  <div class="hud-loadout">
    ${weaponSlot(0)}
    ${weaponSlot(1)}
    <div class="hud-extras">
      <span class="hud-zoom" data-bind="weapons.zoom"></span>
      <span class="hud-dual" data-bind-show="weapons.dual">Dual</span>
    </div>
    <div class="hud-belt" data-bind-state="grenades.state">
      <kbd data-bind="keys.grenade"></kbd>${BELT.map((_, i) => beltSlot(i)).join('')}
      <kbd class="hud-belt-cycle" data-bind-show="grenades.cycle" data-bind="keys.cycle"></kbd>
    </div>
  </div>

  <div class="hud-pickup" data-bind-show="pickup.prompt"><span data-bind="pickup.prompt"></span></div>
  <div class="hud-arcs" data-bind-var="--x: arcs.x; --y: arcs.y"></div>
  <div class="hud-confirm"></div>
  <div class="hud-death" data-bind-show="death.on">
    <div class="hud-death-by" data-bind="death.by"></div>
    <div class="hud-death-timer" data-bind="death.timer"></div>
  </div>
  <div class="hud-vignette" data-bind-var="--level: vignette"></div>
  <div class="hud-board"></div>`;
}
