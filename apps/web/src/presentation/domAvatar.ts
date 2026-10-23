/**
 * The avatar for DOM views that redraw from data (the HUD's scoreboard): the portrait if it's cached, the
 * silhouette with the initial otherwise. Never renders mid-fight (research §7.4: cached only); the lobby
 * warmed everyone's (warm.ts).
 */
import { lookBook } from '../looks/book';
import { peekPortrait, silhouetteUrl } from '../portrait';
import { iconHref } from '../ui/icons';
import '../portrait/portrait.css';

export function avatarElement(doc: Document, id: number, name: string, bot: boolean): HTMLElement {
  const disc = doc.createElement('span');
  disc.className = 'avatar avatar--portrait';
  disc.setAttribute('aria-hidden', 'true');
  const frame = disc.appendChild(doc.createElement('span'));
  frame.className = 'pt';
  const base = frame.appendChild(doc.createElement('img'));
  base.className = 'pt__base';
  base.alt = '';
  base.src = silhouetteUrl(name);
  const look = lookBook.drawn(id);
  const hit = look && peekPortrait({ look, size: 64, pose: 'portrait' });
  if (hit) {
    const img = frame.appendChild(doc.createElement('img'));
    img.className = 'pt__img is-cached';
    img.alt = '';
    img.src = hit.url;
  }
  if (bot) {
    const badge = disc.appendChild(doc.createElement('span'));
    badge.className = 'avatar__bot';
    const svg = badge.appendChild(doc.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    svg.setAttribute('class', 'ic');
    const use = svg.appendChild(doc.createElementNS('http://www.w3.org/2000/svg', 'use'));
    use.setAttribute('href', iconHref('bot'));
  }
  return disc;
}
