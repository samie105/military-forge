/** Standalone Armory page (/armory.html) until W4's shell hosts the Armory as a route. */
import { GAME_NAME } from '@military-forge/shared';
import { applyPageSettings } from '../ui/pageSettings';
import type { LightPreset } from '../locker/turntable';
import { mountArmory } from '.';

applyPageSettings();
document.title = `${GAME_NAME} · Armory`;
const params = new URLSearchParams(location.search);
const armory = mountArmory(document.getElementById('armory')!, {
  onExit: () => location.assign('/'),
  weapon: params.get('weapon') ?? undefined,
  flashHoldMs: Number(params.get('hold') ?? 0),
  fxFreezeS: params.has('freeze') ? Number(params.get('freeze')) : undefined,
  focus: params.get('focus') ?? undefined,
  light: (params.get('light') as LightPreset | null) ?? undefined,
  fire: params.has('fire'),
  attach: params.get('attach')?.split(',').filter(Boolean),
  camo: params.get('camo') ?? undefined,
  fireTint: params.get('tint') ?? undefined,
});

// Dev-only hook for automated screenshots and console poking (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { __armory: armory });
