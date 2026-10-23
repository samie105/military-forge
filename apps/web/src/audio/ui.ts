/**
 * Interface sounds: clicks and hovers on the menus' controls (one listener on the document, so
 * no screen needs wiring), and the shell's moments from its store: toasts, errors, players joining
 * and leaving, Ready, the countdown's 3-2-1, GO, the match-start flood and sting, and the results.
 */
import { MatchPhase } from '@military-forge/sim';
import type { ShellState } from '../shell/store';
import type { MusicMode } from './music';
import type { SoundId } from './sounds';

const CONTROL = 'button, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], a[href], summary, input[type="checkbox"], select';

/** Which sound a click on `el` makes (null: none). */
export function clickSound(el: Element | null): SoundId | null {
  const c = el?.closest?.(CONTROL);
  if (!c) return null;
  // the in-match touch controls and the game canvas make their own (game) sounds
  if (c.closest('[data-no-ui-sound], .touch, #touch, canvas')) return null;
  if (c.matches(':disabled, [aria-disabled="true"]')) return null;
  if (c.matches('[role="switch"], input[type="checkbox"]')) return 'ui.toggle';
  const label = `${c.getAttribute('aria-label') ?? ''} ${c.textContent ?? ''}`.trim().toLowerCase();
  if (/^(back|close|cancel|leave)\b/.test(label) || c.matches('.back, [data-back]')) return 'ui.back';
  return 'ui.click';
}

/** Listens for clicks and (mouse) hovers on controls. Returns the cleanup. */
export function mountUiSounds(play: (id: SoundId) => void, root: Document = document): () => void {
  let hovered: Element | null = null;
  let hoverAt = 0;
  const onClick = (e: Event) => {
    const id = clickSound(e.target as Element);
    if (id) play(id);
  };
  const onOver = (e: Event) => {
    const pe = e as PointerEvent;
    if (pe.pointerType && pe.pointerType !== 'mouse') return;
    const c = (e.target as Element)?.closest?.(CONTROL) ?? null;
    if (c === hovered) return;
    hovered = c;
    if (!c || clickSound(c) === null) return;
    const now = performance.now();
    if (now - hoverAt < 45) return;
    hoverAt = now;
    play('ui.hover');
  };
  root.addEventListener('click', onClick, true);
  root.addEventListener('pointerover', onOver, true);
  return () => {
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('pointerover', onOver, true);
  };
}

type ShellSlice = Pick<ShellState, 'notice' | 'tuneNote' | 'screen' | 'match' | 'lobby'> & Partial<Pick<ShellState, 'titleHit'>>;

/** The sounds the shell's change from `a` to `b` calls for (pure: tests drive it). */
export function shellCues(a: ShellSlice | null, b: ShellSlice): SoundId[] {
  const out: SoundId[] = [];
  if (!a) return out;
  if (b.notice && b.notice !== a.notice) out.push('ui.toast');
  if (b.tuneNote && b.tuneNote !== a.tuneNote) out.push('ui.toast');
  if (b.screen.name === 'error' && a.screen.name !== 'error') out.push('ui.error');
  // the title screen's press: the war-tone hit as the music starts (shell/screens/Title.tsx)
  if (b.titleHit && b.titleHit !== a.titleHit) out.push('sting.start');
  // the lobby: players joining and leaving, your Ready
  if (a.lobby && b.lobby && a.lobby.code === b.lobby.code) {
    const n0 = a.lobby.players.length;
    const n1 = b.lobby.players.length;
    if (n1 > n0) out.push('ui.join');
    else if (n1 < n0) out.push('ui.leave');
    if (b.lobby.ready && !a.lobby.ready) out.push('ui.ready');
  }
  // the match: the flood and sting as the countdown begins, 3-2-1, GO, the results
  const m0 = a.match;
  const m1 = b.match;
  if (m1) {
    const p0 = m0?.phase ?? -1;
    const p1 = m1.phase;
    if (p1 === MatchPhase.Countdown && p0 !== MatchPhase.Countdown) out.push('ui.flood', 'sting.start');
    if (p1 === MatchPhase.Countdown && m1.secondsLeft >= 1 && m1.secondsLeft <= 3 && (p0 !== MatchPhase.Countdown || m0!.secondsLeft !== m1.secondsLeft)) out.push('ui.count');
    if (p1 === MatchPhase.InProgress && p0 === MatchPhase.Countdown) out.push('ui.go');
    if (p1 === MatchPhase.Ending && p0 === MatchPhase.InProgress) out.push(wonMatch(m1) ? 'ui.win' : 'ui.lose');
  }
  return out;
}

function wonMatch(m: NonNullable<ShellSlice['match']>): boolean {
  const r = m.results;
  if (!r) return m.myScore > 0 && m.myScore >= m.leaderScore;
  const mine = r.standings.find((s) => s.id === m.localId && !s.left);
  return !!mine && mine.key === r.winnerKey;
}

/** Which music should play: the bed in the menus and the lobby, nothing while a match is on. */
export function musicFor(inGame: boolean, s: Pick<ShellState, 'match' | 'screen'>): MusicMode {
  if (!inGame) return s.screen.name === 'boot' ? 'off' : 'menu';
  const phase = s.match?.phase;
  if (phase === MatchPhase.Waiting || phase === MatchPhase.Postgame) return 'lobby';
  return 'off';
}
