/**
 * `?tourlog`: the onboarding log on the page (a dev and playtest readout, docs/design/onboarding-research.md
 * §6.1): the First flight funnel, the facts that drive Next orders, and the last events. Read-only;
 * "Clear" empties the log on this device.
 */
import { funnel, UPLOAD_ENABLED } from './log';
import type { TourMemory } from '.';

export function mountTourReadout(memory: TourMemory, parent: HTMLElement = document.body): () => void {
  const el = document.createElement('aside');
  el.className = 'mf-tourlog';
  el.setAttribute('aria-label', 'Onboarding log');
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:2147483000;width:min(460px,calc(100vw - 16px));max-height:60vh;overflow:auto;' +
    'padding:10px 12px;background:rgba(7,8,6,.92);color:#f2eedf;font:12px/1.4 ui-monospace,Menlo,monospace;border:1px solid #3c4430;border-radius:6px';
  parent.append(el);
  const draw = () => {
    const f = memory.facts.get();
    const entries = memory.log.entries();
    const rows = funnel(entries, 'first-flight')
      .map((r) => `${r.step.padEnd(10)} shown ${r.shown} · done ${r.done} · skipped ${r.skipped}${r.medianMs !== null ? ` · median ${(r.medianMs / 1000).toFixed(1)} s` : ''}`)
      .join('\n');
    const last = entries
      .slice(-30)
      .reverse()
      .map((e) => {
        const { t, at, ...rest } = e;
        return `${new Date(at).toLocaleTimeString()} ${t} ${JSON.stringify(rest)}`;
      })
      .join('\n');
    el.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;color:#d6ff3b;font-weight:700';
    head.textContent = `TOUR LOG · ${entries.length} events · ${(memory.log.bytes() / 1024).toFixed(1)} KB · upload ${UPLOAD_ENABLED ? 'on' : 'off'}`;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.style.cssText = 'font:inherit;color:#0e100b;background:#d6ff3b;border:0;padding:0 8px;cursor:pointer';
    clear.onclick = () => {
      memory.log.clear();
      draw();
    };
    head.append(clear);
    const pre = (title: string, text: string) => {
      const h = document.createElement('div');
      h.textContent = title;
      h.style.cssText = 'margin-top:6px;color:#d9b25f;font-weight:700';
      const p = document.createElement('pre');
      p.textContent = text || '—';
      p.style.cssText = 'margin:2px 0 0;white-space:pre-wrap';
      el.append(h, p);
    };
    el.append(head);
    pre('FIRST FLIGHT FUNNEL', rows);
    pre(
      'FACTS',
      `sessions ${f.sessions} · device ${f.lastDevice ?? '—'} (${f.devices.join(', ') || '—'}) · ${f.experience ?? 'not asked'}${f.promoted ? ' · promoted' : ''}${f.invited ? ' · invited' : ''}\n` +
        `matches ${f.matches.local} local · ${f.matches.online} online · ${f.matches.finished} finished · kills ${f.kills}\n` +
        `deaths ${Object.entries(f.deaths).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(', ') || '—'}\n` +
        `moves ${Object.entries(f.moves).filter(([, n]) => n).map(([m, n]) => `${m} ${n}`).join(', ') || '—'}\n` +
        `rooms ${f.rooms.created} made · ${f.rooms.joined} joined · ${f.rooms.local} local · screens ${f.screens.join(', ') || '—'}`,
    );
    pre('LAST EVENTS', last);
  };
  draw();
  const timer = window.setInterval(draw, 1000);
  return () => {
    window.clearInterval(timer);
    el.remove();
  };
}
