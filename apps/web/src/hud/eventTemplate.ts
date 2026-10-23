/**
 * The map event's sequence on screen (owner, 23 Oct: "when something is happening like the surge …
 * a more better ui since it's a game"), the same markup in both HUD screens (template.ts on the
 * desktop, templatePhone.ts on the phone; hud.css sizes each). Stages are state tokens from
 * model.ts's EventTimeline through hudFrame:
 *
 *   ev-warning   the warning under the clock: a hazard head, the kind's icon, its name and one-line
 *                effect, and a countdown digit that stamps each second in a draining ring (--ev-warn)
 *   ev-impact    the moment it starts: the name stamped across the upper third between two shock
 *                lines (EVENT_IMPACT_MS), then
 *   ev-active    a compact strip under the clock: icon, name, the effect in a few words, the seconds
 *                left (P4) and a bar that drains (--event)
 *   ev-end       the all-clear chip ("Gravity surge over · Gravity back to normal") for EVENT_END_MS
 *
 * The screen treatment (eventFxTemplate) sits under the HUD plates: hazard tape and an amber edge in
 * the warning, then one look per kind (data-kind: gravitySurge, lowGravity, emp, fog, gust, flip,
 * custom) while it runs, fading out with the all-clear. Transform and opacity only.
 */

const ic = (name: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

/** The kind's icon in its colour, with a small arrow for which way gravity goes (surge, low gravity, flip). */
const EVENT_ICON = `<span class="mf-ev__ic"><svg class="ic mf-ev__glyph" aria-hidden="true"><use data-bind-attr="href: event.icon"/></svg><span class="mf-ev__arrow" data-bind-show="event.arrow"><svg class="ic ic--sm" aria-hidden="true"><use data-bind-attr="href: event.arrow"/></svg></span></span>`;

export function eventTemplate(): string {
  return `
<div class="mf-ev" data-bind-var="--ev: event.color; --ev-warn: v.evWarn">
  <div class="mf-evw m-p9" data-state="ev-warning" role="status">
    <div class="mf-evw__head"><span>${ic('warn', 'ic--sm')}Incoming · map event</span><span>Brace</span></div>
    <div class="mf-evw__body">
      ${EVENT_ICON}
      <span class="mf-evw__text"><b class="display mf-evw__name" data-bind="event.name"></b><span class="mf-evw__desc" data-bind="event.description"></span><span class="mf-evw__effect" data-bind="event.effect"></span></span>
      <span class="mf-evw__count" aria-label="Seconds to go"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="mf-evw__track" cx="50" cy="50" r="44"/><circle class="mf-evw__drain" cx="50" cy="50" r="44" pathLength="100"/></svg><b data-bind="event.count" data-bind-attr="class: event.countClass"></b></span>
    </div>
  </div>
  <div class="mf-evi" data-state="ev-impact" aria-hidden="true">
    <i class="mf-evi__line"></i>
    <b class="display mf-evi__name" data-bind="event.name"></b>
    <span class="mf-evi__now">Now · <span data-bind="event.effect"></span></span>
    <i class="mf-evi__line"></i>
  </div>
  <div class="mf-eva m-p9" data-state="ev-active" role="status">
    <div class="mf-eva__row">
      ${EVENT_ICON}
      <span class="mf-eva__text"><b data-bind="event.name"></b><span data-bind="event.effect"></span></span>
      <b class="mf-eva__time num"><span data-bind-roll="event.timeLeft"></span> s</b>
    </div>
    <div class="mf-eva__bar" aria-hidden="true"><i></i></div>
  </div>
  <div class="mf-eve m-p9" data-state="ev-end" role="status">
    <span class="mf-eve__ic">${ic('check')}</span>
    <span class="mf-eva__text"><b data-bind="event.over"></b><span data-bind="event.endLine"></span></span>
    <span class="mf-eve__clear">All clear</span>
  </div>
</div>`;
}

/** The screen treatment layer: under the HUD's plates, over the world (z: the vignettes'). */
export function eventFxTemplate(): string {
  return `<div class="mf-evfx" data-state="ev-shown" data-bind-attr="data-kind: event.fx; data-stage: event.stage" aria-hidden="true"><i class="mf-evfx__tint"></i><i class="mf-evfx__l"></i><i class="mf-evfx__r"></i><i class="mf-evfx__x"></i></div>`;
}
