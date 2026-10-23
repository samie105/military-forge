/**
 * Prompts in the device's own buttons (pure): the controls card, the countdown's tip and the HUD's
 * keycaps all take the keyboard's `Bindings` (shell/controls.ts), so while a pad is the device they
 * get the same shape with pad codes in it ('Pad3', 'PadLS'; glyphs.ts draws them).
 */
import type { ActionId, Bindings } from '../shell/controls';
import { padCode } from './glyphs';
import type { PadActionId, PadSettings } from './settings';

/** The keyboard's actions as the pad does them: sticks for moving, bound buttons for the rest. */
export function padShownBindings(pad: PadSettings): Bindings {
  const move = pad.swapSticks ? 'PadRS' : 'PadLS';
  const codes = (id: PadActionId) => pad.bindings[id].map(padCode);
  const out: Record<ActionId, string[]> = {
    left: [move],
    right: [],
    jet: pad.stickJet ? [`${move}Up`, ...codes('jet')] : codes('jet'),
    down: [`${move}Down`, ...codes('down')],
    dash: codes('dash'),
    fire: codes('fire'),
    fire2: codes('fire2'),
    reload: codes('reload'),
    melee: codes('melee'),
    grenade: codes('grenade'),
    cycleGrenade: codes('cycleGrenade'),
    swap: codes('swap'),
    slot1: [],
    slot2: [],
    dual: codes('dual'),
    // Standard: hold reload to take ("Hold X"), then any button bound to take
    interact: pad.holdTake && pad.bindings.reload.length ? [`PadHold${pad.bindings.reload[0]}`, ...codes('interact')] : codes('interact'),
    shield: codes('shield'),
    scoreboard: codes('scoreboard'),
    netGraph: [],
    talk: codes('talk'),
  };
  return out;
}

/** The aim stick's code ('PadRS', or the left one with the sticks swapped). */
export const padAimCode = (pad: PadSettings): string => (pad.swapSticks ? 'PadLS' : 'PadRS');

/** The menu button's code (Options / Menu). */
export const PAD_MENU_CODE = 'Pad9';
