/**
 * The Locker's item tiles (round two's kit .item), shared with the character creator: an item's art,
 * its rarity's shape (colour-blind safe), its name and On / Free / Owned / how to get it.
 */
import { RARITY_STYLE, cosmeticArtPending, cosmeticHowToGet, type CosmeticDef, type DyeChannel } from '@military-forge/content';

export const SHAPES: Record<string, string> = {
  circle: '<circle cx="6" cy="6" r="4.6"/>',
  triangle: '<path d="M6 1.2 11 10.4H1z"/>',
  diamond: '<path d="M6 .8 11.2 6 6 11.2.8 6z"/>',
  pentagon: '<path d="M6 .9 11.2 4.7 9.2 10.9H2.8L.8 4.7z"/>',
  star: '<path d="m6 .6 1.6 3.6 3.9.4-2.9 2.6.8 3.9L6 9.1l-3.4 2 .8-3.9L.5 4.6l3.9-.4z"/>',
};

/**
 * The glyph each item type wears until its own picture is in (and on a page without 3D): one per type, so
 * a top, trousers and boots never share a shirt (audit 28 Oct). The Locker and the creator both use it.
 */
export const SLOT_GLYPH: Readonly<Partial<Record<string, string>>> = {
  top: 'shirt', jacket: 'shirt', legs: 'trousers', gloves: 'hand', boots: 'boot', headgear: 'helmet', eyewear: 'glasses', hair: 'hair',
  bodyType: 'user', jetpack: 'backpack', exhaust: 'flame', trail: 'sparkle', accessory: 'star', skin_k47: 'wpn-k47',
};

/** Which strip of the soldier's full-body picture shows an item best (object-position y, %): the head items use the head-and-shoulders portrait. */
export const THUMB_FOCUS: Readonly<Partial<Record<string, number>>> = { top: 47, jacket: 47, gloves: 57, legs: 82, boots: 100, jetpack: 47, exhaust: 75, trail: 75 };

export const ic = (name: string, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A locked item's words on try-on (the Locker and the creator): how to get it, naming only what the game
 * has (content's cosmeticHowToGet), and for a part not drawn yet, why the soldier still wears the
 * standard issue (the Track Jacket: audit 31 Oct, C-09).
 */
/**
 * What a row shows (audit 2 P-11): a skin tone that can't be had yet (a season's Robot Chrome, an
 * event's Zombie) waits until it can, rather than sit among the skin tones saying Coming soon.
 */
export function shownInRow(item: CosmeticDef, owned: boolean): boolean {
  return item.slot !== 'skinTone' || owned || cosmeticHowToGet(item).tag !== 'Coming soon';
}

/** Price words only in a row where something isn't a starter's (audit 2 P-11). */
export function rowPriced(items: readonly CosmeticDef[]): boolean {
  return items.some((c) => c.source.kind !== 'starter');
}

export function lockedLine(item: CosmeticDef): string {
  return `Locked. ${cosmeticHowToGet(item).line}${cosmeticArtPending(item) ? ' Not drawn yet: the soldier shows the standard issue.' : ''}`;
}

/**
 * One item in the kit's look (.item): its art (a colour's swatch, or the section's glyph on its
 * rarity's tint), its rarity's shape (colour-blind safe), its name, and On / Free / Owned / how to get
 * it. A starter item says Free, not Owned (everyone has it: audit 31 Oct, A-07), but only where paid
 * items sit beside it (`priced`): a row of skin tones carries no price words at all (audit 2 P-11).
 * `picked`: the one being tried on.
 */
export function tileHtml(item: CosmeticDef, equipped: boolean, owned: boolean, channel?: DyeChannel, picked = false, glyph = 'shirt', priced = true): string {
  const r = RARITY_STYLE[item.rarity];
  const how = owned ? '' : cosmeticHowToGet(item).tag;
  const title = `${item.name} · ${r.label}${how ? ` · Locked: ${how}` : ''}`;
  const art = item.colour
    ? `<span class="item__sw" style="--sw:${item.colour}"></span>`
    : `<span class="mf-item__glyph" style="--rarity:${r.colour}">${ic(glyph)}</span>`;
  const tag = equipped
    ? `<span class="tag tag--you">${ic('check')}On</span>`
    : owned
      ? item.source.kind === 'starter'
        ? priced
          ? '<span class="tag tag--ghost">Free</span>'
          : ''
        : '<span class="tag tag--ghost">Owned</span>'
      : `<span class="tag tag--ghost mm-how">${ic('lock')}${escapeHtml(how)}</span>`;
  const cls = ['item', 'mm-tile', equipped ? 'is-on' : '', owned ? '' : 'is-locked mm-locked', picked ? 'is-picked' : ''].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}" role="radio" aria-checked="${picked}" style="--rarity:${r.colour}" data-id="${item.id}"${channel ? ` data-channel="${channel}"` : ''} title="${escapeHtml(title)}">
    <span class="item__art">${art}<svg class="mm-rarity" viewBox="0 0 12 12" role="img" aria-label="${r.label}">${SHAPES[r.shape]}</svg></span>
    <b class="item__name mm-name">${escapeHtml(item.name)}</b>
    ${tag}
  </button>`;
}

