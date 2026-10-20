/**
 * The room's bots (the owner's "sometimes I don't want bots", protocol v17): the host picks Off,
 * Fill to 4 or Fill to 8 and a level, in the lobby's rules (desktop and phone) and in Tune the game;
 * it applies at once (the server adds or removes bots on its next tick, mid-match too), stays with
 * the room, and every guest sees it (MATCH_STATE's rules: bots, botLevel).
 */
import { BOT_LEVELS_WIRE, ROOM_BOT_CHOICES, type BotLevelWire } from '@military-forge/protocol';
import { blurAfter } from '../ui/Screen';

export type BotLevel = BotLevelWire;
export const BOT_LEVELS: readonly BotLevel[] = BOT_LEVELS_WIRE;
export const BOT_LEVEL_NAMES: Readonly<Record<BotLevel, string>> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

/** The fills to offer: Off, 4, 8, and the room's own when it's another (a server started with --bots=3). */
export function botFillChoices(current: number): number[] {
  const choices: number[] = [...ROOM_BOT_CHOICES];
  if (!choices.includes(current)) choices.push(current);
  return choices.sort((a, b) => a - b);
}

/** "Off", "Fill to 4". */
export const botFillLabel = (n: number): string => (n === 0 ? 'Off' : `Fill to ${n}`);

/** The rules line's words: "No bots", "Bots fill to 4 · Normal". */
export const botsLine = (bots: number, level: BotLevel): string => (bots === 0 ? 'No bots' : `Bots fill to ${bots} · ${BOT_LEVEL_NAMES[level]}`);

/**
 * The host's two choices as the kit's segments: the fill, then the level (no level while bots are
 * off). `id` prefixes the labels' ids; `optClass` adds to each option (the phone's m-p8).
 */
export function BotSettings({ bots, level, onBots, onLevel, id, disabled = false, segClass = 'seg', optClass = '' }: { bots: number; level: BotLevel; onBots(n: number): void; onLevel(l: BotLevel): void; id: string; disabled?: boolean; segClass?: string; optClass?: string }) {
  return (
    <>
      <span className="label" id={`${id}-bots`}>
        Bots
      </span>
      <div className={segClass} role="radiogroup" aria-labelledby={`${id}-bots`}>
        {botFillChoices(bots).map((n) => (
          <button key={n} type="button" className={`seg__opt ${optClass}`.trim()} role="radio" aria-checked={bots === n} disabled={disabled} onClick={blurAfter(() => onBots(n))}>
            {botFillLabel(n)}
          </button>
        ))}
      </div>
      <span className="label" id={`${id}-level`}>
        Bot level
      </span>
      <div className={segClass} role="radiogroup" aria-labelledby={`${id}-level`}>
        {BOT_LEVELS.map((l) => (
          <button key={l} type="button" className={`seg__opt ${optClass}`.trim()} role="radio" aria-checked={level === l} disabled={disabled || bots === 0} onClick={blurAfter(() => onLevel(l))}>
            {BOT_LEVEL_NAMES[l]}
          </button>
        ))}
      </div>
    </>
  );
}
