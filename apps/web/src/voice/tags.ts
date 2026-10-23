/**
 * Speaking tags (voice chat): a small mic badge with a pulsing ring over each soldier you're
 * hearing right now, and over you while you talk. Plain DOM over the game, moved by transform
 * each frame (no React, no layout), in window pixels from the game's camera (HudInput.toScreen).
 * Last words show from where the soldier fell; a voice heard only by radio or party (no soldier
 * near) has no tag: the strip lists it.
 */
import type { Frame } from '../view';
import type { VoiceState } from './voice';

/** How high over the feet the tag sits (m): over the name. */
const LIFT = 2.45;

export class SpeakingTags {
  private readonly root: HTMLElement;
  private readonly tags = new Map<number, HTMLElement>();

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'vc-tags';
    this.root.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.root);
  }

  update(f: Frame | null, st: VoiceState, toScreen: ((x: number, y: number) => { x: number; y: number }) | null, name: (id: number) => string): void {
    const live = new Set<number>();
    if (f && toScreen && st.active) {
      const talking = new Map<number, { level: number; lastWords: boolean }>();
      for (const [id, s] of Object.entries(st.speaking)) talking.set(Number(id), { level: s.level, lastWords: s.lastWords });
      if (st.talking && f.localId >= 0) talking.set(f.localId, { level: st.level, lastWords: false });
      for (const p of f.players) {
        const t = talking.get(p.id);
        if (!t) continue;
        const at = toScreen(p.x, p.y + LIFT);
        let el = this.tags.get(p.id);
        if (!el) {
          el = document.createElement('span');
          el.className = 'vc-tag';
          el.innerHTML = '<i class="vc-tag__ring"></i><svg class="ic" aria-hidden="true"><use href="#icon-sx-mic"/></svg><b></b>';
          this.root.appendChild(el);
          this.tags.set(p.id, el);
        }
        const label = el.querySelector('b')!;
        const text = t.lastWords ? `${name(p.id)} · last words` : p.id === f.localId ? 'You' : name(p.id);
        if (label.textContent !== text) label.textContent = text;
        el.classList.toggle('is-last', t.lastWords);
        el.style.setProperty('--lvl', String(t.level / 15));
        el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -100%)`;
        live.add(p.id);
      }
    }
    for (const [id, el] of this.tags) {
      if (live.has(id)) continue;
      el.remove();
      this.tags.delete(id);
    }
  }
}
