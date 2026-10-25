/**
 * No default layout overlaps (the HUD editor colours overlapping controls red, #292): every preset,
 * both hands, on the phones we test, in landscape and upright (an upright phone plays turned onto its
 * side: the same box). Two controls overlap when their hit circles cross by more than the editor's
 * slack (editor/model.ts overlaps: 4 px).
 */
import { describe, expect, it } from 'vitest';
import { CONTEXT_BY_PRESET, PRESETS, availableControls, offHud, placementFor, sizePx, type ControlId } from '../../src/touch/layout';
import { PRESET_SETTINGS, type PresetId } from '../../src/touch/settings';

/** the safe box (touch.css .mf-touch-safe) on each window: the notch insets (44, an iPhone's 47 or 59), top 10, bottom 21 */
const BOXES = [
  { name: '780×360 (Galaxy S23)', w: 780 - 2 * 44, h: 360 - 10 - 21 },
  { name: '844×390 (iPhone, installed)', w: 844 - 2 * 47, h: 390 - 10 - 21 },
  { name: '844×390 (iPhone Pro notch)', w: 844 - 2 * 59, h: 390 - 10 - 21 },
  { name: '844×300 (iPhone Safari, bars showing)', w: 844 - 2 * 47, h: 300 - 10 - 21 },
  { name: '844×300 (Pro notch, bars showing)', w: 844 - 2 * 59, h: 300 - 10 - 21 },
];
const SLACK = 4;

/** What a preset shows by default: everything but its off-HUD controls, one context control in the slot, FIRE in Fire button mode, JET unless the stick jets in One-thumb. */
function shown(preset: PresetId): ControlId[] {
  const s = PRESET_SETTINGS[preset];
  const off = offHud(preset);
  const ids = availableControls()
    .map((c) => c.id)
    .filter((id) => !off.has(id))
    .filter((id) => id !== 'fireLeft')
    .filter((id) => id !== 'fire' || s.fire === 'button')
    .filter((id) => id !== 'jet' || preset !== 'oneThumb' || s.stickJet === false)
    // One-thumb's aim is a floating stick: it shows only under a drag on empty space, wherever that lands
    .filter((id) => id !== 'aim' || preset !== 'oneThumb');
  // the context slot holds one at a time: its first (Take) stands for all of them (they share the spot)
  return [...ids, CONTEXT_BY_PRESET[preset][0]!];
}

function overlapsIn(preset: PresetId, box: { w: number; h: number }, handed: 'right' | 'left'): string[] {
  const unit = Math.min(box.w, box.h);
  const discs = shown(preset).map((id) => {
    const p = placementFor({ placements: {} }, id, handed, box, preset);
    return { id, x: p.x * box.w, y: p.y * box.h, r: sizePx(p, unit) / 2 };
  });
  const out: string[] = [];
  for (let i = 0; i < discs.length; i++)
    for (let j = i + 1; j < discs.length; j++) {
      const a = discs[i]!;
      const b = discs[j]!;
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
      if (gap < -SLACK) out.push(`${a.id} × ${b.id} (${gap.toFixed(1)} px)`);
    }
  // and every control inside the safe box
  for (const d of discs) if (d.x - d.r < -SLACK || d.x + d.r > box.w + SLACK || d.y - d.r < -SLACK || d.y + d.r > box.h + SLACK) out.push(`${d.id} off the box`);
  return out;
}

describe('the default layouts never overlap', () => {
  for (const preset of Object.keys(PRESETS) as PresetId[])
    for (const box of BOXES)
      for (const handed of ['right', 'left'] as const)
        it(`${preset} · ${box.name} · ${handed}-handed`, () => {
          expect(overlapsIn(preset, box, handed)).toEqual([]);
        });
});
