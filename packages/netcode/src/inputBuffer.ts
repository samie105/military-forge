/**
 * Server-side per-client input queue, indexed by tick (docs/05 §4, §13). Clients run ahead and tag
 * each input with the server tick it is for; the room takes exactly that tick's input when it
 * simulates it, or repeats the last one if it never arrived. Late inputs are dropped (the past is
 * never rewritten). Preallocated ring: no allocation per packet.
 */
import { Btn, copyInput, createInput, type Input } from '@military-forge/sim';
import { HEALTH_UNKNOWN } from '@military-forge/protocol';

export const INPUT_RING = 64;
/**
 * Inputs further ahead than this are refused (clock-manipulation speedhack guard, docs/05 §14). 48
 * ticks (800 ms; was 32): a phone's upload queue draining after a latency spike hands over a
 * second of inputs at once, and a client that sped up through the spike may be ~40 ticks ahead
 * for a moment. Less than INPUT_RING, which holds them.
 */
export const MAX_INPUT_LEAD = 48;

/**
 * Buttons whose press is an action (docs/05 §6.1: edge-triggered in the sim). A press that arrives
 * after its tick was simulated is latched onto the next tick instead of being lost (forSim).
 */
/** how late a press may be and still be applied (750 ms): later than that it would surprise more than help */
export const MAX_LATCH_TICKS = 45;
/** the late-press records span late presses and the lead (MAX_LATCH_TICKS + MAX_INPUT_LEAD < this) */
const PRESS_RING = 128;
/**
 * How long the server repeats a client's last input while none arrive (a stalled connection): 0.5 s.
 * After that the player lets go of everything (keeps its aim) instead of running or jetting on
 * for the whole stall: a held key during a 6 s black hole walked the player off a ledge (#M1).
 * Long enough that a latency spike's late inputs (they arrive in a burst and are mostly dropped
 * anyway) rarely meet it.
 */
export const MAX_REPEAT_TICKS = 30;

export const LATCHED_BUTTONS =
  Btn.Fire | Btn.Fire2 | Btn.Reload | Btn.Swap | Btn.Grenade | Btn.Melee | Btn.Interact | Btn.Dual | Btn.CycleGrenade | Btn.Dash | Btn.Shield;

export class InputBuffer {
  private readonly ticks = new Float64Array(INPUT_RING).fill(-1);
  private readonly inputs: Input[] = Array.from({ length: INPUT_RING }, createInput);
  /** the server tick the client was rendering remote players at when it sampled each input */
  private readonly renderTicks = new Float64Array(INPUT_RING).fill(Number.NaN);
  private lastRenderTick = Number.NaN;
  private lastRenderFor = 0;
  /** full tick of the newest input in the most recent packet, −1 before the first */
  newestSeen = -1;
  /** ticks simulated with a repeated input although this client was sending (late or lost) */
  missed = 0;
  /** ticks simulated with the client's real input */
  used = 0;
  /** inputs refused for being too far ahead */
  refused = 0;
  /** presses that arrived late and were applied a few ticks later instead of being lost */
  latched = 0;
  /** ticks in a row simulated without this client's input (MAX_REPEAT_TICKS) */
  missedRun = 0;
  /** ticks simulated with a neutral input after the repeat ran out */
  neutral = 0;
  private readonly idleInput = createInput();

  // late presses (docs/05 §13): what the client sent and what the sim used, per tick
  private readonly sentTick = new Float64Array(PRESS_RING).fill(-1);
  private readonly sentButtons = new Uint16Array(PRESS_RING);
  private readonly sentSelect = new Uint8Array(PRESS_RING);
  private readonly usedTick = new Float64Array(PRESS_RING).fill(-1);
  private readonly usedButtons = new Uint16Array(PRESS_RING);
  private readonly usedSelect = new Uint8Array(PRESS_RING);
  /** late ticks not looked at yet */
  private readonly late: number[] = [];
  private latchButtons = 0;
  private latchSelect = 0;
  private readonly simInput = createInput();

  /** Records a packet's newest tick (drives buffer health, even if its inputs are refused). */
  notePacket(newestTick: number): void {
    this.newestSeen = newestTick;
  }

  /**
   * Stores the input for `tick`; `current` is the next tick the room will simulate. Inputs for ticks
   * already simulated are ignored (redundant copies, or late); returns whether it was stored.
   */
  push(tick: number, input: Readonly<Input>, current: number, renderTick = Number.NaN): boolean {
    if (tick < current) {
      // too late for its tick: remember what it held, so a press in it isn't lost (forSim)
      const j = tick & (PRESS_RING - 1);
      if (current - tick <= MAX_LATCH_TICKS && this.sentTick[j] !== tick) {
        this.noteSent(tick, input);
        if (this.late.length < PRESS_RING) this.late.push(tick);
      }
      return false;
    }
    if (tick >= current + MAX_INPUT_LEAD) {
      this.refused++;
      return false;
    }
    const i = tick & (INPUT_RING - 1);
    // a redundant copy of an input we already have: keep the first (its render tick is exact)
    if (this.ticks[i] === tick) return true;
    this.ticks[i] = tick;
    this.noteSent(tick, input);
    copyInput(this.inputs[i]!, input);
    this.renderTicks[i] = renderTick;
    return true;
  }

  /** Copies the input for `tick` into `out`. False (out untouched: repeat last) if it never arrived. */
  take(tick: number, out: Input): boolean {
    const i = tick & (INPUT_RING - 1);
    if (this.ticks[i] !== tick) {
      if (this.newestSeen >= 0) {
        this.missed++;
        this.missedRun++;
      }
      return false;
    }
    this.missedRun = 0;
    copyInput(out, this.inputs[i]!);
    this.ticks[i] = -1;
    this.used++;
    if (!Number.isNaN(this.renderTicks[i]!)) {
      this.lastRenderTick = this.renderTicks[i]!;
      this.lastRenderFor = tick;
    }
    return true;
  }

  /**
   * The input the sim uses on `tick` (call after take, with take's `out`): `out` itself, or a copy
   * with the presses that arrived too late for their own ticks since the last call. Without this a
   * tap of fire, dash, grenade… that a latency spike delays past its tick never happens on the
   * server, though the client already showed it; with it, it happens a few ticks late (a smaller
   * correction). Each late press is applied once: only the client's own press edges count, and only
   * buttons the sim didn't have down on that tick.
   */
  forSim(tick: number, out: Readonly<Input>): Input | Readonly<Input> {
    const M = PRESS_RING - 1;
    for (const t of this.late) {
      const j = t & M;
      if (this.usedTick[j] !== t || this.sentTick[j] !== t) continue;
      const p = (t - 1) & M;
      // the client's own previous tick when we have it, else what the sim had down
      const before = this.sentTick[p] === t - 1 ? this.sentButtons[p]! : this.usedTick[p] === t - 1 ? this.usedButtons[p]! : 0xffff;
      this.latchButtons |= this.sentButtons[j]! & ~before & ~this.usedButtons[j]! & LATCHED_BUTTONS;
      if (this.sentSelect[j] !== 0 && this.usedSelect[j] !== this.sentSelect[j]) this.latchSelect = this.sentSelect[j]!;
    }
    this.late.length = 0;
    let use: Readonly<Input> = out;
    if (this.missedRun > MAX_REPEAT_TICKS) {
      // a stall: hands off the keys (the aim stays where it was)
      this.idleInput.aim = out.aim;
      use = this.idleInput;
      this.neutral++;
    }
    const add = this.latchButtons & ~use.buttons;
    if (add !== 0 || (this.latchSelect !== 0 && use.weaponSelect === 0)) {
      const base = use;
      copyInput(this.simInput, base);
      this.simInput.buttons |= add;
      if (base.weaponSelect === 0) this.simInput.weaponSelect = this.latchSelect;
      for (let b = add; b !== 0; b &= b - 1) this.latched++;
      if (base.weaponSelect === 0 && this.latchSelect !== 0) this.latched++;
      use = this.simInput;
    }
    this.latchButtons = 0;
    this.latchSelect = 0;
    const i = tick & M;
    this.usedTick[i] = tick;
    this.usedButtons[i] = use.buttons;
    this.usedSelect[i] = use.weaponSelect;
    return use as Input;
  }

  private noteSent(tick: number, input: Readonly<Input>): void {
    const j = tick & (PRESS_RING - 1);
    this.sentTick[j] = tick;
    this.sentButtons[j] = input.buttons;
    this.sentSelect[j] = input.weaponSelect;
  }

  /**
   * The client's render tick for the input used on `tick` (call after take). A repeated input gets
   * the last known one, advanced by the ticks since: the client's view keeps moving. NaN if unknown.
   */
  renderTickFor(tick: number): number {
    return this.lastRenderTick + (tick - this.lastRenderFor);
  }

  /** How many ticks beyond `current` are already queued (docs/05 §4). HEALTH_UNKNOWN before any input. */
  health(current: number): number {
    return this.newestSeen < 0 ? HEALTH_UNKNOWN : this.newestSeen - current;
  }

  has(tick: number): boolean {
    return this.ticks[tick & (INPUT_RING - 1)] === tick;
  }
}
