import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, paletteFor } from '../minimap/draw';
import { MARK_COLOURS, MARK_SHAPES, markColour, relationOf } from './marking';

const teams = new Map([
  [0, 0],
  [1, 1],
  [2, 0],
  [3, 1],
]);
const teamOf = (id: number) => teams.get(id) ?? -1;
const noTeams = () => -1;

describe("who's who (marking.ts)", () => {
  it('team modes: your team are allies, the others enemies, you yourself', () => {
    expect(relationOf(0, 0, teamOf)).toBe('self');
    expect(relationOf(2, 0, teamOf)).toBe('ally');
    expect(relationOf(1, 0, teamOf)).toBe('enemy');
    expect(relationOf(3, 0, teamOf)).toBe('enemy');
  });

  it('free-for-all: no sides, everyone else is drawn plain', () => {
    expect(relationOf(4, 4, noTeams)).toBe('self');
    for (const id of [0, 1, 2, 3]) expect(relationOf(id, 4, noTeams)).toBe('neutral');
  });

  it("watching someone: the picture is theirs (their team are the allies)", () => {
    // a spectator watching player 1 (team B)
    expect(relationOf(1, 1, teamOf)).toBe('self');
    expect(relationOf(3, 1, teamOf)).toBe('ally');
    expect(relationOf(0, 1, teamOf)).toBe('enemy');
  });

  it('a player not yet on a team never reads as an ally', () => {
    expect(relationOf(9, 0, teamOf)).toBe('enemy');
    // a viewer with no team yet sees no sides
    expect(relationOf(2, 9, teamOf)).toBe('neutral');
  });

  it('enemies red, allies teal, you volt; the minimap uses the same colours in every colour-blind mode', () => {
    expect(markColour('enemy')).toBe(0xff4d5e);
    expect(markColour('ally')).toBe(0x3fd0c9);
    for (const mode of ['standard', 'deutan', 'tritan'] as const) {
      const p = paletteFor(mode);
      expect(p.enemy).toBe(MARK_COLOURS[mode].enemy);
      expect(p.ally).toBe(MARK_COLOURS[mode].ally);
      expect(MARK_COLOURS[mode].enemy).not.toBe(MARK_COLOURS[mode].ally);
    }
    expect(DEFAULT_PALETTE.you).toBe(MARK_COLOURS.standard.self);
  });

  it('allies and enemies have their own shapes (colour is never the only cue)', () => {
    expect(new Set(Object.values(MARK_SHAPES)).size).toBe(2);
  });
});
