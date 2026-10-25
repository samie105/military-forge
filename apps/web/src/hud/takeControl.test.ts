/**
 * The take prompt names the control the player sees and presses (owner, 25 Oct: "it says hold square
 * to pick a gun, but the UI shows circle/X instead … if it's square, let it be square"). These fail if
 * a prompt and the control it names ever part: the phone's Take button and its word, a key, a pad's
 * button (and the button the pad really takes with), and every take cap the HUD draws.
 */
import { HAMMER, K47, weaponPickup } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { padLabel } from '../gamepad/glyphs';
import { padShownBindings } from '../gamepad/prompts';
import { buttonMap, DEFAULT_PAD_SETTINGS, PAD_PRESET_ORDER, PAD_PRESETS } from '../gamepad/settings';
import { Btn } from '@military-forge/sim';
import { defaultBindings } from '../shell/controls';
import { CONTROLS } from '../touch/layout';
import { skinHtml } from '../touch/skin';
import { capText } from '../ui/icons';
import { pickupPrompt, TAKE_WORD, takeControl } from './model';
import { hudTemplate } from './template';

const onCrate = { x: 10, y: 2, alive: true, active: 0, weapons: [{ def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }] };
const crate = [{ id: 1, def: weaponPickup(K47.index)!.index, x: 10, y: 2 }];

describe('the take prompt names the control on screen', () => {
  it("touch: the prompt says the Take button's own word, the word the button wears", () => {
    // the button's word, as touch/skin.ts draws it under the button
    const word = /<b class="mf-cap"[^>]*>([^<]+)<\/b>/.exec(skinHtml('take'))?.[1];
    expect(word).toBe(TAKE_WORD);
    // the editor's name for it starts with the same word
    expect(CONTROLS.find((c) => c.id === 'take')?.label.startsWith(TAKE_WORD)).toBe(true);
    const take = takeControl('touch');
    expect(take).toMatchObject({ name: word, hold: false, say: `Tap ${word}` });
    expect(pickupPrompt(onCrate, crate, take)).toBe(`Tap ${word} · K-47`);
  });

  it('keys: the prompt names the key the take action is bound to', () => {
    const code = defaultBindings().interact[0]!;
    const take = takeControl('keys', capText(code), code);
    expect(take).toMatchObject({ name: 'E', hold: false, say: 'Press E' });
    expect(pickupPrompt(onCrate, crate, take)).toBe('Press E · K-47');
  });

  it("a pad: the prompt names the button the pad really takes with, in the pad's own glyph", () => {
    for (const id of PAD_PRESET_ORDER) {
      const preset = PAD_PRESETS[id];
      const settings = { ...DEFAULT_PAD_SETTINGS, bindings: preset.bindings, holdTake: preset.holdTake };
      const code = padShownBindings(settings).interact[0]!;
      const map = buttonMap(settings.bindings, settings.holdTake);
      // the button the prompt names is the one the pad acts on: held (hold to take) or pressed (bound to take)
      const button = Number(/(\d+)$/.exec(code)![1]);
      if (preset.holdTake) {
        expect(code, id).toBe(`PadHold${settings.bindings.reload[0]}`);
        expect(map.holdTake.has(button), id).toBe(true);
      } else expect(map.bits[button]! & Btn.Interact, id).toBe(Btn.Interact);
      for (const family of ['playstation', 'xbox', 'nintendo'] as const) {
        const take = takeControl('pad', padLabel(code, family, { short: true }), code);
        const face = padLabel(`Pad${button}`, family, { short: true });
        expect(take, `${id} ${family}`).toMatchObject({ name: face, hold: preset.holdTake, say: `${preset.holdTake ? 'Hold' : 'Press'} ${face}` });
      }
    }
    // the default (Standard) on a PlayStation pad: hold Square, and the prompt says Square
    const std = takeControl('pad', padLabel('PadHold2', 'playstation', { short: true }), 'PadHold2');
    expect(std.say).toBe('Hold □');
    expect(pickupPrompt(onCrate, crate, std)).toBe('Hold □ · K-47');
  });

  it("every take cap the HUD draws shows the take binding or the Take button's word, nothing else", () => {
    const html = hudTemplate();
    const caps = [...html.matchAll(/<[^>]*data-take-cap[^>]*>/g)].map((m) => m[0]);
    // the desktop crate card's key, and the phone chip's two (the button's word on touch, the binding otherwise)
    expect(caps.length).toBeGreaterThanOrEqual(3);
    for (const tag of caps) expect(tag).toMatch(/data-bind="(bind\.interact\.0|take\.word)"/);
    // no take prompt in the HUD names a key of its own
    expect(html).not.toMatch(/tap Take|hold square|\[E\]/i);
  });
});
