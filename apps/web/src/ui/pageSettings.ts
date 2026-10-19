/**
 * The player's saved Text size, Reduce motion and Reduce flashes on a page of its own (the Locker
 * and the Armory, locker.html / armory.html), the way the app applies them (main.ts applySettings):
 * --text-scale, html.reduce-motion, html.reduce-flashes and html.mf-big-text (from 130 %).
 */
import { loadSettings } from '../shell/controller';

export function applyPageSettings(html: HTMLElement = document.documentElement): void {
  const s = loadSettings();
  html.style.setProperty('--text-scale', String(s.textScale));
  html.classList.toggle('mf-big-text', s.textScale >= 1.3);
  html.classList.toggle('reduce-motion', s.reduceMotion);
  html.classList.toggle('reduce-flashes', s.reduceFlashes);
}
