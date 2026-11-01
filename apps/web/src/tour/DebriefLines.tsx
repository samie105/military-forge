/**
 * The Debrief block on Results (tour/debrief.ts): shown for the first few finished matches on this
 * device, under the player's own line. Its third line is the top Next orders card, with its button.
 */
import { useContext, useState } from 'react';
import { ControllerContext } from '../shell/context';
import { Icon } from '../ui/Icon';
import { currentDevice } from '../gamepad';
import { drillDone, isTouchDevice } from '../touch';
import { DEBRIEF_MATCHES, debrief } from './debrief';
import { liveTourMemory, useTourFacts } from './live';
import { takeCard } from './NextOrders';
import { CARDS, badLastMatch, recommend, type Card, type OrdersContext } from './orders';
import './orders.css';

export function DebriefLines() {
  // no controller (a test's static render): no Debrief
  const ctl = useContext(ControllerContext);
  const [context] = useState<OrdersContext>(() => ({ offline: !!ctl?.store.getState().profile?.offline, touch: isTouchDevice(), pad: currentDevice().pad !== null, drillDone: drillDone() }));
  const facts = useTourFacts();
  const last = liveTourMemory()?.lastMatch ?? null;
  const [now] = useState(() => Date.now());
  if (!ctl || !facts || !last || facts.matches.finished > DEBRIEF_MATCHES) return null;
  const cards = recommend(facts, context, now);
  const input = context.touch || context.pad ? 'sticks' : 'mouse';
  // the easier start carries "One more, Easy bots" as its button (audit 2 P-03); the next line is then the card after it
  // (not in a room with other people: friends aren't left for easier bots)
  const alone = (facts.last?.people ?? 0) <= 1;
  const again = alone && debrief(last, facts, null, input).easier ? (cards.find((c) => c.id === AGAIN) ?? againCard()) : null;
  const top = cards.find((c) => !again || c.id !== AGAIN) ?? null;
  const d = debrief(last, facts, top, input);
  const take = (card: Card, rank: number) => {
    liveTourMemory()?.fact({ k: 'card', card: card.id, what: 'acted', at: Date.now() });
    liveTourMemory()?.record({ t: 'card.tapped', card: card.id, rank, score: Math.round(card.score) });
    takeCard(ctl, card);
  };
  return (
    <section className="mf-debrief m-p3" aria-label="Debrief">
      <p>
        <Icon name={d.scored ? 'check' : 'info'} />
        <b>{d.done}</b>
      </p>
      {d.tryNext && (
        <p className={again ? 'mf-debrief__next mf-debrief__try' : undefined}>
          <Icon name="target" />
          <span>{d.tryNext}</span>
          {again && (
            <button type="button" className="btn btn--paper btn--sm m-p8" onClick={() => take(again, 0)}>
              {again.title}
            </button>
          )}
        </p>
      )}
      {/* the easier start's button is the next order: one thing at a time */}
      {top && d.next && !again && (
        <p className="mf-debrief__next">
          <Icon name="arrow-right" />
          <span>
            <b>{d.next.title}</b> · {d.next.reason}
          </span>
          <button type="button" className="btn btn--paper btn--sm m-p8" onClick={() => take(top, again ? 1 : 0)}>
            {top.cta}
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * Results' "One more, Easy bots" after a bad loss against bots (audit 2 P-03), once the Debrief isn't
 * offering it on its own try line (after the first few matches, or a loss that isn't the easier start).
 */
export function AgainEasy() {
  const ctl = useContext(ControllerContext);
  const facts = useTourFacts();
  const last = liveTourMemory()?.lastMatch ?? null;
  const [touch] = useState(() => isTouchDevice() || currentDevice().pad !== null);
  if (!ctl || !facts || !badLastMatch(facts)) return null;
  // the Debrief already offers it: on its try line (the easier start), or as its next order
  const debriefShows = !!last && facts.matches.finished <= DEBRIEF_MATCHES;
  const context: OrdersContext = { offline: !!ctl.store.getState().profile?.offline, touch: isTouchDevice(), pad: currentDevice().pad !== null, drillDone: drillDone() };
  const debriefOffers = debriefShows && (debrief(last, facts, null, touch ? 'sticks' : 'mouse').easier || recommend(facts, context, Date.now())[0]?.id === AGAIN);
  if (debriefOffers) return null;
  const card = againCard();
  return (
    <button
      type="button"
      className="btn btn--paper btn--block m-p8 mf-again"
      onClick={() => {
        liveTourMemory()?.fact({ k: 'card', card: card.id, what: 'acted', at: Date.now() });
        liveTourMemory()?.record({ t: 'card.tapped', card: card.id, rank: 0, score: Math.round(card.score) });
        takeCard(ctl, card);
      }}
    >
      <Icon name="target" />
      {card.title}
    </button>
  );
}

const AGAIN = 'again-easy';

/** Next orders' "One more, Easy bots", for the easier start's button when the list doesn't hold it (taken, or resting). */
function againCard(): Card {
  const def = CARDS.find((c) => c.id === AGAIN)!;
  return { id: def.id, title: def.title, line: def.line, cta: def.cta, action: def.action, reason: '', score: def.base };
}
