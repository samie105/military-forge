/**
 * The first-run controls card (the app's own, in the kit's panel and keycaps): every main action
 * with the player's own keys, a few tips, and the way to Settings → Controls. It shows the first
 * time a player gets into a game, and from the in-match menu.
 */
import { capText } from '../../ui/icons';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Screen, blurAfter } from '../../ui/Screen';
import { useCtl, useKeyboardLayout } from '../context';
import type { ActionId } from '../controls';
import type { Settings } from '../store';

/** The controls card's rows: what, and the player's own keys for it (up to two). */
export function tipsRows(bindings: Settings['bindings']): [string, readonly string[]][] {
  const keys = (id: ActionId, n = 1) => bindings[id].slice(0, n);
  return [
    ['Move', [...keys('left'), ...keys('right')]],
    ['Jet (hold)', keys('jet', 2)],
    ['Crouch / drop', keys('down')],
    ['Dash (+ a direction: 8 ways)', keys('dash')],
    ['Fire', keys('fire')],
    ['Reload', keys('reload')],
    ['Melee', keys('melee')],
    ['Grenade: tap or hold to aim', keys('grenade')],
    ['Next grenade', keys('cycleGrenade')],
    ['Swap weapon', keys('swap')],
    ['Take a gun', keys('interact')],
    ['Shield up / sling', keys('shield')],
    ['Dual wield', keys('dual')],
    ['Scoreboard (hold)', keys('scoreboard')],
  ];
}

/** The dash tip, in the player's own keys: double-tap (when on), and the dash key alone. */
export function dashTip(bindings: Settings['bindings'], doubleTapDash: boolean, layout: ReadonlyMap<string, string> | null = null): string {
  const key = (id: ActionId) => {
    const code = bindings[id][0];
    return code ? capText(code, layout) : null;
  };
  const dash = key('dash');
  const alone = `${dash ?? 'the dash key'} alone dashes the way you face (towards your aim).`;
  if (!doubleTapDash) return alone.charAt(0).toUpperCase() + alone.slice(1);
  const dirs = [key('left'), key('right'), key('down')];
  const taps = dirs.every((k) => k !== null) ? `${dirs[0]}, ${dirs[1]} or ${dirs[2]}` : 'left, right or down';
  return `Double-tap ${taps} to dash that way; ${alone}`;
}

export function TipsCard({ bindings, doubleTapDash = true }: { bindings: Settings['bindings']; doubleTapDash?: boolean }) {
  const ctl = useCtl();
  const layout = useKeyboardLayout();
  return (
    <Screen name="tips" kind="game" label="How to play">
      <aside className="mf-tips panel ticks" aria-label="How to play">
        <p className="eyebrow">How to play</p>
        <h2 className="display h2">Controls</h2>
        <dl className="mf-tips__keys">
          {tipsRows(bindings).map(([what, codes]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>{codes.length ? codes.map((c) => <Kbd key={c} code={c} layout={layout} />) : <span className="muted small">Not set</span>}</dd>
            </div>
          ))}
          <div>
            <dt>Aim</dt>
            <dd>
              <span className="kbd">
                <Icon name="target" />
                Mouse
              </span>
            </dd>
          </div>
          <div>
            <dt>Menu</dt>
            <dd>
              <kbd className="kbd">Esc</kbd>
            </dd>
          </div>
        </dl>
        <ul className="mf-tips__list">
          <li>Hold jet to fly. Fuel refills on the ground, faster than in the air.</li>
          <li>Hold crouch on a yellow platform to drop through it.</li>
          <li>{dashTip(bindings, doubleTapDash, layout)}</li>
          <li>Tap the grenade key for a quick throw; hold it to aim the arc, and let go to throw.</li>
          <li>A raised riot shield stops you dashing: sling it first.</li>
          <li>Guns lie around the map: stand on one and press {bindings.interact[0] ? capText(bindings.interact[0], layout) : 'E'} to swap it for the one in your hand.</li>
        </ul>
        <div className="mf-tips__actions">
          {/* no autoFocus: the card sits over live play, where Space and the arrows are the game's */}
          <button className="btn btn--primary btn--xl" onClick={blurAfter(() => ctl.closeTips())}>
            Got it
          </button>
          <button
            className="btn btn--ghost"
            onClick={blurAfter(() => {
              ctl.closeTips();
              ctl.openSettings('controls');
            })}
          >
            <Icon name="keyboard" />
            Change keys
          </button>
        </div>
      </aside>
    </Screen>
  );
}
