/**
 * The spotlight from React (ui/spotlight.ts): one overlay for the component's life. `step` null
 * hides it; a new step moves to it. The handlers are read when they fire, so they may change freely.
 */
import { useEffect, useRef } from 'react';
import { Spotlight, type SpotStep, type SpotlightOptions } from './spotlight';

export interface SpotHandlers {
  onSkip?: (id: string, all: boolean) => void;
  onPrimary?: (id: string) => void;
}

export function useSpotlight(step: SpotStep | null, handlers: SpotHandlers = {}, options?: SpotlightOptions): void {
  const spot = useRef<Spotlight | null>(null);
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    const s = new Spotlight(options);
    s.onSkip = (id, all) => h.current.onSkip?.(id, all);
    s.onPrimary = (id) => h.current.onPrimary?.(id);
    spot.current = s;
    return () => {
      s.dispose();
      spot.current = null;
    };
    // the options are read once: one overlay per mount
  }, []);
  useEffect(() => {
    const s = spot.current;
    if (!s) return;
    if (step) s.show(step);
    else void s.hide();
  }, [step]);
}
