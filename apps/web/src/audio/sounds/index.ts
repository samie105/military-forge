/** Every sound in the game, by id: the bank renders from here, the board lists it. */
import { uiSounds } from './ui';
import { weaponSounds } from './weapons';
import { worldSounds } from './world';
import type { SoundDef } from './types';

const ALL = { ...weaponSounds, ...worldSounds, ...uiSounds };

export type SoundId = keyof typeof ALL;

export const SOUNDS: Readonly<Record<SoundId, SoundDef>> = ALL;

export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[];

export const isSoundId = (id: string): id is SoundId => Object.prototype.hasOwnProperty.call(SOUNDS, id);

export type { Bus, RenderCtx, Rendered, SoundDef } from './types';
