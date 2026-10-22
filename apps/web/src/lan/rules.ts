/** A local room's settings, shared by the page (host.ts) and its room worker (roomWorker.ts). */
import { createMatchRules, type MatchRules } from '@military-forge/sim';

/** The rules a local room starts with (a coded room's: game-server rooms.ts CUSTOM_ROOM_RULES). */
export const LOCAL_ROOM_RULES: Readonly<MatchRules> = createMatchRules({ timeLimit: 300, killLimit: 20, onNoRematch: 'lobby' });

export interface RoomWorkerOptions {
  seed: number;
  mapId?: string;
  fillBots?: { target: number; level: 'easy' | 'normal' | 'hard' } | null;
}
