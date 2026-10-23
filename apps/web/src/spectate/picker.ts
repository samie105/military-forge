/**
 * The desktop spectator's player picker (Pen board "SPECTATE", frame B): who's in the match, best
 * first, alive or down, the one you watch in volt. A click follows (input.ts reads
 * `data-spec-follow`). Rebuilt only when a row changes.
 */
import type { SpectateView } from './director';

export class SpectatePicker {
  private readonly el: HTMLOListElement;
  private key = '';

  constructor(parent: Element) {
    this.el = document.createElement('ol');
    this.el.className = 'mf-spec-pick plate';
    this.el.setAttribute('aria-label', 'Players: pick one to watch');
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  update(view: SpectateView | null): void {
    const rows = view?.kind === 'watch' ? view.rows : [];
    const key = rows.map((r) => `${r.id}:${r.name}:${r.alive ? 1 : 0}:${r.kills}:${r.deaths}:${r.followed ? 1 : 0}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = rows.length === 0;
    const head = `<li class="mf-spec-pick__head hud-label">Players · ${rows.length}</li>`;
    this.el.innerHTML =
      head +
      rows
        .map(
          (r) =>
            `<li><button type="button" class="mf-spec-pick__row${r.followed ? ' is-on' : ''}${r.alive ? '' : ' is-down'}" data-spec-follow="${r.id}"><i class="mf-spec-pick__dot" aria-hidden="true"></i><span class="mf-spec-pick__name">${escapeHtml(r.name)}</span><span class="mf-spec-pick__kd num">${r.alive ? `${r.kills} / ${r.deaths}` : 'Down'}</span></button></li>`,
        )
        .join('');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
