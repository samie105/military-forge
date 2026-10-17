/**
 * Scripted dummy targets (docs/12 §5 week 2). They produce Inputs exactly like a human would,
 * so the sim can't tell them apart.
 */
import { PI, angleToU16, simAtan2 } from '@military-forge/shared';
import type { Game } from './game';
import { Btn, type Input } from './input';
import type { PlayerState } from './player';

export function botInput(game: Game, p: PlayerState, out: Input): void {
  out.buttons = 0;
  out.weaponSelect = 0;
  out.throwStrength = 7;
  const s = p.script;
  if (s) {
    switch (s.kind) {
      case 'strafe':
      case 'strafeJet':
        if (p.x >= s.maxX) p.botDir = -1;
        else if (p.x <= s.minX) p.botDir = 1;
        out.buttons |= p.botDir > 0 ? Btn.Right : Btn.Left;
        if (s.kind === 'strafeJet' && game.tick % s.periodTicks < s.burstTicks) out.buttons |= Btn.Jet;
        break;
      case 'jet':
        if (game.tick % s.periodTicks < s.burstTicks) out.buttons |= Btn.Jet;
        break;
      case 'crouch':
        if (game.tick % s.periodTicks < s.periodTicks / 2) out.buttons |= Btn.Down;
        break;
      case 'idle':
        break;
    }
  }

  // look at the nearest human (purely cosmetic for dummies)
  let best = Infinity;
  let aim = PI;
  for (const q of game.players) {
    if (!q || q.isBot || !q.alive) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      aim = simAtan2(dy, dx);
    }
  }
  out.aim = angleToU16(aim);
}
