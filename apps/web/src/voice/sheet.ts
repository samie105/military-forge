/**
 * The comms sheet's open state: the radio's tap opens it, the desktop pause menu's Comms button too;
 * one sheet for everything voice (how you talk, volume, who's here, mutes).
 */
import { createStore } from 'zustand/vanilla';

export const commsSheet = createStore<{ open: boolean }>(() => ({ open: false }));

export const openComms = (): void => commsSheet.setState({ open: true });
export const closeComms = (): void => commsSheet.setState({ open: false });
