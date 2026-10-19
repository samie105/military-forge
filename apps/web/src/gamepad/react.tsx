/**
 * The React side of the controller: the device in use (prompts switch with it), the bindings the
 * prompts show (the keyboard's, or the pad's while a pad plays), and a pad button's glyph in a keycap.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { Bindings } from '../shell/controls';
import type { ShellStore } from '../shell/store';
import { currentDevice, currentPadFamily, onInputDevice, type InputDevice } from './device';
import { padGlyphSvg, padLabel, padSpoken } from './glyphs';
import { padShownBindings } from './prompts';

let version = 0;
const versioned = new Set<() => void>();
onInputDevice(() => {
  version++;
  for (const fn of versioned) fn();
});
const subscribe = (fn: () => void) => {
  versioned.add(fn);
  return () => versioned.delete(fn);
};

/** The input in use now (re-renders when it or the glyph setting changes). */
export function useInputDevice(): InputDevice & { family: ReturnType<typeof currentPadFamily> } {
  const v = useSyncExternalStore(subscribe, () => version, () => 0);
  return useMemo(() => ({ ...currentDevice(), family: currentPadFamily() }), [v]);
}

/**
 * What the prompts show (the controls card, the countdown's tip): the keyboard's bindings, or the
 * pad's while a pad is the device; double-tap dashing is the keyboard's alone.
 */
export function useShownControls(store: ShellStore): { bindings: Bindings; doubleTapDash: boolean } {
  const device = useInputDevice();
  const keys = useStore(store, (s) => s.settings.bindings);
  const pad = useStore(store, (s) => s.settings.pad);
  const doubleTapDash = useStore(store, (s) => s.settings.doubleTapDash);
  const usePad = device.kind === 'pad';
  return useMemo(() => (usePad ? { bindings: padShownBindings(pad), doubleTapDash: false } : { bindings: keys, doubleTapDash }), [usePad, pad, keys, doubleTapDash]);
}

/** A pad button in a keycap (the kit's .kbd), drawn in the pad's family; screen readers hear its name. */
export function PadKbd({ code, lg = false, className }: { code: string; lg?: boolean; className?: string | undefined }) {
  const d = useInputDevice();
  const svg = padGlyphSvg(code, d.family);
  const label = padLabel(code, d.family, { dualSense: d.dualSense });
  return (
    <kbd className={['kbd', 'kbd--pad', lg ? 'kbd--lg' : '', className ?? ''].filter(Boolean).join(' ')} aria-label={padSpoken(code, d.family, { dualSense: d.dualSense })} title={label}>
      <span className="mf-padglyph" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    </kbd>
  );
}
