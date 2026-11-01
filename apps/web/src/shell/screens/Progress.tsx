/**
 * The level, where the player looks (audit 2 P-04, P-10): "+135 XP · Level 3" and a thin bar on
 * Results after an online match, the level on Home's chip and nameplate and the ID card, and Home's
 * "Last match" card with a personal best. All from shell/progress.ts (the API's profile, one rule:
 * packages/shared progression.ts). A number and a bar only: no unlocks, no boosts, no pop-ups.
 */
import { maps } from '@military-forge/content';
import type { MatchStanding } from '@military-forge/sim';
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/Icon';
import { ControllerContext } from '../context';
import { noun, ordinal } from '../matchView';
import { levelFill, levelOf, matchGain, progressOf, useProgress, type ProgressCache } from '../progress';
import './progress.css';

/** The shell's progress cache, or null offline (no API, no level). */
export function useProgressCache(): ProgressCache | null {
  const ctl = useContext(ControllerContext);
  const offline = !!ctl?.store.getState().profile?.offline;
  return ctl?.api && !offline ? progressOf(ctl.api) : null;
}

/** The thin bar: `from` → `to` once (0–1), no confetti. */
function Bar({ from, to, label }: { from: number; to: number; label: string }) {
  const [fill, setFill] = useState(from);
  useEffect(() => {
    const t = window.setTimeout(() => setFill(to), 400);
    return () => window.clearTimeout(t);
  }, [to]);
  return (
    <span className="mf-lvbar" role="img" aria-label={label}>
      <i style={{ '--lv-fill': fill } as CSSProperties}></i>
    </span>
  );
}

/** XP bases seen per match: a Results that mounts again (a resize to the phone's) doesn't count it twice. */
const bases = new Map<string, number>();

/**
 * Results' XP line. `online`: an online room (the API records it); training and local rooms say
 * plainly that they don't count. `matchKey` names the match (the room code and its number).
 */
export function MatchXp({ me, online, matchKey }: { me: MatchStanding | undefined; online: boolean; matchKey: string }) {
  const cache = useProgressCache();
  const [base] = useState(() => {
    if (!online || !cache) return null;
    const seen = bases.get(matchKey);
    if (seen !== undefined) return seen;
    const xp = cache.level()?.xp ?? null;
    if (xp !== null) bases.set(matchKey, xp);
    return xp;
  });
  const { profile } = useProgress(online ? cache : null);
  // the API records the match a moment after it ends: ask after ~3 s, and once more if it wasn't in yet
  useEffect(() => {
    if (!online || !cache) return undefined;
    const t = [window.setTimeout(() => void cache.load(), 3000), window.setTimeout(() => void cache.load(), 9000)];
    return () => t.forEach((x) => window.clearTimeout(x));
  }, [online, cache]);
  if (!online) {
    return (
      <p className="mf-xp mf-xp--none">
        <Icon name="info" size="sm" />
        XP counts in online matches only.
      </p>
    );
  }
  if (!me || base === null) return null;
  const g = matchGain(base, me);
  // the server's word once it has the match (never less than the rule says: it may not be in yet)
  const xp = profile && profile.xp >= base + g.gain ? profile.xp : base + g.gain;
  const after = levelOf(xp);
  const up = after.level > g.before.level;
  const into = after.xpForNextLevel > 0 ? `${after.xpIntoLevel}/${after.xpForNextLevel}` : 'top level';
  return (
    <div className="mf-xp m-p3">
      <p className="mf-xp__line">
        <b className="num">+{g.gain} XP</b> · Level <b className="num">{after.level}</b> · <span className="num">{into}</span>
        {up && <span className="stamp stamp--volt mf-xp__up m-p7">Level {after.level}</span>}
      </p>
      <Bar from={up ? 0 : levelFill(g.before)} to={levelFill(after)} label={`Level ${after.level}, ${into} XP`} />
    </div>
  );
}

/** "Lv 3" for Home's chip and the phone's avatar (nothing before the API answers, or offline). */
export function LevelTag({ className }: { className?: string }) {
  const { level } = useProgress(useProgressCache());
  if (!level) return null;
  return (
    <span className={['mf-lv', className ?? ''].filter(Boolean).join(' ')} aria-label={`Level ${level.level}`}>
      Lv {level.level}
    </span>
  );
}

/** Home asks the API once per visit (desktop's nameplate, the phone's Home). */
export function useLoadProgress(): void {
  const cache = useProgressCache();
  useEffect(() => {
    void cache?.load();
  }, [cache]);
}

/** The nameplate's "Level 3 · 135/300 XP" with its bar. Loads the profile once per Home visit. */
export function LevelLine() {
  const cache = useProgressCache();
  const { level } = useProgress(cache);
  useLoadProgress();
  if (!level) return null;
  const into = level.xpForNextLevel > 0 ? `${level.xpIntoLevel}/${level.xpForNextLevel} XP` : 'Top level';
  return (
    <span className="mf-lvline">
      <span>
        Level <b className="num">{level.level}</b> · <span className="num">{into}</span>
      </span>
      <Bar from={levelFill(level)} to={levelFill(level)} label={`Level ${level.level}, ${into}`} />
    </span>
  );
}

/** The ID card's level (a new player: 1). */
export function useLevelNumber(): number {
  return useProgress(useProgressCache()).level?.level ?? 1;
}

/**
 * Home's "Last match" (P-10): the last online match the API recorded and one personal best to beat.
 * Mastery only: no timers, no streak counters, nothing missed by not playing. Null before any.
 */
export function LastMatchCard({ style }: { style?: CSSProperties }) {
  const { profile } = useProgress(useProgressCache());
  const last = profile?.recent[0];
  if (!profile || !last) return null;
  const map = maps[last.map]?.name ?? last.map;
  const best = profile.recent.reduce((n, r) => Math.max(n, r.kills), 0);
  return (
    <section className="card card--print mf-lastmatch m-p3" style={style} aria-labelledby="mf-lastmatch-t">
      <span className="label label--volt" id="mf-lastmatch-t">
        Last match
      </span>
      <p className="mf-lastmatch__line">
        <b>{last.left ? 'Left early' : ordinal(last.placement)}</b> · {last.kills} {noun(last.kills, 'kill')} · {map} · <span className="num">+{last.xpGained} XP</span>
      </p>
      <ul className="mf-lastmatch__bests">
        <li>
          <Icon name="target" size="sm" />
          <span>
            Best streak <b className="num">{profile.stats.bestStreak}</b>
          </span>
        </li>
        <li>
          <Icon name="rank" size="sm" />
          <span>
            Most kills in your last {profile.recent.length} {noun(profile.recent.length, 'match', 'matches')} <b className="num">{best}</b>
          </span>
        </li>
        <li>
          <Icon name="trophy" size="sm" />
          <span>
            Wins <b className="num">{profile.stats.wins}</b> of <span className="num">{profile.stats.matches}</span>
          </span>
        </li>
      </ul>
    </section>
  );
}
