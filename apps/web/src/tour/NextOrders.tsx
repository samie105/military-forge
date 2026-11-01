/**
 * Next orders on Home (docs/design/onboarding-research.md §5; the Pen board's D4): the top card in volt,
 * up to two more, each with why; "Not now" rests a card for 7 days, taking it retires it. Below, the
 * Field manual folds away (six items, stamped as they're done). The cards come from tour/orders.ts
 * `recommend`, pure, on the facts this device keeps; every card shown, taken or put off is logged.
 * Without the onboarding memory (the debug client), or with no card to show, Home keeps `fallback`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { useCtl } from '../shell/context';
import type { ShellController } from '../shell/controller';
import { liveTourMemory, useTourFacts } from './live';
import { fieldManual, recommend, type Card, type OrdersContext } from './orders';
import './orders.css';

/** Runs a card's action through the shell. */
export function takeCard(ctl: ShellController, card: Card): void {
  const a = card.action;
  if (a.kind === 'flight') ctl.startFlight();
  else if (a.kind === 'again') {
    // the kind of match just played: online, Play now with Easy bots once; training, Live fire
    const last = liveTourMemory()?.facts.get().last;
    ctl.host.online?.leave(); // from a room's Results: out of it first, as Leave does
    if (last?.online && !ctl.store.getState().profile?.offline) ctl.playNow('easy');
    else ctl.train('live-fire');
  }
  else if (a.kind === 'train') ctl.train(a.bots === 'easy' ? 'live-fire' : a.bots === 'hard' ? 'hard' : 'match');
  else if (a.kind === 'create') ctl.go({ to: 'create' });
  else if (a.kind === 'join') ctl.openOverlay('join');
  else if (a.kind === 'local') ctl.go({ to: 'local' });
  else if (a.kind === 'creator') location.hash = '#/creator';
  else ctl.openSettings(a.tab);
}

/** `held`: Home is asking something else first (tour/homeQueue.ts); the column keeps `fallback` meanwhile, and no card counts as shown. */
export function NextOrders({ context, fallback, held = false }: { context: OrdersContext; fallback: ReactNode; held?: boolean }) {
  const ctl = useCtl();
  const facts = useTourFacts();
  // the cards as Home opened: one taken or put off leaves, but new facts don't reshuffle what's on screen
  const [shown] = useState(() => {
    const f = liveTourMemory()?.facts.get();
    return f ? recommend(f, context, Date.now()) : [];
  });
  const [openedAt] = useState(() => Date.now());
  const cards = facts
    ? shown.filter((c) => {
        const seen = facts.cards[c.id];
        return seen?.actedAt == null && !(seen?.dismissedAt != null && seen.dismissedAt >= openedAt);
      })
    : [];

  // each card counts as shown once per visit to Home, when it is (not while held back)
  const logged = useRef(false);
  useEffect(() => {
    if (held || logged.current) return;
    logged.current = true;
    const memory = liveTourMemory();
    shown.forEach((c, rank) => {
      memory?.fact({ k: 'card', card: c.id, what: 'shown', at: Date.now() });
      memory?.record({ t: 'card.shown', card: c.id, rank, score: Math.round(c.score) });
    });
  }, [shown, held]);

  if (held || !facts || !cards.length) return <>{fallback}</>;
  const act = (card: Card, rank: number, what: 'acted' | 'dismissed') => {
    liveTourMemory()?.fact({ k: 'card', card: card.id, what, at: Date.now() });
    liveTourMemory()?.record({ t: what === 'acted' ? 'card.tapped' : 'card.dismissed', card: card.id, rank, score: Math.round(card.score) });
    if (what === 'acted') takeCard(ctl, card);
  };
  const manual = fieldManual(facts, context.drillDone);
  const done = manual.filter((m) => m.done).length;
  const [first, ...more] = cards;
  return (
    <section className="card card--print mf-orders m-p3" aria-label="Next orders" data-tour="orders">
      <span className="label label--volt">Next orders</span>
      <article className="mf-orders__top">
        <span className="mf-orders__why">{first!.reason}</span>
        <b className="display mf-orders__title">{first!.title}</b>
        <p className="mf-orders__line">{first!.line}</p>
        <div className="mf-orders__act">
          <button type="button" className="btn btn--ink btn--sm m-p8" onClick={() => act(first!, 0, 'acted')}>
            {first!.cta}
            <Icon name="arrow-right" />
          </button>
          <button type="button" className="mf-orders__later" onClick={() => act(first!, 0, 'dismissed')}>
            Not now
          </button>
        </div>
      </article>
      {more.map((c, i) => (
        <article key={c.id} className="mf-orders__more">
          <span className="mf-orders__text">
            <b>{c.title}</b>
            <span className="mf-orders__why">{c.reason}</span>
          </span>
          <button type="button" className="btn btn--paper btn--sm m-p8" onClick={() => act(c, i + 1, 'acted')}>
            {c.cta}
          </button>
          <button type="button" className="mf-orders__x" aria-label={`Not now: ${c.title}`} title="Not now" onClick={() => act(c, i + 1, 'dismissed')}>
            <Icon name="close" />
          </button>
        </article>
      ))}
      <details className="mf-manual">
        <summary>
          <Icon name="check" />
          Field manual · {done}/{manual.length}
        </summary>
        <ul>
          {manual.map((m) => (
            <li key={m.id} className={m.done ? 'is-done' : ''}>
              <span className="mf-manual__box" aria-hidden="true">
                {m.done && <Icon name="check" />}
              </span>
              <span>
                {m.label}
                {m.optional && <span className="mf-manual__opt"> · optional</span>}
              </span>
              <span className="mf-manual__sr">{m.done ? ', done' : ', to do'}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
