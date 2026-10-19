import { TUNING_GROUPS, createTuning, defaultTuning, limitTuning } from '@military-forge/content';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TunePanel } from './screens/Tune';
import { PRESETS, TUNE_ROWS, formatTune, presetOf, presetTuning, rowChanged, tuneChanges, tuneToastParts, adminTuningKeys, splitTuneChange, type PresetId } from './tune';

const row = (id: string) => TUNE_ROWS.find((r) => r.id === id)!;
const fieldOf = (key: string) => TUNING_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key)!;

describe('Tune the game: the rows', () => {
  it('maps the kit rows to real tuning keys, with their own min, max and step', () => {
    expect(TUNE_ROWS.map((r) => r.key)).toEqual([
      'fuelMax',
      'fuelBurn',
      'fuelRegenGround',
      'jetThrust',
      'gravity',
      'walkMax',
      'dashSpeed',
      'dashFuelCost',
      'dashChainWindow',
      'dashGap',
      'dashMinStrength',
      'dashFlickFull',
      'blastImpulseScale',
      'grenadeThrowScale',
      'respawnDelay',
    ]);
    for (const r of TUNE_ROWS.filter((x) => x.id !== 'dashDistance')) {
      const f = fieldOf(r.key);
      expect([r.min(defaultTuning), r.max(defaultTuning), r.step(defaultTuning)]).toEqual([f.min, f.max, f.step]);
    }
  });

  it('shows the dash as metres (speed × burst) and edits the speed', () => {
    const dash = row('dashDistance');
    expect(formatTune(dash, defaultTuning)).toBe(`${Number(((defaultTuning.dashSpeed * defaultTuning.dashBurstTicks) / 60).toFixed(1))}\u00a0m`);
    const t = dash.apply(defaultTuning, 99);
    expect(t.dashSpeed).toBe(fieldOf('dashSpeed').max);
    expect(t.dashBurstTicks).toBe(defaultTuning.dashBurstTicks);
  });

  it('snaps an edit to the key step and range, and words each value with its unit', () => {
    const g = row('gravity');
    expect(g.apply(defaultTuning, 12.3).gravity).toBe(12.5);
    expect(g.apply(defaultTuning, -5).gravity).toBe(fieldOf('gravity').min);
    expect(formatTune(g, createTuning({ gravity: 12 }))).toBe('12\u00a0m/s²');
    expect(formatTune(row('blastLaunch'), defaultTuning)).toBe('1×');
    expect(formatTune(row('fuelBurn'), defaultTuning)).toBe('44\u00a0/s');
    expect(rowChanged(g, createTuning({ gravity: 12 }))).toBe(true);
    expect(rowChanged(g, defaultTuning)).toBe(false);
  });
});

describe('Tune the game: presets', () => {
  it('keeps every preset inside the panel ranges', () => {
    for (const id of Object.keys(PRESETS) as PresetId[]) expect(limitTuning(PRESETS[id])).toEqual(PRESETS[id]);
  });

  it('names the preset a tuning is, or Custom', () => {
    expect(presetOf(defaultTuning)).toBe('classic');
    expect(presetOf(presetTuning('floaty'))).toBe('floaty');
    expect(presetOf(presetTuning('chaos'))).toBe('chaos');
    expect(presetOf({ ...presetTuning('floaty'), gravity: 13 })).toBe('custom');
    expect(presetOf(createTuning({ respawnDelay: 5 }))).toBe('custom');
  });
});

describe('Tune the game: what a guest hears', () => {
  it('lists the changes in the panel words, two at most and how many more', () => {
    const before = createTuning();
    const after = createTuning({ gravity: 12, dashChainWindow: 0.6, fuelRegenAir: 20 });
    const changes = tuneChanges(before, after);
    expect(changes.slice(0, 2)).toEqual([
      { label: 'Gravity', value: '12\u00a0m/s²' },
      { label: 'Dash chain window', value: '0.6\u00a0s' },
    ]);
    expect(changes[2]!.value).toBe('20');
    expect(tuneToastParts('Ade', changes)).toEqual({ who: 'Ade', items: changes.slice(0, 2), more: 1 });
    expect(tuneToastParts('Ade', [])).toBeNull();
  });
});

describe('Tune the game: the panel', () => {
  it('draws the kit panel with every row, the default marked, and the preset picked', () => {
    const t = createTuning({ gravity: 12 });
    const html = renderToStaticMarkup(
      createElement(TunePanel, { online: true, getTuning: () => t, setTuning: () => {}, subscribe: () => () => {}, onClose: () => {}, copy: async () => true }),
    );
    expect(html).toContain('data-screen="tune"');
    expect(html.match(/<li class="trow/g)).toHaveLength(TUNE_ROWS.length);
    expect(html).toContain('Live for everyone in the room');
    expect(html.match(/slider__def/g)).toHaveLength(TUNE_ROWS.length);
    expect(html).toMatch(/data-tab="custom" aria-checked="true"/);
    expect(html).toContain('trow is-changed');
  });
});

describe("who changed the room's tuning (the audit, M3)", () => {
  it("tells the admin page's keys from the host's", () => {
    const keys = adminTuningKeys({ 'tuning.gravity': 12 }, { 'tuning.gravity': 9, 'tuning.fuelMax': 250 });
    expect([...keys].sort()).toEqual(['fuelMax', 'gravity']);
    expect(adminTuningKeys({ 'tuning.gravity': 12 }, {})).toEqual(new Set(['gravity'])); // cleared: back to the default
    expect(adminTuningKeys({}, { 'weapon.k47.damage': 20 })).toEqual(new Set()); // not a tuning key
  });

  it("splits one change into the admin's part and the host's", () => {
    const before = { ...defaultTuning };
    const after = { ...defaultTuning, gravity: 9, walkMax: defaultTuning.walkMax + 1 };
    const { admin, host } = splitTuneChange(before, after, new Set<keyof typeof before>(['gravity']));
    expect(tuneChanges(before, admin).map((c) => c.label).join()).toMatch(/Gravity/i);
    expect(tuneChanges(before, admin).some((c) => /walk/i.test(c.label))).toBe(false);
    expect(tuneChanges(before, host).some((c) => /gravity/i.test(c.label))).toBe(false);
    expect(tuneChanges(before, host).length).toBe(1);
  });
});
