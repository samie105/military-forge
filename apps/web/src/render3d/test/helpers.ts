import type { PlayerView } from '../../view';

/** A living, grounded, armed player view; override what the test needs. */
export function playerView(over: Partial<PlayerView> = {}): PlayerView {
  return {
    id: 0,
    name: 'P',
    isBot: false,
    isLocal: true,
    alive: true,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    grounded: true,
    crouched: false,
    jetting: false,
    aim: 0,
    hp: 100,
    fuel: 100,
    fuelRegenDelay: 0,
    frags: 3,
    active: 0,
    dual: false,
    weapons: [
      { def: 0, mag: 6, reserve: 30, reloadTicks: 0 },
      { def: 1, mag: 40, reserve: 250, reloadTicks: 0 },
    ],
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
    ...over,
  };
}
