/** Team modes in the page (v21): the palette, the lobby's team roster, the scoreboard grouping, results by team, the poster's team columns. */
import { MatchPhase } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookBook } from '../../src/looks/book';
import { localMatchRules } from '../../src/shell/localMatch';
import type { LobbyPlayer } from '../../src/shell/onlineView';
import { applyTeamPalette, TEAM_PALETTES, teamColour, teamColourCss, teamLabel, teamPaletteMode } from '../../src/teams/palette';
import { TeamStandings, teamWinner } from '../../src/teams/TeamResults';
import { TeamModePicker, TeamRoster, modeName } from '../../src/teams/TeamRoster';
import { orderByTeam, teamHeading, teamTotals } from '../../src/teams/scoreboard';

afterEach(() => {
  lookBook.clear();
  applyTeamPalette('standard', null);
});

describe('the team palette', () => {
  it('one colour per team in each colour-blind mode, with a shape and a letter; CSS variables on <html>', () => {
    const set = vi.fn();
    applyTeamPalette('deutan', { style: { setProperty: set } });
    expect(teamPaletteMode()).toBe('deutan');
    expect(set).toHaveBeenCalledWith('--c-team-1', TEAM_PALETTES.deutan[1]);
    expect(teamColour(0)).toBe(0x3d8bff);
    expect(teamColour(-1)).toBeNull();
    expect(teamColourCss(1)).toBe('#ffc53d');
    expect(teamLabel(2)).toBe('● Charlie');
    for (const mode of Object.values(TEAM_PALETTES)) expect(new Set(mode).size).toBe(4);
  });
});

const player = (id: number, team: number, over: Partial<LobbyPlayer> = {}): LobbyPlayer => ({ id, name: `P${id}`, isBot: false, ready: false, host: false, you: false, pingMs: 20, team, ...over });

describe('the lobby in team modes', () => {
  it('a group per team with its mark, name and size; tags; the host gets pick buttons, a guest does not', () => {
    const players = [player(0, 0, { you: true, host: true }), player(1, 1), player(2, 1, { isBot: true, name: '[BOT] Kolo' }), player(3, 2, { ready: true })];
    const guest = renderToStaticMarkup(<TeamRoster players={players} teams={3} host={false} onMove={() => {}} />);
    expect(guest.match(/class="mf-team"/g)).toHaveLength(3);
    expect(guest).toContain('Team Alpha');
    expect(guest).toContain('Team Charlie');
    expect(guest).toContain('>Kolo<');
    expect(guest).not.toContain('<button');
    const host = renderToStaticMarkup(<TeamRoster players={players} teams={3} host onMove={() => {}} />);
    expect(host.match(/mf-team__pick" aria-pressed/g)).toHaveLength(4);
    expect(renderToStaticMarkup(<TeamModePicker teams={2} onTeams={() => {}} />)).toMatch(/aria-checked="true"[^>]*>2 teams</);
    expect(modeName(0)).toBe('Deathmatch');
    expect(modeName(3)).toBe('Team deathmatch · 3 teams');
  });
});

describe('the scoreboard by team', () => {
  it('the leading team first, each team in its own order, its score the sum of its players\'', () => {
    const rows = [
      { name: 'a', team: 0, score: 3, left: false },
      { name: 'b', team: 1, score: 5, left: false },
      { name: 'c', team: 0, score: 1, left: true },
      { name: 'd', team: 1, score: -1, left: false },
      { name: 'e', team: -1, score: 9, left: false },
    ];
    expect(teamTotals(rows)).toEqual(new Map([[0, 4], [1, 4]]));
    expect(orderByTeam(rows).map((r) => r.name)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(teamHeading(1)).toBe('▲ B · Team Bravo');
  });
});

describe('results by team', () => {
  it('the winning team, a draw, and the teams in finishing order', () => {
    expect(teamWinner({ winnerTeam: 1 })).toEqual({ name: 'Team Bravo', draw: false });
    expect(teamWinner({ winnerTeam: -1 })).toEqual({ name: 'Draw', draw: true });
    const html = renderToStaticMarkup(<TeamStandings results={{ teamScores: [12, 30, 21], standings: [] }} myTeam={0} />);
    const order = [...html.matchAll(/Team (\w+)</g)].map((m) => m[1]);
    expect(order).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(html).toContain('is-mine');
  });
});

describe('training with teams', () => {
  it('?teams=2 plays a team match at the team kill limit', () => {
    expect(localMatchRules(new URLSearchParams('teams=2'))).toMatchObject({ teams: 2, killLimit: 30 });
    expect(localMatchRules(new URLSearchParams('teams=4&kills=15'))).toMatchObject({ teams: 4, killLimit: 15 });
    expect(localMatchRules(new URLSearchParams('teams=5'))?.teams).toBeUndefined();
    expect(MatchPhase.InProgress).toBe(2);
  });
});

describe('the look book in team modes', () => {
  it('knows each player’s team and teammates (the minimap’s allies); a free-for-all has none', () => {
    lookBook.setTeams(2, new Map([[0, 0], [1, 1], [2, 0], [3, 0]]));
    expect(lookBook.teamOf(2)).toBe(0);
    expect([...lookBook.teammatesOf(0)].sort()).toEqual([2, 3]);
    expect([...lookBook.teammatesOf(1)]).toEqual([]);
    expect([...lookBook.teammatesOf(9)]).toEqual([]);
    lookBook.setTeams(0, new Map([[0, 0]]));
    expect(lookBook.teamOf(0)).toBe(-1);
    expect(lookBook.teammatesOf(0).size).toBe(0);
  });
});
