/**
 * A stand-in for Flutterwave's v3 API (store/flutterwave.ts), as a fetch: hosted checkouts, transactions the test
 * "pays" (any amount, currency, status or tx_ref it likes), verify by id and by tx_ref, and refunds.
 */
export interface FakeTransaction {
  id: number;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
}

export interface FakeCheckout {
  tx_ref: string;
  amount: number;
  currency: string;
  redirect_url: string;
  customer: { email: string; name: string };
}

/** made-up keys, joined at run time so secret scanners don't take them for real ones */
const FAKE_KEY_BODY = ['TEST', '0000aaaa1111bbbb2222cccc3333dddd', 'X'].join('-');

export const TEST_KEYS = {
  FLUTTERWAVE_SECRET_KEY: `${'FLWSECK'}_${FAKE_KEY_BODY}`,
  FLUTTERWAVE_PUBLIC_KEY: `${'FLWPUBK'}_${FAKE_KEY_BODY}`,
  FLUTTERWAVE_WEBHOOK_HASH: 'test-webhook-hash-0123456789',
  FLUTTERWAVE_API_URL: 'https://flw.test',
};

export function fakeFlutterwave() {
  const checkouts: FakeCheckout[] = [];
  const transactions: FakeTransaction[] = [];
  const refunds: { transactionId: string; amount: number; comments: string }[] = [];
  const calls: string[] = [];
  let nextId = 9_000_000;
  const state = { refuseRefunds: false, down: false };

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (state.down) return reply(503, { status: 'error', message: 'down' });
    if (init?.headers && !String((init.headers as Record<string, string>).authorization).startsWith('Bearer FLWSECK_TEST-')) return reply(401, { status: 'error', message: 'bad key' });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'POST' && url.pathname === '/v3/payments') {
      checkouts.push(body as unknown as FakeCheckout);
      return reply(200, { status: 'success', message: 'Hosted Link', data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/${String(body.tx_ref)}` } });
    }
    let m = /^\/v3\/transactions\/(\d+)\/verify$/.exec(url.pathname);
    if (method === 'GET' && m) {
      const t = transactions.find((x) => String(x.id) === m![1]);
      return t ? reply(200, { status: 'success', message: 'Transaction fetched successfully', data: { ...t, flw_ref: `FLW-${t.id}` } }) : reply(400, { status: 'error', message: 'No transaction was found for this id', data: null });
    }
    if (method === 'GET' && url.pathname === '/v3/transactions/verify_by_reference') {
      const t = transactions.filter((x) => x.tx_ref === url.searchParams.get('tx_ref')).at(-1);
      return t ? reply(200, { status: 'success', data: t }) : reply(400, { status: 'error', message: 'No transaction was found', data: null });
    }
    m = /^\/v3\/transactions\/(\d+)\/refund$/.exec(url.pathname);
    if (method === 'POST' && m) {
      if (state.refuseRefunds) return reply(400, { status: 'error', message: 'Refund not allowed' });
      refunds.push({ transactionId: m[1]!, amount: body.amount as number, comments: body.comments as string });
      return reply(200, { status: 'success', message: 'Transaction refund initiated', data: { id: 8600 + refunds.length, tx_id: Number(m[1]), amount_refunded: body.amount, status: 'completed' } });
    }
    return reply(404, { status: 'error', message: `no route ${method} ${url.pathname}` });
  };

  return {
    fetch: fetchImpl,
    checkouts,
    transactions,
    refunds,
    calls,
    state,
    /** The player pays checkout `txRef` (its amount and currency unless the test says otherwise): the new transaction. */
    pay(txRef: string, over: Partial<Omit<FakeTransaction, 'id' | 'tx_ref'>> & { tx_ref?: string } = {}): FakeTransaction {
      const c = checkouts.find((x) => x.tx_ref === txRef);
      const t: FakeTransaction = { id: ++nextId, tx_ref: txRef, status: 'successful', amount: c?.amount ?? 0, currency: c?.currency ?? 'NGN', ...over };
      transactions.push(t);
      return t;
    },
  };
}

export type FakeFlutterwave = ReturnType<typeof fakeFlutterwave>;
