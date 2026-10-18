/**
 * The touch controls (apps/web/src/touch, W6's) wear the kit's icons: each button's text glyph gives
 * way to the kit's icon, drawn as a CSS mask from the sprite, so the touch module's elements and
 * behaviour stay exactly as they are. Colours and plates are in hud.css. Applied while the controls
 * are up (html[data-touch-controls]). The grenade button also shows the selected type's icon and how
 * many you carry (the HUD sets its data-grenade and data-count: touchGrenade).
 */
import { grenades } from '@military-forge/content';
import { spriteSymbol } from '../ui/sprite';

/** Touch control id (touch/layout.ts) → the kit's icon (the phone HUD screen's buttons). */
export const TOUCH_ICONS: Readonly<Record<string, string>> = {
  grenade: 'icon-g-frag',
  cycleGrenade: 'icon-cycle',
  dash: 'icon-dash',
  melee: 'icon-melee',
  reload: 'icon-reload',
  swap: 'icon-swap',
  zoom: 'icon-zoom',
  shield: 'icon-shield',
  take: 'icon-armory',
  pause: 'icon-pause',
  scores: 'icon-list',
};

/** A sprite symbol as a data URI for mask-image (black on transparent: only its shape counts). */
export function iconMask(id: string): string | null {
  const s = spriteSymbol(id);
  if (!s) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" color="black">${s.body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The CSS: each mapped button hides its glyph and shows the kit's icon in its place. */
export function touchSkinCss(): string {
  const rules: string[] = [];
  for (const [control, icon] of Object.entries(TOUCH_ICONS)) {
    const mask = iconMask(icon);
    if (!mask) continue;
    const at = `html[data-touch-controls] .mf-touch .mf-ctl-${control}`;
    // the touch module sizes each glyph inline: the icon replaces it
    rules.push(`${at} { font-size: 0 !important; }`);
    rules.push(`${at}::before { content: ""; position: absolute; inset: 0; width: 46%; height: 46%; margin: auto; background: currentColor; -webkit-mask: ${mask} center / contain no-repeat; mask: ${mask} center / contain no-repeat; }`);
  }
  // the grenade button: the selected type's icon, and the count in a badge on its rim
  const nade = 'html[data-touch-controls] .mf-touch .mf-ctl-grenade';
  for (const g of grenades) {
    const mask = iconMask(`icon-g-${g.id}`);
    if (mask) rules.push(`${nade}[data-grenade="${g.id}"]::before { -webkit-mask-image: ${mask}; mask-image: ${mask}; }`);
  }
  rules.push(
    `${nade}[data-count]::after { content: attr(data-count); position: absolute; top: -4px; right: -4px; min-width: 24px; height: 24px; padding: 0 6px; box-sizing: border-box; border-radius: 12px; display: grid; place-items: center; background: var(--hud-plate-strong); border: var(--bw) solid var(--c-line-strong); color: var(--c-text); font: var(--fw-bold) 14px/1 var(--font-ui); font-variant-numeric: tabular-nums; }`,
    `${nade}[data-count="0"] { opacity: 0.55; }`,
  );
  return rules.join('\n');
}

/** What the touch grenade button shows: the selected type's id and how many of it you carry. */
export function touchGrenade(belt: readonly { id: string; count: number; selected: boolean }[]): { id: string; count: number } {
  const g = belt.find((s) => s.selected) ?? belt[0];
  return { id: g?.id ?? 'frag', count: g?.count ?? 0 };
}

let mounted = false;

/** Adds the icon rules to the page (once). */
export function mountTouchSkin(doc: Document = document): void {
  if (mounted) return;
  mounted = true;
  const style = doc.createElement('style');
  style.id = 'mf-touch-skin';
  style.textContent = touchSkinCss();
  doc.head.appendChild(style);
}
