/**
 * One authoritative room (docs/06 §5). Transport-agnostic: the uWS layer (or a test) hands it
 * bytes and a `ClientConn` to reply on.
 *
 * Pipe: clients tag each input with the server tick it is for (they run ahead, docs/05 §4) →
 * per-client tick-indexed buffer (repeat-last when a tick's input is missing) → Game.step at 60 Hz →
 * every 2nd tick (30 Hz) a snapshot per client: delta-compressed against the newest one it acked,
 * culled to what its camera can show (AOI), with its input buffer health and the exact state of
 * its own player for reconciliation (docs/05 §8, §9, §11). Hitscan is lag-compensated: each shot
 * tests targets where the shooter's screen showed them (docs/05 §7, LagCompensator).
 *
 * Sessions (docs/05 §13): a dropped connection leaves its player standing idle in the world for
 * `reconnectGraceMs`; a new connection presenting the WELCOME session token takes it back over
 * (full resync: fresh baselines), and also replaces a stale connection that hasn't noticed the drop.
 */
import { randomBytes } from 'node:crypto';
import { createTuning, defaultTuning, type Tuning } from '@military-forge/content';
import {
  CONTENT_HASH,
  CloseCode,
  CmdKind,
  DecodeError,
  HEALTH_UNKNOWN,
  MsgType,
  PROTOCOL_VERSION,
  SnapshotBaselines,
  SnapshotEncoder,
  createInputPacket,
  decodeInputInto,
  decodeMessage,
  encodePong,
  encodeRewindDebug,
  encodeRoster,
  type RosterEntry,
  encodeTuning,
  encodeWelcome,
  isUnreliableMessage,
  type ClientMessage,
  type RewindTarget,
  type ViewRect,
} from '@military-forge/protocol';
import {
  ConditionedLink,
  INTERP_DELAY_MS,
  InputBuffer,
  LOW_BANDWIDTH_INTERP_DELAY_MS,
  LagCompensator,
  TICK_MS,
  aoiRect,
  unwrapTick,
  type ConditionerSettings,
  type Scheduler,
} from '@military-forge/netcode';
import { Game, createInput, type Input, type PlayerState, type SimEvent } from '@military-forge/sim';

export interface ClientConn {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  /** bytes queued but not yet written to the socket */
  bufferedAmount(): number;
}

export interface RoomOptions {
  seed?: number;
  mapId?: string;
  maxHumans?: number;
  dummies?: boolean;
  /** send a snapshot every N ticks (2 → 30 Hz) */
  snapshotEvery?: number;
  /** allow dev commands (live tuning, respawn) */
  dev?: boolean;
  /** server-side network conditioner on every connection (docs/05 §15.2; dev/testing only) */
  netSim?: { settings: ConditionerSettings; scheduler: Scheduler };
  /** lag compensation for hitscan (default on); `maxRewindMs` overrides the cap */
  lagComp?: boolean | { maxRewindMs?: number };
  /** send each client only what its camera can show (default on, docs/05 §9) */
  aoi?: boolean;
  /** how long a dropped player waits for its session to reconnect (rooms 20 s, BR 60 s; 0 = never) */
  reconnectGraceMs?: number;
}

/** A player's claim on the room; outlives its connection for the reconnect grace. */
export interface Session {
  token: string;
  playerId: number;
  /** the connection driving this player, null while waiting for a reconnect */
  client: Client | null;
  /** tick at which a detached session is given up */
  expiresAt: number;
  /** what the player does while detached: nothing, facing the same way */
  readonly idle: Input;
  /**
   * The token presented on the latest resume, kept valid until that connection proves it got the
   * new token (its first PING or INPUT): if the resumed WELCOME is lost, the retry still works.
   */
  prevToken: string | null;
}

const newToken = () => randomBytes(18).toString('base64url');

const MAX_STRIKES = 3;
const MAX_MESSAGES_PER_SECOND = 200;
/**
 * docs/05 §14: a token bucket of CMDs per connection (20/s, bursts of 20). Over the limit they're
 * dropped, not strikes: a TCP stall can bunch up honest ones. A real flood still hits
 * MAX_MESSAGES_PER_SECOND.
 */
const CMDS_PER_SECOND = 20;
const CMD_BURST = 20;
/**
 * A low-bandwidth client gets its wider rewind cap and 4-tick pose spacing only after this long
 * in that mode (1 s: past its 150 ms interpolation window with slack). Off takes effect at once,
 * so toggling it around a shot earns nothing.
 */
const LOW_BW_WARMUP_TICKS = 60;
const BACKPRESSURE_LIMIT = 16 * 1024;
/** docs/05 §14: INPUT packets are tiny; anything bigger is malformed */
const MAX_INPUT_BYTES = 64;

export class Client {
  playerId = -1;
  name = '';
  closed = false;
  /** this client's inputs, by server tick */
  readonly inputs = new InputBuffer();
  /** what the sim uses: the input for the current tick, or the last one repeated */
  readonly lastInput: Input = createInput();
  /** lowest buffer health since the last snapshot */
  healthMin = Infinity;
  /** snapshots sent to this client recently: delta baselines (docs/05 §11) */
  readonly baselines = new SnapshotBaselines();
  /** this client's area of interest, recomputed every snapshot */
  readonly view: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** server tick low-bandwidth mode was switched on, -1 = off */
  lowBwSince = -1;
  /** server tick of the last snapshot sent to it */
  lastSnapshotTick = -1;
  strikes = 0;
  messagesThisSecond = 0;
  /** CMD token bucket: tokens left, as of server tick `cmdTokensAt` */
  cmdTokens = CMD_BURST;
  cmdTokensAt = 0;
  snapshotsSkipped = 0;
  /** the player this connection drives (null before WELCOME) */
  session: Session | null = null;
  /** network conditioner links (only with RoomOptions.netSim) */
  up: ConditionedLink | null = null;
  down: ConditionedLink | null = null;

  /**
   * @param snapshotEvery ticks between this client's snapshots: the room's interval, doubled in
   *   low-bandwidth mode
   */
  constructor(
    readonly conn: ClientConn,
    public snapshotEvery: number,
  ) {}

  get joined(): boolean {
    return this.playerId >= 0;
  }
}

function sanitizeName(raw: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  return name || fallback;
}

export class Room {
  readonly game: Game;
  readonly clients = new Set<Client>();
  private pendingEvents: SimEvent[] = [];
  /** the previous snapshot interval's events, for clients that skipped it (low-bandwidth mode) */
  private previousEvents: SimEvent[] = [];
  private readonly inputs: (Input | undefined)[] = [];
  private readonly packet = createInputPacket();
  private readonly snapshots = new SnapshotEncoder();
  private snapshotSeq = 0;
  private readonly maxHumans: number;
  private readonly snapshotEvery: number;
  private readonly dev: boolean;
  private readonly aoi: boolean;
  private readonly graceTicks: number;
  /** every player's session by token, connected or waiting for a reconnect */
  readonly sessions = new Map<string, Session>();
  /** tokens presented on a resume whose new token isn't confirmed yet (aliases, not counted) */
  private readonly unconfirmed = new Map<string, Session>();
  private readonly netSim: RoomOptions['netSim'];
  private linkSeed = 1;
  /** null when lag compensation is off */
  readonly lagComp: LagCompensator | null;

  constructor(options: RoomOptions = {}) {
    this.game = new Game({ seed: options.seed ?? 1, mapId: options.mapId ?? 'movement-test', dummies: options.dummies ?? true });
    this.maxHumans = options.maxHumans ?? 8;
    this.snapshotEvery = options.snapshotEvery ?? 2;
    this.dev = options.dev ?? true;
    this.aoi = options.aoi ?? true;
    this.graceTicks = Math.round(((options.reconnectGraceMs ?? 20_000) / 1000) * 60);
    this.netSim = options.netSim;
    const lc = options.lagComp ?? true;
    this.lagComp = lc === false ? null : new LagCompensator({ snapshotEvery: this.snapshotEvery, log: this.dev, ...(lc === true ? {} : lc) });
    this.game.rewind = this.lagComp;
    this.lagComp?.record(this.game.tick, this.game.players);
  }

  /** humans in the room, including those waiting to reconnect (they keep their slot) */
  get humanCount(): number {
    return this.sessions.size;
  }

  connect(conn: ClientConn): Client {
    const sim = this.netSim;
    if (!sim) {
      const client = new Client(conn, this.snapshotEvery);
      this.clients.add(client);
      return client;
    }
    // conditioned: S→C goes through `down`, C→S through `up` (see receive)
    const enabled = () => sim.settings.enabled;
    const down = new ConditionedLink(sim.settings.down, enabled, sim.scheduler, (b) => conn.send(b), isUnreliableMessage, this.linkSeed++);
    const client = new Client(
      { send: (b) => down.send(b), close: (code, reason) => conn.close(code, reason), bufferedAmount: () => conn.bufferedAmount() },
      this.snapshotEvery,
    );
    client.down = down;
    client.up = new ConditionedLink(sim.settings.up, enabled, sim.scheduler, (b) => this.handle(client, b), isUnreliableMessage, this.linkSeed++);
    this.clients.add(client);
    return client;
  }

  /**
   * The connection is gone. Its player waits `reconnectGraceMs` for the session to come back
   * (`resumable`), or leaves now (kicked, or grace disabled).
   */
  disconnect(client: Client, resumable = true): void {
    client.closed = true;
    client.up?.dispose();
    client.down?.dispose();
    this.clients.delete(client);
    const s = client.session;
    client.session = null;
    client.playerId = -1;
    if (!s) return;
    if (resumable && this.graceTicks > 0) {
      s.client = null;
      s.expiresAt = this.game.tick + this.graceTicks;
      s.idle.aim = client.lastInput.aim;
      return;
    }
    this.endSession(s);
  }

  private endSession(s: Session): void {
    this.sessions.delete(s.token);
    if (s.prevToken) this.unconfirmed.delete(s.prevToken);
    this.game.removePlayer(s.playerId);
    this.broadcastRoster();
  }

  /** Called once per second to reset rate-limit windows. */
  resetRateLimits(): void {
    for (const c of this.clients) c.messagesThisSecond = 0;
  }

  /** Bytes from the transport. Must not be retained by the caller's buffer pool when netSim is on (they are queued). */
  receive(client: Client, bytes: Uint8Array): void {
    if (client.up) client.up.send(bytes);
    else this.handle(client, bytes);
  }

  private handle(client: Client, bytes: Uint8Array): void {
    if (client.closed) return;
    if (++client.messagesThisSecond > MAX_MESSAGES_PER_SECOND) {
      this.kick(client, CloseCode.RateLimited, 'rate limited');
      return;
    }
    if (bytes[0] === MsgType.Input) {
      // hot path (60/s per client): pooled decode, no allocation
      try {
        if (bytes.length > MAX_INPUT_BYTES) throw new DecodeError('oversized INPUT');
        decodeInputInto(bytes, this.packet);
      } catch (e) {
        this.strike(client, e);
        return;
      }
      this.onInput(client);
      return;
    }
    let msg: ClientMessage;
    try {
      const decoded = decodeMessage(bytes);
      if (decoded.type !== MsgType.Hello && decoded.type !== MsgType.Ping && decoded.type !== MsgType.Cmd) {
        throw new DecodeError('server-only message type from client');
      }
      msg = decoded;
    } catch (e) {
      this.strike(client, e);
      return;
    }

    switch (msg.type) {
      case MsgType.Hello:
        this.onHello(client, msg.protocolVersion, msg.contentHash, msg.name, msg.resumeToken);
        break;
      case MsgType.Ping:
        this.confirmToken(client);
        client.conn.send(encodePong(msg.clientTime, this.game.tick));
        break;
      case MsgType.Cmd:
        // SetLowBandwidth is state, not an action: dropping one would leave this client and the
        // server in different modes, and its one perk waits out a warm-up anyway
        if (msg.kind === CmdKind.SetLowBandwidth || this.takeCmdToken(client)) this.onCmd(client, msg.kind, msg.payload);
        break;
    }
  }

  private takeCmdToken(client: Client): boolean {
    const now = this.game.tick;
    const elapsed = Math.max(0, now - client.cmdTokensAt);
    client.cmdTokens = Math.min(CMD_BURST, client.cmdTokens + (elapsed * TICK_MS * CMDS_PER_SECOND) / 1000);
    client.cmdTokensAt = now;
    if (client.cmdTokens < 1) return false;
    client.cmdTokens--;
    return true;
  }

  private strike(client: Client, e: unknown): void {
    if (!(e instanceof DecodeError)) throw e;
    if (++client.strikes >= MAX_STRIKES) this.kick(client, CloseCode.BadMessage, 'malformed messages');
  }

  private onInput(client: Client): void {
    if (!client.joined) return;
    this.confirmToken(client);
    const m = this.packet;
    const current = this.game.tick;
    const newest = unwrapTick(m.newestTick, current);
    client.inputs.notePacket(newest);
    client.baselines.ack(m.ackSnapshotSeq);
    // where the client was drawing remote players when it sampled the newest input (lag comp)
    const renderTick = unwrapTick(m.renderTick, current) + m.renderFrac / 256;
    // inputs[i] is for newest − i, sampled when the client showed renderTick − renderLags[i];
    // copies of ticks already simulated are ignored
    for (let i = 0; i < m.count; i++) client.inputs.push(newest - i, m.inputs[i]!, current, renderTick - m.renderLags[i]!);
  }

  private onHello(client: Client, version: number, contentHash: number, rawName: string, resumeToken: string): void {
    if (client.joined) return;
    if (version !== PROTOCOL_VERSION || contentHash !== CONTENT_HASH) {
      this.kick(client, CloseCode.VersionMismatch, 'version mismatch: refresh to update');
      return;
    }
    const resumed = resumeToken ? (this.sessions.get(resumeToken) ?? this.unconfirmed.get(resumeToken)) : undefined;
    if (resumed) {
      this.resume(client, resumed, resumeToken);
      return;
    }
    if (this.humanCount >= this.maxHumans) {
      this.kick(client, CloseCode.RoomFull, 'room full');
      return;
    }
    const p = this.game.addPlayer(sanitizeName(rawName, `Player ${this.humanCount + 1}`));
    const session: Session = { token: newToken(), playerId: p.id, client: null, expiresAt: Infinity, idle: createInput(), prevToken: null };
    this.sessions.set(session.token, session);
    this.attach(client, session, false);
    this.broadcastRoster();
  }

  /** Reconnect: this connection takes the session's player over (replacing a stale connection). */
  private resume(client: Client, s: Session, presented: string): void {
    const stale = s.client;
    if (stale) {
      // the old socket hasn't noticed the drop yet (or the session moved tabs): retire it quietly
      stale.session = null;
      stale.playerId = -1;
      stale.conn.close(CloseCode.DuplicateSession, 'resumed from another connection');
      this.disconnect(stale);
    }
    // rotate the token (a leaked old one becomes useless), but keep the presented one valid until
    // this connection confirms it got the new one: the client may lose this WELCOME and retry
    this.sessions.delete(s.token);
    if (s.prevToken) this.unconfirmed.delete(s.prevToken);
    s.prevToken = presented;
    this.unconfirmed.set(presented, s);
    s.token = newToken();
    this.sessions.set(s.token, s);
    this.attach(client, s, true);
    // only this client missed anything: it gets a full snapshot (fresh baselines) and the roster
    client.conn.send(encodeRoster(this.rosterEntries()));
  }

  private attach(client: Client, s: Session, resumed: boolean): void {
    s.client = client;
    s.expiresAt = Infinity;
    client.session = s;
    client.playerId = s.playerId;
    const p = this.game.players[s.playerId]!;
    client.name = p.name;
    client.lastInput.aim = s.idle.aim;
    client.conn.send(
      encodeWelcome({
        playerId: p.id,
        seed: this.game.seed,
        serverTick: this.game.tick,
        mapId: this.game.map.id,
        tuningJson: JSON.stringify(this.game.tuning),
        sessionToken: s.token,
        resumed,
      }),
    );
  }

  private onCmd(client: Client, kind: number, payload: string): void {
    if (!client.joined) return;
    if (!this.dev && kind !== CmdKind.SetLowBandwidth) return;
    if (kind === CmdKind.SetTuning) {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const next: Partial<Tuning> = {};
        for (const key of Object.keys(defaultTuning) as (keyof Tuning)[]) {
          const v = parsed[key];
          if (typeof v === 'number' && Number.isFinite(v)) next[key] = v;
        }
        this.game.tuning = createTuning({ ...this.game.tuning, ...next });
        // every client predicts with the room's tuning: keep them in step
        const bytes = encodeTuning(JSON.stringify(this.game.tuning));
        for (const c of this.clients) if (c.joined && c !== client) c.conn.send(bytes);
      } catch {
        client.strikes++;
      }
    } else if (kind === CmdKind.SetLowBandwidth) {
      // half the snapshot rate for this client (docs/05 §2.2); allowed outside dev rooms too
      const on = payload === '1';
      client.snapshotEvery = on ? this.snapshotEvery * 2 : this.snapshotEvery;
      if (!on) client.lowBwSince = -1;
      else if (client.lowBwSince < 0) client.lowBwSince = this.game.tick;
    } else if (kind === CmdKind.Respawn) {
      const p = this.game.players[client.playerId];
      if (p?.alive) p.spawn(p.x, p.y + 0.5, this.game.tuning);
    }
  }

  /** Dev rooms: show each shooter the poses its shots were tested against (rewind visualiser). */
  private sendRewindDebug(lagComp: LagCompensator, tick: number): void {
    for (const c of this.clients) {
      if (!c.joined) continue;
      let targets: RewindTarget[] | null = null;
      let first = null;
      for (const r of lagComp.log) {
        if (r.shooter !== c.playerId) continue;
        first ??= r;
        // pellets and melee rays test the same target several times per shot: draw it once
        if (targets?.some((t) => t.id === r.target)) continue;
        let hit = false;
        for (const e of this.game.events) if (e.type === 'shot' && e.shooter === r.shooter && e.target === r.target) hit = true;
        (targets ??= []).push({ id: r.target, x: r.x, y: r.y, crouched: r.crouched, nowX: r.nowX, nowY: r.nowY, hit });
      }
      if (!first || !targets) continue;
      c.conn.send(
        encodeRewindDebug({
          tick,
          shooter: c.playerId,
          rewindTicks: Math.max(0, Math.min(255, tick - first.usedTick)),
          requestedTicks: Math.max(0, Math.min(255, tick - first.viewTick)),
          clamped: first.clamped,
          targets,
        }),
      );
    }
  }

  /** The client has the token from its latest WELCOME: retire the one it resumed with. */
  private confirmToken(client: Client): void {
    const s = client.session;
    if (!s?.prevToken) return;
    this.unconfirmed.delete(s.prevToken);
    s.prevToken = null;
  }

  /** Kicked players leave at once (no reconnect grace). */
  private kick(client: Client, code: number, reason: string): void {
    if (client.closed) return;
    // uWS runs the socket's close handler (→ a resumable disconnect) inside conn.close, so the
    // session must end first, or the kicked player would idle on with a token that still works
    const s = client.session;
    client.session = null;
    client.playerId = -1;
    if (s) this.endSession(s);
    client.conn.close(code, reason);
    this.disconnect(client, false);
  }

  /** When each player first shows in snapshots (ROSTER `since`: ids are reused). */
  private readonly shownSince = new WeakMap<PlayerState, number>();

  private rosterEntries(): RosterEntry[] {
    return this.game.players
      .filter((p) => p !== null)
      .map((p) => {
        let since = this.shownSince.get(p);
        if (since === undefined) {
          // a roster goes out as soon as a player is added (between ticks): it shows from the next one
          since = this.game.tick + 1;
          this.shownSince.set(p, since);
        }
        return { id: p.id, name: p.name, isBot: p.isBot, since };
      });
  }

  private broadcastRoster(): void {
    const bytes = encodeRoster(this.rosterEntries());
    for (const c of this.clients) if (c.joined) c.conn.send(bytes);
  }

  /** Advances the room by one 60 Hz tick. */
  tick(): void {
    const current = this.game.tick;
    const lagComp = this.lagComp;
    lagComp?.begin(current);
    this.inputs.length = 0;
    for (const c of this.clients) {
      if (!c.joined) continue;
      const health = c.inputs.health(current);
      if (health !== HEALTH_UNKNOWN && health < c.healthMin) c.healthMin = health;
      // this tick's input, or the last one repeated (docs/05 §13)
      c.inputs.take(current, c.lastInput);
      this.inputs[c.playerId] = c.lastInput;
      // the rewind cap allows for this client's view delay: interpolation (+ input batching when
      // slim, once it has been slim for LOW_BW_WARMUP_TICKS)
      const lowBandwidth = c.lowBwSince >= 0 && current - c.lowBwSince >= LOW_BW_WARMUP_TICKS;
      const viewDelayMs = lowBandwidth ? LOW_BANDWIDTH_INTERP_DELAY_MS + TICK_MS : INTERP_DELAY_MS;
      lagComp?.setView(c.playerId, c.inputs.renderTickFor(current), lowBandwidth ? c.snapshotEvery : this.snapshotEvery, viewDelayMs);
    }
    // players waiting for a reconnect stand idle; give up on them after the grace
    for (const s of this.sessions.values()) {
      if (s.client) continue;
      if (current >= s.expiresAt) this.endSession(s);
      else this.inputs[s.playerId] = s.idle;
    }
    this.game.step(this.inputs);
    lagComp?.record(this.game.tick, this.game.players);
    if (lagComp && lagComp.log.length > 0) this.sendRewindDebug(lagComp, current);
    for (const e of this.game.events) this.pendingEvents.push(e);

    if (this.game.tick % this.snapshotEvery === 0) {
      // 1..65535: 0 means "nothing acked" in INPUT
      this.snapshotSeq = (this.snapshotSeq % 0xffff) + 1;
      this.snapshots.begin(this.game, this.snapshotSeq, this.pendingEvents);
      for (const c of this.clients) {
        if (!c.joined || c.closed || this.game.tick % c.snapshotEvery !== 0) continue;
        // on TCP a stale snapshot is worse than a missing one (docs/05 §2.2)
        if (c.conn.bufferedAmount() > BACKPRESSURE_LIMIT) {
          c.snapshotsSkipped++;
          continue;
        }
        const health = c.healthMin === Infinity ? HEALTH_UNKNOWN : Math.max(-127, Math.min(127, c.healthMin));
        c.healthMin = Infinity;
        const me = this.game.players[c.playerId] ?? null;
        // skipped the previous interval (low-bandwidth mode): its events come with this one
        const skipped = c.lastSnapshotTick >= 0 && this.game.tick - c.lastSnapshotTick > this.snapshotEvery;
        c.lastSnapshotTick = this.game.tick;
        c.conn.send(
          this.snapshots.encodeFor({
            baselines: c.baselines,
            ackInputTick: current & 0xffff,
            inputBufferHealth: health,
            local: me,
            view: this.aoi && me ? aoiRect(me, this.game.map, c.view) : null,
            ...(skipped ? { extraEvents: this.previousEvents } : {}),
          }),
        );
      }
      const spent = this.previousEvents;
      this.previousEvents = this.pendingEvents;
      this.pendingEvents = spent;
      this.pendingEvents.length = 0;
    }
  }
}
