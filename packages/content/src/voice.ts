/**
 * Voice chat's numbers (v18, docs/05 §17): how far a soldier's voice carries, how it fades, how long
 * a fallen soldier's last words last, and how many voices one player hears at once. The owner tunes
 * them on the admin page (admin.ts, group "Voice chat"); they reach every client with OVERRIDES like
 * the other admin numbers, so the game server's routing and each client's 3D fade agree.
 */
export const VOICE = {
  /** how far (m) a voice carries out loud: the server sends it to nobody farther */
  radius: 24,
  /** full volume up to this (m), then fading to nothing at `radius` */
  falloffStart: 4,
  /** last words: seconds a dead soldier's mic stays live at the death spot, for those near it */
  lastWords: 6,
  /** most voices one player gets at once (party and team first, then the nearest): phones decode only so many */
  maxSpeakers: 4,
};

export type VoiceConfig = typeof VOICE;
