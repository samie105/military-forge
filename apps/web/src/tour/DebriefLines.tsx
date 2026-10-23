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
import { recommend, type OrdersContext } from './orders';
import './orders.css';

export function DebriefLines() {
  // no controller (a test's static render): no Debrief
  const ctl = useContext(ControllerContext);
  const [context] = useState<OrdersContext>(() => ({ offline: !!ctl?.store.getState().profile?.offline, touch: isTouchDevice(), pad: currentDevice().pad !== null, drillDone: drillDone() }));
  const facts = useTourFacts();
  const last = liveTourMemory()?.lastMatch ?? null;
  const [now] = useState(() => Date.now());
  if (!ctl || !facts || !last || facts.matches.finished > DEBRIEF_MATCHES) return null;
  const top = recommend(facts, context, now)[0] ?? null;
  const d = debrief(last, facts, top);
  return (
    <section className="mf-debrief m-p3" aria-label="Debrief">
      <p>
        <Icon name="check" />
        <b>{d.done}</b>
      </p>
      {d.tryNext && (
        <p>
          <Icon name="target" />
          {d.tryNext}
        </p>
      )}
      {top && d.next && (
        <p className="mf-debrief__next">
          <Icon name="arrow-right" />
          <span>
            <b>{d.next.title}</b> · {d.next.reason}
          </span>
          <button
            type="button"
            className="btn btn--paper btn--sm m-p8"
            onClick={() => {
              liveTourMemory()?.fact({ k: 'card', card: top.id, what: 'acted', at: Date.now() });
              liveTourMemory()?.record({ t: 'card.tapped', card: top.id, rank: 0, score: Math.round(top.score) });
              takeCard(ctl, top);
            }}
          >
            {top.cta}
          </button>
        </p>
      )}
    </section>
  );
}
