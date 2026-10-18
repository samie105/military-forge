/**
 * The kit's icons (sprite.ts) as React: <Icon name="shield" /> is <svg class="ic"><use href="#icon-shield"/></svg>.
 * Weapon glyphs: <Icon name="wpn-hammer" size="wpn" />. Decorative unless given a label.
 */
import { iconHref } from './icons';

export { iconHref, weaponIcon } from './icons';

export type IconSize = 'sm' | 'lg' | 'xl' | 'wpn';

export function Icon({ name, size, className, label }: { name: string; size?: IconSize | undefined; className?: string | undefined; label?: string | undefined }) {
  const cls = ['ic', size ? `ic--${size}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg className={cls} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}>
      <use href={iconHref(name)} />
    </svg>
  );
}
