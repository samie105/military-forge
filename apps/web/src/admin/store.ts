/**
 * The admin page's Store (docs/17; the API's /admin/store, the same token): find an account by id, name or email,
 * read its wallet, ledger, payments, items and the owner's past actions, and act on it with a reason every time:
 * grant Brass or an item, adjust a pool (never below zero), refund a payment, clear a mint flag. The flagged
 * accounts and a whole-ledger reconciliation sit at the top.
 */

export interface LedgerRowView {
  id: number;
  at: string;
  pool: 'paid' | 'earned';
  kind: string;
  delta: number;
  balanceAfter: number;
  ref: string;
  note: string | null;
  actor: string;
}

export interface AdminAccountView {
  account: { id: string; nickname: string; level: number; status: string; adult: boolean; saved: boolean | null; createdAt: string };
  wallet: { paid: number; earned: number; total: number; flaggedAt: string | null; flagReason: string | null; monthlyCapCents: number | null };
  ledger: LedgerRowView[];
  payments: { id: string; bundleId: string; brass: number; amountMinor: number; currency: string; status: string; createdAt: string; paidAt: string | null; refundable: boolean }[];
  inventory: { itemId: string; name: string; source: string; ref: string; at: string }[];
  grants: string[];
  audit: { id: number; at: string; actor: string; action: string; reason: string; detail: Record<string, unknown> }[];
  reconciled: boolean;
  issues: { pool: string; wallet: number; sum: number; last: number }[];
}

/** The store items the owner can grant from the page (the API checks any id against content anyway). */
export const GRANTABLE = [
  ['skin_k47_galaxy_relic', 'K-47 Galaxy Relic (Forged)'],
  ['skin_k47_galaxy_relic_fx', 'K-47 Galaxy Relic + Stardust Shatter (includes the Forged skin)'],
] as const;

export class StoreAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One /api/admin/store call. */
export async function storeAdmin<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(`/api/admin/store${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; issues?: { message: string }[] } } | null;
  if (!res.ok) {
    const e = data?.error;
    throw new StoreAdminError(res.status, e?.code ?? 'http_error', res.status === 401 ? 'the API does not know this token' : (e?.issues?.[0]?.message ?? e?.message ?? `HTTP ${res.status}`));
  }
  return data as T;
}

/** `+1,050` / `−500` */
export function signed(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en')}`;
}

/** `₦9,900` / `$9.99` */
export function money(minor: number, currency: string): string {
  const major = minor / 100;
  return currency === 'NGN' ? `₦${major.toLocaleString('en-NG')}` : currency === 'USD' ? `$${major.toFixed(2)}` : `${major} ${currency}`;
}

/** A ledger row in one line, for the table and Copy. */
export function ledgerLine(r: LedgerRowView): string {
  return `${new Date(r.at).toLocaleString()} · ${r.kind} · ${r.pool} ${signed(r.delta)} → ${r.balanceAfter.toLocaleString('en')} · ${r.actor} · ${r.note ?? ''} · ${r.ref}`;
}

type El = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string)[]) => HTMLElementTagNameMap[K];

/** The Store group (a <details>): the flags and reconciliation when opened, an account when looked up. */
export function storeGroup(token: string, el: El): HTMLElement {
  const top = el('div', { class: 'admin__store-top' });
  const results = el('div', { class: 'admin__store-results' });
  const view = el('div', { class: 'admin__store-account' });
  const status = el('p', { class: 'admin__note', role: 'status', 'aria-live': 'polite' });
  const search = el('input', { type: 'search', class: 'admin__search', placeholder: 'Account id, name or email', 'aria-label': 'Find an account' });
  const find = el('button', { type: 'button', class: 'admin__btn' }, 'Find');
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  };

  const loadTop = async () => {
    try {
      const [{ flagged }, rec] = await Promise.all([
        storeAdmin<{ flagged: { userId: string; at: string; reason: string | null; balance: { total: number } }[] }>(token, 'GET', '/flags'),
        storeAdmin<{ ok: boolean; issues: { userId: string; pool: string; wallet: number; sum: number }[] }>(token, 'GET', '/reconcile'),
      ]);
      top.replaceChildren(
        el('p', { class: `admin__note${rec.ok ? '' : ' is-error'}` }, rec.ok ? 'Ledger reconciles: every wallet equals the sum of its rows.' : `Ledger does NOT reconcile for ${rec.issues.length} pool(s): ${rec.issues.map((i) => `${i.userId} ${i.pool} wallet ${i.wallet} ≠ rows ${i.sum}`).join('; ')}`),
        flagged.length
          ? el('ul', { class: 'admin__store-flags' }, ...flagged.map((f) => {
              const b = el('button', { type: 'button', class: 'admin__btn admin__btn--danger' }, `Mint alarm: ${f.userId}`);
              b.addEventListener('click', () => void open(f.userId));
              return el('li', {}, b, ` ${f.reason ?? ''} · balance ${f.balance.total.toLocaleString('en')} · ${new Date(f.at).toLocaleString()}`);
            }))
          : el('p', { class: 'admin__note' }, 'No mint alarms.'),
      );
    } catch (e) {
      top.replaceChildren(el('p', { class: 'admin__note is-error' }, `Couldn't load the store: ${(e as Error).message}`));
    }
  };

  const lookup = async () => {
    const q = search.value.trim();
    if (q.length < 2) return;
    try {
      const { accounts } = await storeAdmin<{ accounts: { id: string; nickname: string; level: number }[] }>(token, 'GET', `/accounts?q=${encodeURIComponent(q)}`);
      results.replaceChildren(
        ...(accounts.length
          ? accounts.map((a) => {
              const b = el('button', { type: 'button', class: 'admin__btn' }, `${a.nickname} · L${a.level} · ${a.id}`);
              b.addEventListener('click', () => void open(a.id));
              return b;
            })
          : [el('p', { class: 'admin__note' }, 'No account matches.')]),
      );
    } catch (e) {
      say(`Search failed: ${(e as Error).message}`, true);
    }
  };

  /** A form row: inputs, a reason, and a button that posts them. */
  const action = (label: string, inputs: HTMLElement[], run: (reason: string) => Promise<void>) => {
    const reason = el('input', { type: 'text', placeholder: 'Reason (kept in the audit)', 'aria-label': `${label}: reason`, minlength: '3', maxlength: '300' });
    const go = el('button', { type: 'button', class: 'admin__btn admin__btn--primary' }, label);
    go.addEventListener('click', () => {
      if (reason.value.trim().length < 3) {
        say('Every store action needs a reason (3+ characters).', true);
        return;
      }
      go.disabled = true;
      run(reason.value.trim()).then(
        () => (reason.value = ''),
        (e: Error) => say(`${label}: ${e.message}`, true),
      ).finally(() => (go.disabled = false));
    });
    return el('div', { class: 'admin__store-action' }, ...inputs, reason, go);
  };

  const open = async (id: string): Promise<void> => {
    let a: AdminAccountView;
    try {
      a = await storeAdmin<AdminAccountView>(token, 'GET', `/accounts/${encodeURIComponent(id)}`);
    } catch (e) {
      say(`Couldn't open ${id}: ${(e as Error).message}`, true);
      return;
    }
    const after = async (text: string) => {
      say(text);
      await open(id);
      await loadTop();
    };
    const brass = el('input', { type: 'number', min: '1', max: '20000', placeholder: 'Brass', 'aria-label': 'Brass to grant' });
    const item = el('select', { 'aria-label': 'Item to grant' }, el('option', { value: '' }, '— or an item —'), ...GRANTABLE.map(([v, t]) => el('option', { value: v }, t)));
    const pool = el('select', { 'aria-label': 'Pool' }, el('option', { value: 'earned' }, 'earned'), el('option', { value: 'paid' }, 'paid'));
    const delta = el('input', { type: 'number', placeholder: '± Brass', 'aria-label': 'Change' });
    const w = a.wallet;
    const flag = w.flaggedAt
      ? action('Clear the mint alarm', [el('span', { class: 'admin__note is-error' }, `Flagged ${new Date(w.flaggedAt).toLocaleString()}: ${w.flagReason ?? ''}`)], async (reason) => {
          await storeAdmin(token, 'POST', `/accounts/${encodeURIComponent(id)}/clear-flag`, { reason });
          await after('Mint alarm cleared.');
        })
      : el('span');
    const refundReason = el('input', { type: 'text', placeholder: 'Refund reason', 'aria-label': 'Refund reason', maxlength: '300' });
    view.replaceChildren(
      el('h3', {}, `${a.account.nickname} · ${a.account.id}`),
      el(
        'p',
        { class: 'admin__note' },
        `Level ${a.account.level} · ${a.account.status} · ${a.account.saved ? 'saved account' : 'guest'} · ${a.account.adult ? '18+ confirmed' : 'no 18+ answer'} · since ${new Date(a.account.createdAt).toLocaleDateString()}`,
      ),
      el('p', { class: 'admin__store-balance' }, el('b', {}, `${w.total.toLocaleString('en')} Brass`), ` (paid ${w.paid.toLocaleString('en')} · earned ${w.earned.toLocaleString('en')})`, a.reconciled ? ' · reconciles ✓' : ` · DOES NOT RECONCILE: ${JSON.stringify(a.issues)}`),
      flag,
      action('Grant', [brass, item], async (reason) => {
        const body = item.value ? { itemId: item.value, reason } : { brass: Number(brass.value), reason };
        await storeAdmin(token, 'POST', `/accounts/${encodeURIComponent(id)}/grant`, body);
        await after(item.value ? `Granted ${item.value}.` : `Granted ${brass.value} Brass (earned).`);
      }),
      action('Adjust', [pool, delta], async (reason) => {
        await storeAdmin(token, 'POST', `/accounts/${encodeURIComponent(id)}/adjust`, { pool: pool.value, delta: Number(delta.value), reason });
        await after(`Adjusted ${pool.value} by ${signed(Number(delta.value))}.`);
      }),
      el('h4', {}, 'Payments'),
      a.payments.length
        ? el(
            'table',
            { class: 'admin__store-table' },
            ...a.payments.map((p) => {
              const cell = el('td');
              if (p.status === 'paid') {
                const b = el('button', { type: 'button', class: 'admin__btn admin__btn--danger' }, 'Refund');
                b.addEventListener('click', () => {
                  if (refundReason.value.trim().length < 3) return say('Write a refund reason first (next to "Payments").', true);
                  b.disabled = true;
                  storeAdmin(token, 'POST', `/payments/${encodeURIComponent(p.id)}/refund`, { reason: refundReason.value.trim() }).then(
                    () => after(`Refunded ${p.id}.`),
                    (e: Error) => {
                      b.disabled = false;
                      say(`Refund: ${e.message}`, true);
                    },
                  );
                });
                cell.append(b);
              }
              return el('tr', {}, el('td', {}, new Date(p.createdAt).toLocaleString()), el('td', {}, p.id), el('td', {}, `${p.brass.toLocaleString('en')} Brass`), el('td', {}, money(p.amountMinor, p.currency)), el('td', {}, p.status), cell);
            }),
          )
        : el('p', { class: 'admin__note' }, 'No payments.'),
      refundReason,
      el('h4', {}, 'Items'),
      el('p', { class: 'admin__note' }, [...a.inventory.map((i) => `${i.name} (${i.source})`), ...a.grants.map((g) => `${g} (COSMETIC_GRANTS)`)].join(' · ') || 'None.'),
      el('h4', {}, `Ledger (${a.ledger.length})`),
      el('pre', { class: 'admin__report-text' }, a.ledger.map(ledgerLine).join('\n') || 'No movements.'),
      el('h4', {}, 'Owner actions'),
      el('pre', { class: 'admin__report-text' }, a.audit.map((x) => `${new Date(x.at).toLocaleString()} · ${x.action} · ${x.reason} · ${JSON.stringify(x.detail)}`).join('\n') || 'None.'),
    );
  };

  find.addEventListener('click', () => void lookup());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void lookup();
  });
  const group = el(
    'details',
    { class: 'admin__group admin__group--store' },
    el('summary', {}, 'Store'),
    el('div', { class: 'admin__sections' }, el('div', { class: 'admin__store' }, el('p', { class: 'admin__note' }, 'Wallets, the ledger and payments. Every grant, adjustment and refund needs a reason and is kept in the audit.'), top, el('div', { class: 'admin__store-find' }, search, find), results, status, view)),
  );
  group.addEventListener('toggle', () => {
    if ((group as HTMLDetailsElement).open) void loadTop();
  });
  return group;
}
