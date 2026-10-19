/** What every screen shares: the controller (navigation, API, settings) and small hooks. */
import { createContext, useContext, useEffect, useState } from 'react';
import type { ShellController } from './controller';

export const ControllerContext = createContext<ShellController | null>(null);

export function useCtl(): ShellController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('no shell controller');
  return c;
}

type KeyboardWithLayout = Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } };

/** navigator.keyboard's layout map (Chromium), so keys show what the player's keyboard prints. */
export function useKeyboardLayout(): ReadonlyMap<string, string> | null {
  const [layout, setLayout] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    let live = true;
    (navigator as KeyboardWithLayout).keyboard
      ?.getLayoutMap?.()
      .then((m) => live && setLayout(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return layout;
}

/** A value that ticks every `ms` while mounted (screens that show live numbers: ping, clocks). */
export function useTicker(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((x) => x + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return n;
}

/** The server's round trip as the home and room screens show it: the API's, measured every 10 s. */
export function useServerPing(): number {
  // no controller (a screen rendered on its own, in tests): no ping
  const ctl = useContext(ControllerContext);
  const [ms, setMs] = useState(-1);
  useEffect(() => {
    if (!ctl) return undefined;
    let live = true;
    const measure = () =>
      ctl.api.ping().then(
        (v) => live && setMs(v),
        () => live && setMs(-1),
      );
    void measure();
    const t = window.setInterval(() => void measure(), 10_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [ctl]);
  return ms;
}
