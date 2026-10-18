/**
 * Scripted dummy targets (docs/12 §5 week 2). They produce Inputs exactly like a human would,
 * so the sim can't tell them apart.
 */
import { PI, angleToU16, hash4, hashToUnit, simAtan2 } from '@military-forge/shared';
import { smokeBlocks } from './clouds';
import type { Game } from './game';
import { blindIntensity } from './grenades';
import { Btn, type Input } from './input';
import { hitboxLayout, type PlayerState } from './player';

/** How far (radians, either way) a fully blinded bot's gaze strays from its target. */
const BLIND_AIM_ERROR = 1.2;

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

  // look at the nearest human it can see (purely cosmetic for dummies): smoke hides you from bots
  // (clouds.ts), and a flashbang leaves them staring off target while they're blind
  let best = Infinity;
  let aim = PI;
  let hidden = false;
  const eyeY = p.y + hitboxLayout(p).head.y;
  for (const q of game.players) {
    if (!q || q.isBot || !q.alive) continue;
    if (smokeBlocks(game, p.x, eyeY, q.x, q.y + 0.75)) {
      hidden = true;
      continue;
    }
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      aim = simAtan2(dy, dx);
    }
  }
  if (best === Infinity && hidden) return; // everyone is in the smoke: hold its gaze
  const blind = blindIntensity(p);
  if (blind > 0) aim += (2 * hashToUnit(hash4(game.seed, game.tick >> 3, 0x5f000 + p.id, 0)) - 1) * BLIND_AIM_ERROR * blind;
  out.aim = angleToU16(aim);
}
