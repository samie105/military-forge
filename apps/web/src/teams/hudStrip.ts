/**
 * The HUD's team score strip (team modes, v21; Pen board D6): each team's mark and score at the top
 * centre while a team match runs, yours outlined, the leader in volt, and the kill limit. Plain DOM,
 * updated from the shell's match view (main.ts subscribes it to the store); hidden otherwise.
 */
import { MatchPhase } from '@military-forge/sim';
import type { MatchView } from '../shell/matchView';
import { TEAM_LETTERS, TEAM_NAMES, TEAM_SHAPES } from './palette';
import './teams.css';

export class TeamStrip {
  private readonly root: HTMLElement;
  private shape = '';

  constructor(parent: HTMLElement = document.body) {
    this.root = parent.appendChild(document.createElement('div'));
    this.root.className = 'mf-tstrip';
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
  }

  update(view: MatchView | null): void {
    const teams = view?.teams ?? 0;
    const show = !!view && teams > 0 && view.phase === MatchPhase.InProgress;
    this.root.hidden = !show;
    if (!show) return;
    const scores = view.teamScores ?? [];
    const top = Math.max(...scores, 0);
    const leaders = scores.filter((s) => s === top).length;
    const shape = `${teams}:${view.myTeam ?? -1}:${view.killLimit}`;
    if (shape !== this.shape) {
      this.shape = shape;
      this.root.replaceChildren(
        ...Array.from({ length: teams }, (_, t) => {
          const box = document.createElement('span');
          box.className = t === view.myTeam ? 'mf-tstrip__team is-mine' : 'mf-tstrip__team';
          box.style.setProperty('--tc', `var(--c-team-${t}, currentColor)`);
          box.setAttribute('aria-label', `Team ${TEAM_NAMES[t]}`);
          const mark = box.appendChild(document.createElement('i'));
          mark.className = 'mf-tstrip__shape';
          mark.textContent = `${TEAM_SHAPES[t]}${TEAM_LETTERS[t]}`;
          box.appendChild(document.createElement('b')).className = 'mf-tstrip__score';
          return box;
        }),
      );
      if (view.killLimit > 0) {
        const limit = this.root.appendChild(document.createElement('span'));
        limit.className = 'mf-tstrip__limit';
        limit.textContent = `/ ${view.killLimit}`;
      }
    }
    [...this.root.querySelectorAll<HTMLElement>('.mf-tstrip__team')].forEach((box, t) => {
      const score = String(scores[t] ?? 0);
      const b = box.querySelector('b')!;
      if (b.textContent !== score) b.textContent = score;
      box.classList.toggle('is-lead', (scores[t] ?? 0) === top && leaders === 1 && top > 0);
    });
  }
}
