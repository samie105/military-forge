/**
 * The social push channel's client (apps/api events/routes.ts): one Server-Sent Events stream per
 * tab, read with fetch so the access token goes in a header. Events arrive within a second of
 * happening (an invite, a request, a friend going into a match); the stream ends by itself when the
 * token runs out (~15 min) and opens again at once with a fresh one. On a failure it waits 1 s,
 * 2 s, 4 s … up to 30 s (with jitter) before trying again; a page coming back to the front tries at
 * once. While it's down, the friends list's own refresh (every 30–60 s) keeps things roughly right.
 */
export interface StreamApi {
  stream(path: string, signal: AbortSignal): Promise<Response>;
}

export type StreamListener = (type: string, data: unknown) => void;

const MAX_BACKOFF_MS = 30_000;

/** Splits SSE text into complete frames ({ event, data }); returns what's left over. */
export function parseSse(buffer: string): { frames: { event: string; data: string }[]; rest: string } {
  const frames: { event: string; data: string }[] = [];
  const parts = buffer.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith(':') || line === '') continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || event !== 'message') frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

export class EventStream {
  private abort: AbortController | null = null;
  private running = false;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** a stream is open (the hello arrived) */
  connected = false;

  constructor(
    private readonly api: StreamApi,
    private readonly listener: StreamListener,
    /** the connection opened or dropped (the app catches up on what it missed when it opens) */
    private readonly onState: (connected: boolean) => void = () => {},
    private readonly doc: Pick<Document, 'visibilityState' | 'addEventListener'> | null = typeof document === 'undefined' ? null : document,
  ) {
    this.doc?.addEventListener('visibilitychange', () => {
      if (this.running && this.doc?.visibilityState === 'visible' && !this.connected && this.retry) {
        clearTimeout(this.retry);
        this.retry = null;
        void this.loop();
      }
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.abort?.abort();
    this.abort = null;
    this.setConnected(false);
  }

  private setConnected(on: boolean): void {
    if (this.connected === on) return;
    this.connected = on;
    this.onState(on);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const ended = await this.once();
      if (!this.running) return;
      if (ended === 'expired') {
        this.failures = 0;
        continue; // the token ran out: straight back with a fresh one
      }
      this.failures++;
      const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(5, this.failures - 1)) * (0.75 + Math.random() * 0.5);
      await new Promise<void>((resolve) => {
        this.retry = setTimeout(() => {
          this.retry = null;
          resolve();
        }, wait);
      });
    }
  }

  /** One connection, read to its end: 'expired' (the server closed it), or 'failed'. */
  private async once(): Promise<'expired' | 'failed'> {
    const abort = (this.abort = new AbortController());
    try {
      const res = await this.api.stream('/events', abort.signal);
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return 'failed';
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSse(buffer);
        buffer = rest;
        for (const f of frames) {
          if (f.event === 'hello') {
            this.failures = 0;
            this.setConnected(true);
            continue;
          }
          let data: unknown = null;
          try {
            data = f.data ? JSON.parse(f.data) : null;
          } catch {
            continue;
          }
          this.listener(f.event, data);
        }
      }
      return this.connected ? 'expired' : 'failed';
    } catch {
      return 'failed';
    } finally {
      this.setConnected(false);
      if (this.abort === abort) this.abort = null;
    }
  }
}
