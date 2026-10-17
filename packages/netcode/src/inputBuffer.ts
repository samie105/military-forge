/**
 * Server-side per-client input queue, indexed by tick (docs/05 §4, §13). Clients run ahead and tag
 * each input with the server tick it is for; the room takes exactly that tick's input when it
 * simulates it, or repeats the last one if it never arrived. Late inputs are dropped (the past is
 * never rewritten). Preallocated ring: no allocation per packet.
 */
import { copyInput, createInput, type Input } from '@military-forge/sim';
import { HEALTH_UNKNOWN } from '@military-forge/protocol';

export const INPUT_RING = 64;
/** Inputs further ahead than this are refused (clock-manipulation speedhack guard, docs/05 §14). */
export const MAX_INPUT_LEAD = 32;

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

  /** Records a packet's newest tick (drives buffer health, even if its inputs are refused). */
  notePacket(newestTick: number): void {
    this.newestSeen = newestTick;
  }

  /**
   * Stores the input for `tick`; `current` is the next tick the room will simulate. Inputs for ticks
   * already simulated are ignored (redundant copies, or late); returns whether it was stored.
   */
  push(tick: number, input: Readonly<Input>, current: number, renderTick = Number.NaN): boolean {
    if (tick < current) return false;
    if (tick >= current + MAX_INPUT_LEAD) {
      this.refused++;
      return false;
    }
    const i = tick & (INPUT_RING - 1);
    // a redundant copy of an input we already have: keep the first (its render tick is exact)
    if (this.ticks[i] === tick) return true;
    this.ticks[i] = tick;
    copyInput(this.inputs[i]!, input);
    this.renderTicks[i] = renderTick;
    return true;
  }

  /** Copies the input for `tick` into `out`. False (out untouched: repeat last) if it never arrived. */
  take(tick: number, out: Input): boolean {
    const i = tick & (INPUT_RING - 1);
    if (this.ticks[i] !== tick) {
      if (this.newestSeen >= 0) this.missed++;
      return false;
    }
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
