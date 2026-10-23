/**
 * The Briefing (docs/design/onboarding-research.md §3.2, card 1; the Pen board "ONBOARDING · tour and
 * spotlight", D2 and P1): one question after "Create your soldier", the first time on this device.
 * "Show me the ropes" (a recruit: First flight, then Live fire) or "I know shooters" (a veteran: Home),
 * with the detected device and Change, and "Skip all training". Plain DOM, like the creator (#/briefing
 * in main.ts); Escape (the route closing) counts as skipping. The phones' fire-mode card (card 2) comes
 * with the phone agent's fire modes (controls research item 3).
 */
import { escapeHtml, ic } from '../locker/tiles';
import { startFitting } from '../ui/fit';
import { mountSprite } from '../ui/sprite';
import css from './briefing.css?inline';
import { BRIEFING_COPY as C, DEVICE_NAMES } from './copy';
import type { Device } from './log';

export type BriefingAnswer = 'recruit' | 'veteran' | 'skipped';

export interface BriefingOptions {
  /** the device detected now */
  device: Device;
  /** once: the answer, the device (as changed), and whether the player changed it */
  onAnswer(answer: BriefingAnswer, device: Device, changed: boolean): void;
}

const ORDER: readonly Device[] = ['touch', 'keyboard', 'pad'];

/** The next device Change offers (Touch → Keyboard and mouse → Controller → Touch). */
export function nextDevice(d: Device): Device {
  return ORDER[(ORDER.indexOf(d) + 1) % ORDER.length]!;
}

export function mountBriefing(container: HTMLElement, o: BriefingOptions): { unmount(): void } {
  mountSprite();
  startFitting();
  const style = document.createElement('style');
  style.textContent = css;
  const fit = document.createElement('div');
  fit.className = 'mf mf-fit mf-br-fit kit-v2';
  fit.innerHTML = `
  <section class="screen screen--menu" data-screen="briefing" aria-labelledby="mf-br-q">
    <div class="bg" aria-hidden="true"><div class="bg__scrim"></div><div class="bg__camo"></div><div class="bg__grid"></div><div class="bg__dots"></div><div class="bg__word">ORDERS</div></div>
    <div class="mf-br">
      <span class="eyebrow mf-br__eyebrow m-p1">${escapeHtml(C.eyebrow)}</span>
      <h1 class="display display--print mf-br__q m-p1" id="mf-br-q">${escapeHtml(C.question)}</h1>
      <div class="mf-br__answers" role="group" aria-labelledby="mf-br-q">
        <button type="button" class="mf-br__answer is-recruit m-p3 m-p8" data-answer="recruit" style="--i:0">
          <b class="display mf-br__t">${escapeHtml(C.recruit)}</b>
          <span class="mf-br__s">${escapeHtml(C.recruitSub)}</span>
          ${ic('arrow-right', 'ic mf-br__go')}
        </button>
        <button type="button" class="mf-br__answer is-veteran m-p3 m-p8" data-answer="veteran" style="--i:1">
          <b class="display mf-br__t">${escapeHtml(C.veteran)}</b>
          <span class="mf-br__s">${escapeHtml(C.veteranSub)}</span>
          ${ic('arrow-right', 'ic mf-br__go')}
        </button>
      </div>
      <p class="mf-br__device">${escapeHtml(C.playingWith)} <b data-device></b> · <button type="button" class="mf-br__link" data-action="change">${escapeHtml(C.change)}</button></p>
      <button type="button" class="mf-br__link mf-br__skip" data-action="skip">${escapeHtml(C.skipAll)}</button>
    </div>
  </section>`;
  container.append(style, fit);
  let device = o.device;
  let answered = false;
  const name = fit.querySelector<HTMLElement>('[data-device]')!;
  const paint = () => (name.textContent = DEVICE_NAMES[device]);
  paint();
  const answer = (a: BriefingAnswer) => {
    if (answered) return;
    answered = true;
    o.onAnswer(a, device, device !== o.device);
  };
  fit.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.answer) answer(b.dataset.answer as BriefingAnswer);
    else if (b.dataset.action === 'change') {
      device = nextDevice(device);
      paint();
    } else if (b.dataset.action === 'skip') answer('skipped');
  });
  fit.querySelector<HTMLButtonElement>('[data-answer="recruit"]')!.focus({ preventScroll: true });
  return {
    unmount() {
      // closed without an answer (Escape, the back button): that's skipping
      answer('skipped');
      fit.remove();
      style.remove();
    },
  };
}
