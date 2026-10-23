/**
 * The Locker's item tiles (round two's kit .item), shared with the character creator: an item's art,
 * its rarity's shape (colour-blind safe), its name and On / Owned / how to get it.
 */
import { RARITY_STYLE, cosmeticSourceLabel, type CosmeticDef, type DyeChannel } from '@military-forge/content';

export const SHAPES: Record<string, string> = {
  circle: '<circle cx="6" cy="6" r="4.6"/>',
  triangle: '<path d="M6 1.2 11 10.4H1z"/>',
  diamond: '<path d="M6 .8 11.2 6 6 11.2.8 6z"/>',
  pentagon: '<path d="M6 .9 11.2 4.7 9.2 10.9H2.8L.8 4.7z"/>',
  star: '<path d="m6 .6 1.6 3.6 3.9.4-2.9 2.6.8 3.9L6 9.1l-3.4 2 .8-3.9L.5 4.6l3.9-.4z"/>',
};

export const ic = (name: string, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * One item in the kit's look (.item): its art (a colour's swatch, or the section's glyph on its
 * rarity's tint), its rarity's shape (colour-blind safe), its name, and On / Owned / how to get it.
 * `picked`: the one being tried on.
 */
export function tileHtml(item: CosmeticDef, equipped: boolean, owned: boolean, channel?: DyeChannel, picked = false, glyph = 'shirt'): string {
  const r = RARITY_STYLE[item.rarity];
  const how = owned ? '' : cosmeticSourceLabel(item.source);
  const title = `${item.name} · ${r.label}${how ? ` · Locked: ${how}` : ''}`;
  const art = item.colour
    ? `<span class="item__sw" style="--sw:${item.colour}"></span>`
    : `<span class="mf-item__glyph" style="--rarity:${r.colour}">${ic(glyph)}</span>`;
  const tag = equipped
    ? `<span class="tag tag--you">${ic('check')}On</span>`
    : owned
      ? '<span class="tag tag--ghost">Owned</span>'
      : `<span class="tag tag--ghost mm-how">${ic('lock')}${escapeHtml(how)}</span>`;
  const cls = ['item', 'mm-tile', equipped ? 'is-on' : '', owned ? '' : 'is-locked mm-locked', picked ? 'is-picked' : ''].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" role="radio" aria-checked="${picked}" aria-pressed="${equipped}" style="--rarity:${r.colour}" data-id="${item.id}"${channel ? ` data-channel="${channel}"` : ''} title="${escapeHtml(title)}">
    <span class="item__art">${art}<svg class="mm-rarity" viewBox="0 0 12 12" role="img" aria-label="${r.label}">${SHAPES[r.shape]}</svg></span>
    <b class="item__name mm-name">${escapeHtml(item.name)}</b>
    ${tag}
  </button>`;
}

