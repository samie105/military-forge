/**
 * Play now's bots, in plain sight (audit 2 P-01): "Bots: Easy · Change" under the Play now button
 * (desktop and phone Home), opening Auto / Easy / Normal / Hard. Auto follows how the player does
 * (tour/facts.ts stepBots); a level pins it. Results says once when Auto moved it (BotsMoved). The
 * level is the facts' own, so nothing changes mid-match and nothing is hidden.
 */
import { useState } from 'react';
import { BOT_STEP_AFTER, type BotLevel } from './facts';
import { liveTourMemory, useTourFacts } from './live';
import './orders.css';

const NAMES: Readonly<Record<BotLevel, string>> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const CHOICES: readonly (BotLevel | 'auto')[] = ['auto', 'easy', 'normal', 'hard'];

export function PlayNowBots({ phone = false }: { phone?: boolean }) {
  const facts = useTourFacts();
  const [open, setOpen] = useState(false);
  if (!facts) return null;
  const b = facts.bots;
  const pick = (level: BotLevel | 'auto') => {
    liveTourMemory()?.fact({ k: 'bots', level });
    setOpen(false);
  };
  return (
    <div className={`mf-pnbots${phone ? ' mf-pnbots--phone' : ''}`}>
      {open ? (
        <div className="mf-pnbots__pick" role="radiogroup" aria-label="Play now's bots">
          {CHOICES.map((c) => {
            const on = c === 'auto' ? !b.pinned : b.pinned && b.level === c;
            return (
              <button key={c} type="button" role="radio" aria-checked={on} className="mf-pnbots__opt m-p8" onClick={() => pick(c)} title={c === 'auto' ? 'Follows how you do: a step up after two top-two finishes, down after two last places' : undefined}>
                {c === 'auto' ? 'Auto' : NAMES[c]}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mf-pnbots__line">
          <span>
            Bots: <b>{NAMES[b.level]}</b>
            {b.pinned && <span className="mf-pnbots__why"> (your pick)</span>}
          </span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="mf-pnbots__change" aria-expanded={false} aria-label={`Change Play now's bots, ${NAMES[b.level]} now`} onClick={() => setOpen(true)}>
            Change
          </button>
        </p>
      )}
    </div>
  );
}

/** Results' one line when the match just moved Play now's bots: "Next Play now: Normal bots (2 top-two finishes)". */
export function BotsMoved() {
  const facts = useTourFacts();
  const moved = facts?.bots.moved;
  if (!moved) return null;
  const why = moved.why === 'up' ? `${BOT_STEP_AFTER} top-two finishes` : `${BOT_STEP_AFTER} last places`;
  return (
    <p className="mf-bots-moved m-p3" role="status">
      Next Play now: <b>{NAMES[moved.to]} bots</b> ({why}). Change it under Play now.
    </p>
  );
}
