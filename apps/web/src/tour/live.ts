/**
 * The onboarding memory for the React screens: main.ts provides it once the shell is up, and Home's Next
 * orders read the facts live (useSyncExternalStore on the FactStore). Null before then, and in the
 * debug client.
 */
import { useSyncExternalStore } from 'react';
import type { TourMemory } from './index';
import type { Facts } from './facts';

let memory: TourMemory | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

export function provideTourMemory(m: TourMemory | null): void {
  unsubscribe?.();
  memory = m;
  unsubscribe = m ? m.facts.subscribe(() => listeners.forEach((fn) => fn())) : null;
  listeners.forEach((fn) => fn());
}

export function liveTourMemory(): TourMemory | null {
  return memory;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The facts now (a new object on every change), or null without the memory. */
export function useTourFacts(): Facts | null {
  const get = () => memory?.facts.get() ?? null;
  return useSyncExternalStore(subscribe, get, get); // the third: a static render (tests) reads it too
}
