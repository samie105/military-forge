/**
 * Home's state and what it shows (homeState.ts), read live by the desktop and phone Homes: the profile
 * from the shell's store, the device's under-18 answer (age.ts) and the matches finished here (tour facts).
 */
import { useStore } from 'zustand';
import { useTourFacts } from '../tour/live';
import { ageOnDevice } from './age';
import type { ShellController } from './controller';
import { homePlan, homeState, type HomePlan } from './homeState';
import type { ShellStore } from './store';

export function useHomePlan(store: ShellStore): HomePlan {
  const profile = useStore(store, (s) => s.profile);
  const finished = useTourFacts()?.matches.finished ?? 0;
  return homePlan(homeState(profile, ageOnDevice()?.adult === false, finished));
}

/** The poster's primary action for a plan (Enter on Home presses it too): Play now, or Training (UX-01, UX-15). */
export function homePrimary(ctl: Pick<ShellController, 'playNow' | 'go'>, plan: Pick<HomePlan, 'primary'>): void {
  if (plan.primary === 'play') ctl.playNow();
  else ctl.go({ to: 'training' });
}
