/** The physical pad, on the map. Reuses the prompt glyphs and the player's actual bindings. */
import { currentDevice, currentPadFamily } from './device';
import { padButtonOf, padGlyphSvg, padSpoken, type GlyphFamily } from './glyphs';
import type { PadManager } from './manager';
import { PAD_ACTIONS, type PadSettings } from './settings';
import { isDualSense, padFamily } from './standard';

/** A photo shell with scalable input targets; these coordinates belong to the three local assets. */
function photoDiagram(family: GlyphFamily): string {
  const specs = {
    playstation: { image: 'controller-dualsense.webp', face: [[1250, 401], [1353, 301], [1145, 302], [1250, 201]], dpad: [[281, 214], [281, 374], [208, 301], [355, 301]], sticks: [[512, 488], [1024, 488]], centre: [[404, 154], [1132, 154], [768, 560], [768, 250]], shoulder: [[298, 38], [1238, 38], [298, 10], [1238, 10]] },
    xbox: { image: 'controller-xbox.webp', face: [[1145, 430], [1235, 335], [1045, 335], [1145, 239]], dpad: [[572, 476], [572, 592], [514, 534], [630, 534]], sticks: [[394, 322], [972, 534]], centre: [[669, 325], [872, 325], [768, 224], [768, 406]], shoulder: [[330, 78], [1205, 78], [330, 30], [1205, 30]] },
    nintendo: { image: 'controller-switch.webp', face: [[1173, 396], [1273, 309], [1068, 309], [1173, 207]], dpad: [[577, 471], [577, 589], [519, 531], [635, 531]], sticks: [[372, 284], [958, 506]], centre: [[619, 229], [918, 229], [768, 330], [768, 448]], shoulder: [[330, 78], [1205, 78], [330, 30], [1205, 30]] },
  } as const;
  const spec = specs[family];
  const face = (b: number, x: number, y: number, shape: string) => `<g class="mf-dualsense__face mf-dualsense__face--${b}" data-pad-button="${b}" transform="translate(${x} ${y})"><circle r="49"/><path d="${shape}"/></g>`;
  const target = (b: number, x: number, y: number, r = 36) => `<circle class="mf-dualsense__target" data-pad-button="${b}" cx="${x}" cy="${y}" r="${r}"/>`;
  const shapes = ['M-22-22 22 22M22-22-22 22', 'M0-26a26 26 0 1 0 0 52a26 26 0 1 0 0-52', 'M-23-23H23V23H-23Z', 'M0-28 29 23H-29Z'];
  const labels = family === 'xbox' ? ['A', 'B', 'X', 'Y'] : ['B', 'A', 'Y', 'X'];
  const faces = spec.face.map(([x, y], b) => family === 'playstation'
    ? face(b, x, y, shapes[b]!)
    : `<g class="mf-photo-face mf-photo-face--${family} mf-photo-face--${b}" data-pad-button="${b}" transform="translate(${x} ${y})"><circle r="48"/><text text-anchor="middle" dominant-baseline="central">${labels[b]}</text></g>`).join('');
  return `<div class="mf-pad-layout__photo mf-pad-layout__photo--${family}"><img src="/assets/${spec.image}" alt="" draggable="false"/><svg class="mf-pad-layout__drawing mf-dualsense" viewBox="0 0 1536 1024" aria-hidden="true">
    ${faces}
    ${spec.dpad.map(([x, y], i) => target(12 + i, x, y, 43)).join('')}
    ${spec.centre.map(([x, y], i) => family === 'playstation' && i === 3 ? '<rect class="mf-dualsense__target" data-pad-button="17" x="464" y="58" width="608" height="294" rx="55"/>' : target([8, 9, 16, 17][i]!, x, y, 38)).join('')}
    ${spec.shoulder.map(([x, y], i) => target(4 + i, x, y, 57)).join('')}
    ${spec.sticks.map(([x, y], i) => `<g data-pad-stick="${i}" transform="translate(${x} ${y})"><g data-pad-knob="${i}">${target(10 + i, 0, 0, 82)}</g></g>`).join('')}
  </svg></div>`;
}

/** Standard positions, including Nintendo's reversed letters. */
export function controllerDiagram(family: GlyphFamily, dualSense = false, known = true): string {
  if (known && (family !== 'playstation' || dualSense)) return photoDiagram(family);
  const symmetric = family === 'playstation';
  const left = symmetric ? [91, 104] : [59, 64];
  const dpad = symmetric ? [55, 66] : [93, 104];
  const button = (i: number, x: number, y: number) => `<g class="mf-pad-layout__button" data-pad-button="${i}" transform="translate(${x - 12} ${y - 12})">${padGlyphSvg(`Pad${i}`, family)}</g>`;
  return `<svg class="mf-pad-layout__drawing" viewBox="0 0 260 160" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path class="mf-pad-layout__body" d="M65 29C43 28 30 40 24 65L12 123C7 148 24 155 39 138L67 116Q130 132 193 116L221 138C236 155 253 148 248 123L236 65C230 40 217 28 195 29Z"/>
    ${symmetric ? '<rect class="mf-pad-layout__touch" data-pad-button="17" x="96" y="39" width="68" height="36" rx="8"/>' : '<path d="M112 49h36" opacity=".25"/>'}
    ${button(6, 56, 12)}${button(7, 198, 12)}${button(4, 56, 34)}${button(5, 198, 34)}
    ${button(3, 202, 52)}${button(2, 181, 73)}${button(1, 223, 73)}${button(0, 202, 94)}
    <g transform="translate(${dpad[0]} ${dpad[1]})">${[12, 15, 13, 14].map((b, i) => `<path class="mf-pad-layout__button" data-pad-button="${b}" transform="rotate(${i * 90})" d="M-5-19H5V-7L0-2-5-7Z"/>`).join('')}</g>
    ${button(8, 84, 53)}${button(9, 176, 53)}${button(16, 130, 94)}
    <g data-pad-stick="0" transform="translate(${left[0]} ${left[1]})"><circle class="mf-pad-layout__well" r="17"/><g data-pad-knob="0">${button(10, 0, 0)}</g></g>
    <g data-pad-stick="1" transform="translate(${symmetric ? '169 104' : '166 111'})"><circle class="mf-pad-layout__well" r="17"/><g data-pad-knob="1">${button(11, 0, 0)}</g></g>
  </svg>`;
}

export class ControllerOverlay {
  private el: HTMLElement | null = null;
  private family: GlyphFamily | null = null;
  private settings: PadSettings | null = null;
  private id = '';
  private menu = false;
  private cueKey = '';
  private buttons: Element[] = [];
  private knobs: Element[] = [];

  constructor(private readonly manager: PadManager) {}

  /** Called after each controller poll so play and menu selections both show live feedback. */
  update(): void {
    const m = this.manager;
    const state = m.state;
    const visible = currentDevice().kind === 'pad' && m.settings.enabled && m.settings.showLayout && state.connected;
    if (!visible) {
      if (this.el) this.el.hidden = true;
      return;
    }
    const pad = m.active;
    if (!pad) {
      if (this.el) this.el.hidden = true;
      return;
    }
    const phone = document.documentElement.hasAttribute('data-touch-controls');
    const menu = state.mode !== 'play';
    const parent = menu ? document.body : document.querySelector<HTMLElement>(phone ? '#hud .mf-hud-phone .hud' : '#hud .mf-hud-desktop .hud-tl');
    if (!parent) return;
    if (!this.el?.isConnected) {
      this.el = document.createElement('aside');
      this.el.className = 'mf-pad-layout plate';
      this.el.setAttribute('aria-label', 'Controller layout');
      parent.appendChild(this.el);
      this.family = null;
    }
    if (this.el.parentElement !== parent) parent.appendChild(this.el);
    this.el.classList.toggle('mf-pad-layout--phone', phone);
    this.el.classList.toggle('mf-pad-layout--menu', menu);
    const family = currentPadFamily();
    if (family !== this.family || this.settings !== m.settings || this.id !== pad.id || this.menu !== menu) {
      this.family = family;
      this.settings = m.settings;
      this.id = pad.id;
      this.menu = menu;
      this.cueKey = '';
      const known = padFamily(pad.id);
      const title = known === 'playstation' ? (isDualSense(pad.id) ? 'DualSense · PS5' : 'PlayStation') : known === 'xbox' ? 'Xbox' : known === 'nintendo' ? 'Nintendo' : 'Controller';
      this.el.innerHTML = `<div class="mf-pad-layout__top"><span>CONNECTED INPUT</span><span class="mf-pad-layout__status"><i class="mf-pad-layout__light"></i> LIVE</span></div><div class="mf-pad-layout__head"><b>${title}</b><span>${menu ? 'MENU' : 'FIELD CONTROLS'}</span></div>${controllerDiagram(family, isDualSense(pad.id), known !== 'generic')}<div class="mf-pad-layout__cue" hidden></div><div class="mf-pad-layout__legend"></div><div class="mf-pad-layout__sticks">${padGlyphSvg(m.settings.swapSticks ? 'PadRS' : 'PadLS', family)} ${menu ? 'Navigate' : 'Move'} ${padGlyphSvg(m.settings.swapSticks ? 'PadLS' : 'PadRS', family)} ${menu ? 'Scroll' : 'Aim'}</div>`;
      const legend = this.el.querySelector('.mf-pad-layout__legend')!;
      const rows = menu
        ? [{ label: 'Select', buttons: [0] }, { label: 'Back', buttons: [1] }, { label: 'Navigate', buttons: [12] }, { label: 'Tabs', buttons: [4, 5] }]
        : PAD_ACTIONS.filter((a) => ['jet', 'reload', 'swap', 'interact'].includes(a.id)).map((a) => ({ label: a.id === 'interact' ? (m.settings.holdTake && !m.settings.bindings.interact.length ? 'Take (hold reload)' : 'Take / use') : a.label.replace(' (hold)', ''), buttons: a.id === 'interact' && m.settings.holdTake ? [...m.settings.bindings.reload.slice(0, 1), ...m.settings.bindings.interact] : m.settings.bindings[a.id] }));
      for (const rowData of rows) {
        const row = document.createElement('span');
        row.className = 'mf-pad-layout__action';
        row.dataset.padButtons = rowData.buttons.join(',');
        for (const b of rowData.buttons) {
          const icon = document.createElement('span');
          icon.innerHTML = padGlyphSvg(`Pad${b}`, family);
          icon.setAttribute('aria-label', padSpoken(`Pad${b}`, family));
          row.append(icon);
        }
        row.append(rowData.label);
        legend.append(row);
      }
      this.buttons = [...this.el.querySelectorAll('[data-pad-button]')];
      this.knobs = [...this.el.querySelectorAll('[data-pad-knob]')];
    }
    this.el.hidden = false;
    for (const el of this.buttons) {
      const button = pad.buttons[Number(el.getAttribute('data-pad-button'))];
      el.classList.toggle('is-pressed', !!button && (button.pressed || button.value > 0.5));
    }
    const prompt = menu ? { button: 0, label: 'Select' } : this.gamePrompt();
    const cueKey = prompt ? `${prompt.button}:${prompt.label}:${family}` : '';
    if (cueKey !== this.cueKey) {
      this.cueKey = cueKey;
      const cue = this.el.querySelector<HTMLElement>('.mf-pad-layout__cue')!;
      cue.hidden = !prompt;
      if (prompt) {
        cue.innerHTML = `<span class="mf-pad-layout__cue-icon">${padGlyphSvg(`Pad${prompt.button}`, family)}</span><span><small>PRESS ON CONTROLLER</small><b></b></span>`;
        cue.querySelector('b')!.textContent = prompt.label;
      }
      for (const el of this.buttons) el.classList.toggle('is-cued', !!prompt && Number(el.getAttribute('data-pad-button')) === prompt.button);
      for (const row of this.el.querySelectorAll<HTMLElement>('.mf-pad-layout__action')) row.classList.toggle('is-cued', !!prompt && (row.dataset.padButtons?.split(',').includes(String(prompt.button)) ?? false));
    }
    for (const el of this.knobs) {
      const i = Number(el.getAttribute('data-pad-knob')) * 2;
      const travel = family === 'playstation' && isDualSense(pad.id) ? 20 : 6;
      el.setAttribute('transform', `translate(${((pad.axes[i] ?? 0) * travel).toFixed(1)} ${((pad.axes[i + 1] ?? 0) * travel).toFixed(1)})`);
    }
  }

  /** The visible pickup prompt is the game action the physical controller should point at now. */
  private gamePrompt(): { button: number; label: string } | null {
    for (const cap of document.querySelectorAll<HTMLElement>('#hud .pickup .kbd--pad[data-pad-code], #hud .mf-rack-sign .kbd--pad[data-pad-code]')) {
      if (!cap.getClientRects().length) continue;
      let visible = true;
      for (let node: HTMLElement | null = cap; node && node.id !== 'hud'; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) < 0.05) { visible = false; break; }
      }
      if (!visible) continue;
      const button = padButtonOf(cap.dataset.padCode ?? '');
      if (button < 0) continue;
      const pickup = cap.closest('.pickup');
      const verb = pickup?.querySelector('[data-bind="pickup.verb"]')?.textContent?.trim();
      return { button, label: verb ? `${verb} weapon` : 'Take weapon' };
    }
    return null;
  }
}
