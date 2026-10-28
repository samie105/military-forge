/**
 * Flutterwave (the owner's payment provider, 28 Oct), v3 API, server to server with the secret key
 * (developer.flutterwave.com, read 28 Oct 2026):
 *
 *   POST /v3/payments                                  Standard checkout: { tx_ref, amount, currency, redirect_url,
 *                                                      customer: { email }, customizations } → data.link (hosted page)
 *   GET  /v3/transactions/:id/verify                   the transaction as Flutterwave has it (data.status "successful",
 *   GET  /v3/transactions/verify_by_reference?tx_ref=  data.amount, data.currency, data.tx_ref, data.id)
 *   POST /v3/transactions/:id/refund                   { amount, comments } → data.id, data.status
 *   webhooks                                           header `verif-hash` equals the secret hash set in the dashboard
 *
 * Nothing the browser or a webhook says is believed: every credit is decided on a verify call made here.
 */
import { timingSafeEqual } from 'node:crypto';

export interface FlutterwaveKeys {
  secretKey: string;
  publicKey: string;
  webhookHash: string;
  /** https://api.flutterwave.com (tests point elsewhere) */
  apiUrl: string;
}

/** A transaction as the verify endpoints return it (the fields the store checks). */
export interface FlwTransaction {
  id: number;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
  flw_ref?: string;
  charged_amount?: number;
}

export class FlutterwaveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FlutterwaveError';
  }
}

const TIMEOUT_MS = 20_000;

export class Flutterwave {
  constructor(
    private readonly keys: FlutterwaveKeys,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Test keys (FLWSECK_TEST-…) take no real money: the store says so on screen. */
  get mode(): 'test' | 'live' {
    return /_TEST-/.test(this.keys.secretKey) ? 'test' : 'live';
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: { status?: string; message?: string; data?: T } | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.keys.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.keys.secretKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new FlutterwaveError(0, `Flutterwave unreachable: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as { status?: string; message?: string; data?: T } | null;
    return { status: res.status, json };
  }

  /** Opens a hosted checkout; returns the page to send the player to. */
  async createPayment(p: { txRef: string; amountMinor: number; currency: string; redirectUrl: string; email: string; name: string; title: string; description: string }): Promise<string> {
    const { status, json } = await this.call<{ link?: string }>('POST', '/v3/payments', {
      tx_ref: p.txRef,
      amount: p.amountMinor / 100,
      currency: p.currency,
      redirect_url: p.redirectUrl,
      customer: { email: p.email, name: p.name },
      customizations: { title: p.title, description: p.description },
    });
    const link = json?.data?.link;
    // the hosted page is https, unless the API itself isn't (a local stand-in for an end-to-end run)
    const secure = typeof link === 'string' && (link.startsWith('https://') || (!this.keys.apiUrl.startsWith('https://') && link.startsWith('http://')));
    if (status !== 200 || json?.status !== 'success' || !secure) {
      throw new FlutterwaveError(status, `checkout not created: ${json?.message ?? `HTTP ${status}`}`);
    }
    return link as string;
  }

  /** The transaction by Flutterwave's id; null when it has none by that id. */
  async verify(transactionId: string): Promise<FlwTransaction | null> {
    if (!/^\d{1,20}$/.test(transactionId)) return null;
    return this.transaction(await this.call<FlwTransaction>('GET', `/v3/transactions/${transactionId}/verify`));
  }

  /** The transaction by our tx_ref (the sweep's fallback when no redirect or webhook brought an id). */
  async verifyByRef(txRef: string): Promise<FlwTransaction | null> {
    return this.transaction(await this.call<FlwTransaction>('GET', `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`));
  }

  private transaction(r: { status: number; json: { status?: string; data?: FlwTransaction } | null }): FlwTransaction | null {
    if (r.status >= 500 || r.status === 0 || r.status === 401) throw new FlutterwaveError(r.status, `verify failed: HTTP ${r.status}`);
    const d = r.json?.data;
    if (r.json?.status !== 'success' || !d || typeof d.id !== 'number' || typeof d.tx_ref !== 'string') return null;
    return d;
  }

  /** Sends `amountMinor` of a transaction back to where it came from. */
  async refund(transactionId: string, amountMinor: number, comments: string): Promise<{ id: string; status: string }> {
    const { status, json } = await this.call<{ id?: number; status?: string }>('POST', `/v3/transactions/${encodeURIComponent(transactionId)}/refund`, { amount: amountMinor / 100, comments });
    if (status !== 200 || json?.status !== 'success' || json.data?.id === undefined) throw new FlutterwaveError(status, `refund refused: ${json?.message ?? `HTTP ${status}`}`);
    return { id: String(json.data.id), status: json.data.status ?? 'unknown' };
  }

  /** A webhook carries the dashboard's secret hash in `verif-hash` (a plain comparison, timing-safe). */
  webhookAuthentic(header: string | undefined): boolean {
    const a = Buffer.from(header ?? '');
    const b = Buffer.from(this.keys.webhookHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
