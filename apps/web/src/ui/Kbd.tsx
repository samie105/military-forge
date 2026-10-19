/**
 * A keycap for a binding (the kit's .kbd): the player's own key, never a letter baked into copy.
 * Mouse buttons get the kit's mouse glyphs. `code` is a KeyboardEvent.code or 'Mouse0'…'Mouse4'.
 */
import { isPadCode } from '../gamepad/glyphs';
import { PadKbd } from '../gamepad/react';
import { Icon } from './Icon';
import { MOUSE_CAPS, capText } from './icons';

export { capText } from './icons';

export function Kbd({ code, lg = false, layout, className }: { code: string | undefined; lg?: boolean; layout?: ReadonlyMap<string, string> | null; className?: string }) {
  if (!code) return null;
  // a controller's button ('Pad3'), drawn in the pad's own glyphs (gamepad/)
  if (isPadCode(code)) return <PadKbd code={code} lg={lg} className={className} />;
  const mouse = MOUSE_CAPS[code];
  return (
    <kbd className={['kbd', lg ? 'kbd--lg' : '', className ?? ''].filter(Boolean).join(' ')}>
      {mouse?.[0] && <Icon name={mouse[0]} />}
      {capText(code, layout)}
    </kbd>
  );
}

/** A fixed key that isn't a binding (Esc, Enter, Wheel). */
export function Cap({ children, lg = false }: { children: string; lg?: boolean }) {
  return <kbd className={lg ? 'kbd kbd--lg' : 'kbd'}>{children}</kbd>;
}
