/**
 * Dev only (vsposter.html): the VS poster, its strip and the lobby's avatars with real portraits, rendered
 * by the portrait renderer on its own WebGL context (no game here), for design checks and the PR's shots.
 * `?n=` fighters (default 8) · `?teams=4v4|4v4v4|2v2v2v2` · `?state=poster|strip|lobby` · `?phone` · `?reduce`.
 */
import { DEFAULT_COSMETIC_LOADOUT, botLook, lookSeed, type CosmeticLoadout } from '@military-forge/content';
import { MatchPhase } from '@military-forge/sim';
import { createRoot } from 'react-dom/client';
import { WebGLRenderer } from 'three';
import { CharacterAssembler } from '../character';
import { lookBook } from '../looks/book';
import { installPortraits, portraits } from '../portrait';
import { Countdown } from '../shell/screens/Countdown';
import type { MatchView } from '../shell/matchView';
import { startFitting } from '../ui/fit';
import { mountSprite } from '../ui/sprite';
import '../ui/app.css';
import '../shell/screens/phone/phone.css';
import { PlayerAvatar } from './PlayerAvatar';
import { VsPoster, useFighters } from './VsPoster';
import { warmRoomPortraits } from './warm';
import { TeamRoster, TeamModePicker } from '../teams/TeamRoster';
import { TeamStandings } from '../teams/TeamResults';
import { TeamStrip } from '../teams/hudStrip';
import { applyTeamPalette } from '../teams/palette';

const params = new URLSearchParams(location.search);
const n = Math.max(1, Math.min(16, Number(params.get('n') ?? 8)));
const state = params.get('state') ?? 'poster';
if (params.has('reduce')) document.documentElement.classList.add('reduce-motion');

const D = DEFAULT_COSMETIC_LOADOUT.items;
const look = (items: Partial<CosmeticLoadout['items']>, primary: string, secondary: string, accent: string): CosmeticLoadout => ({ items: { ...D, ...items }, dyes: { primary, secondary, accent } });
/** people (their own looks) and then bots (seeded looks), as a room would have them */
const PEOPLE: [string, CosmeticLoadout][] = [
  ['Ade', look({ bodyType: 'body_female', skinTone: 'skin_10', headgear: 'headgear_bandana', eyewear: 'eyewear_aviators', gloves: 'gloves_tactical', boots: 'boots_jungle', hair: 'hair_braids' }, 'dye_red', 'dye_white', 'dye_yellow')],
  ['Kemi', look({ skinTone: 'skin_08' }, 'dye_sand', 'dye_olive', 'dye_teal')],
  ['Tunde', look({ bodyType: 'body_stocky', skinTone: 'skin_11', headgear: 'headgear_field_cap', gloves: 'gloves_tactical' }, 'dye_olive', 'dye_sand', 'dye_charcoal')],
  ['Zara', look({ bodyType: 'body_female', skinTone: 'skin_06', hair: 'hair_bun', boots: 'boots_jungle' }, 'dye_khaki', 'dye_gunmetal', 'dye_mustard')],
  ['Ifeoma', look({ bodyType: 'body_female', skinTone: 'skin_09', headgear: 'headgear_bandana', hair: 'hair_braids' }, 'dye_white', 'dye_charcoal', 'dye_red')],
];
const BOTS = ['Kolo', 'Obi', 'Lena', 'Badger', 'Kestrel', 'Mantis', 'Rook', 'Vandal', 'Sable', 'Onyx', 'Drake'];
const fighters = Array.from({ length: n }, (_, i) => {
  const person = PEOPLE[i];
  const name = person ? person[0] : `[BOT] ${BOTS[i - PEOPLE.length] ?? `Bot ${i}`}`;
  return { id: i, name, isBot: !person, look: person ? person[1] : botLook(lookSeed(7, name)) };
});
lookBook.setRoster(0, fighters.map(({ id, name, isBot }) => ({ id, name, isBot })));
lookBook.setHost(0);
lookBook.replace(fighters.map((f) => [f.id, f.look] as const));

const TEAMS: Record<string, number[]> = { '1v1': [1, 1], '2v2': [2, 2], '4v4': [4, 4], '4v4v4': [4, 4, 4], '2v2v2v2': [2, 2, 2, 2] };
const split = TEAMS[params.get('teams') ?? ''];
let at = 0;
const teams = split ? split.map((size) => Array.from({ length: size }, () => at++)) : null;

applyTeamPalette((params.get('cb') as 'standard' | 'deutan' | 'tritan' | null) ?? 'standard');
if (teams) lookBook.setTeams(teams.length, new Map(teams.flatMap((ids, t) => ids.map((id) => [id, t] as const))));

const view: MatchView = {
  phase: MatchPhase.Countdown, number: 1, secondsLeft: state === 'strip' ? 3 : 5, untimed: false, secondsElapsed: 0, killLimit: 20, timeLimit: 300, countdownTotal: 5,
  mapName: 'Street Market', localId: 0, myScore: 0, leaderScore: 0, leaderName: '', ready: false, votes: 0, humans: Math.min(n, PEOPLE.length), voted: false, results: null,
};

// portraits on a WebGL context of their own (in the game they share the game's)
const renderer = new WebGLRenderer({ antialias: false, alpha: true });
installPortraits(renderer, new CharacterAssembler());
warmRoomPortraits(lookBook);
Object.assign(window, { __portraits: portraits });

function Lobby() {
  const all = useFighters();
  return (
    <div className="mf-fit kit-v2">
      <section className="screen screen--menu" data-screen="lobby-preview" style={{ padding: 96 }}>
        <ul className="prows" style={{ width: 760, display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', padding: 0 }}>
          {all.map((f) => (
            <li key={f.id} className={`prow${f.you ? ' is-you' : ''}`}>
              <PlayerAvatar id={f.id} name={f.name} bot={f.isBot} />
              <b className="prow__name">{f.isBot ? f.name.replace('[BOT] ', '') : f.name}</b>
              {f.host && <span className="tag tag--host">Host</span>}
              {f.isBot && <span className="tag tag--bot">Bot</span>}
              {f.you && <span className="tag tag--you">You</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Team modes: the lobby's team groups (host view, one player picked), the mode picker, and results by team. */
function TeamPreview() {
  const all = useFighters();
  const players = all.map((f) => ({ id: f.id, name: f.name, isBot: f.isBot, ready: f.id % 3 === 0, host: f.host, you: f.you, pingMs: 30, team: lookBook.teamOf(f.id) }));
  const scores = teams ? teams.map((_, t) => [24, 19, 21, 12][t]!) : [];
  return (
    <div className="mf-fit kit-v2">
      <section className="screen screen--menu" data-screen="teams-preview" style={{ padding: 72, display: 'grid', gridTemplateColumns: '700px 1fr', gap: 48 }}>
        <div className="card card--print" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 className="display" style={{ fontSize: 48, margin: 0 }}>Roster {players.length}/16</h2>
          <TeamRoster players={players} teams={teams?.length ?? 0} host onMove={() => {}} />
        </div>
        <div className="card card--print" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, alignSelf: 'start' }}>
          <h2 className="display" style={{ fontSize: 48, margin: 0 }}>Mission</h2>
          <TeamModePicker teams={teams?.length ?? 0} onTeams={() => {}} />
          <span className="label">Results by team</span>
          <TeamStandings results={{ teamScores: scores, standings: all.map((f, i) => ({ placement: i + 1, id: f.id, key: f.id, name: f.name, isBot: f.isBot, left: false, score: 0, kills: 0, deaths: 0, suicides: 0, assists: 0, damageDealt: 0, damageTaken: 0, headshots: 0, bestStreak: 0, rating: 0, mvp: false, team: lookBook.teamOf(f.id) })) }} myTeam={0} />
        </div>
      </section>
    </div>
  );
}

function Preview() {
  const all = useFighters();
  if (state === 'teams') return <TeamPreview />;
  if (state === 'lobby') return <Lobby />;
  if (state === 'strip') return <Countdown view={view} state="3" />;
  return <VsPoster view={view} fighters={all} leaving={false} held={false} teams={teams} />;
}

const root = document.createElement('div');
root.id = 'shell';
root.className = 'mf';
document.body.appendChild(root);
mountSprite();
startFitting();
createRoot(root).render(<Preview />);
// the HUD's team strip as it shows mid-match (?state=strip with teams)
if (teams && state === 'strip') new TeamStrip().update({ ...view, phase: MatchPhase.InProgress, teams: teams.length, teamScores: teams.map((_, t) => [24, 19, 21, 12][t]!), myTeam: 0 });
