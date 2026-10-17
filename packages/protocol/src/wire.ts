/** Message ids and small encoding helpers shared by every message module. */
import { POS_INV, toFixed } from '@military-forge/shared';

export const MsgType = {
  Hello: 0x01,
  Welcome: 0x02,
  Ping: 0x03,
  Pong: 0x04,
  Input: 0x10,
  Cmd: 0x11,
  Snapshot: 0x21,
  Roster: 0x25,
  /** the room's tuning changed (dev live tuning): keeps every client's prediction in step */
  Tuning: 0x26,
  /** dev only: server-side debug views (lag-compensation rewinds) */
  Debug: 0x30,
  Kick: 0x3f,
} as const;

/** Player ids travel as u5; 31 means "nobody" (world damage, no target). */
export const NO_PLAYER = 31;
export const pid = (id: number): number => (id >= 0 && id < NO_PLAYER ? id : NO_PLAYER);
export const unPid = (id: number): number => (id === NO_PLAYER ? -1 : id);
/** metres → 1/1024 fixed point */
export const pos = (v: number): number => toFixed(v, POS_INV);
