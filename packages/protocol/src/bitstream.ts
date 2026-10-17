/**
 * Bit-level writer/reader over pre-allocated buffers (docs/05 §6). Little-endian bit order.
 * Readers throw DecodeError on truncated or malformed input; they never crash otherwise.
 */
import { utf8Decode, utf8Encode } from '@military-forge/shared';

export class DecodeError extends Error {
  override name = 'DecodeError';
}

const POW2: number[] = [];
for (let i = 0, v = 1; i <= 32; i++, v *= 2) POW2.push(v);

const f64 = new Float64Array(1);
const f64Bytes = new Uint8Array(f64.buffer);

export class BitWriter {
  private buf: Uint8Array;
  private bitPos = 0;

  constructor(capacity = 2048) {
    this.buf = new Uint8Array(capacity);
  }

  reset(): this {
    this.buf.fill(0, 0, (this.bitPos + 7) >>> 3);
    this.bitPos = 0;
    return this;
  }

  get bitLength(): number {
    return this.bitPos;
  }

  private ensure(bits: number): void {
    const needed = (this.bitPos + bits + 7) >>> 3;
    if (needed <= this.buf.length) return;
    const next = new Uint8Array(Math.max(needed, this.buf.length * 2));
    next.set(this.buf);
    this.buf = next;
  }

  /** Writes the low `bits` (1..32) bits of `value` as unsigned. */
  bits(value: number, bits: number): this {
    this.ensure(bits);
    // integer ops only: masks and unsigned shifts (no float division in the hot path)
    const v = bits === 32 ? value >>> 0 : (value & (POW2[bits]! - 1)) >>> 0;
    for (let written = 0; written < bits; ) {
      const offset = this.bitPos & 7;
      const n = Math.min(8 - offset, bits - written);
      this.buf[this.bitPos >>> 3]! |= ((v >>> written) & ((1 << n) - 1)) << offset;
      written += n;
      this.bitPos += n;
    }
    return this;
  }

  /** Two's complement signed integer in `bits` bits. Values are clamped to the representable range. */
  signed(value: number, bits: number): this {
    const max = POW2[bits - 1]! - 1;
    const min = -POW2[bits - 1]!;
    const v = Math.max(min, Math.min(max, Math.round(value)));
    return this.bits(v < 0 ? v + POW2[bits]! : v, bits);
  }

  /** Unsigned, clamped to [0, 2^bits − 1]. */
  unsigned(value: number, bits: number): this {
    return this.bits(Math.max(0, Math.min(POW2[bits]! - 1, Math.round(value))), bits);
  }

  bool(v: boolean): this {
    return this.bits(v ? 1 : 0, 1);
  }

  u8(v: number): this {
    return this.unsigned(v, 8);
  }

  u16(v: number): this {
    return this.bits(v & 0xffff, 16);
  }

  u32(v: number): this {
    return this.bits(v >>> 0, 32);
  }

  f64(v: number): this {
    f64[0] = v;
    for (let i = 0; i < 8; i++) this.bits(f64Bytes[i]!, 8);
    return this;
  }

  /** UTF-8 string with a length prefix of `lenBits` bits (bytes beyond the max are truncated). */
  string(s: string, lenBits = 8): this {
    const bytes = utf8Encode(s);
    const len = Math.min(bytes.length, POW2[lenBits]! - 1);
    this.bits(len, lenBits);
    for (let i = 0; i < len; i++) this.bits(bytes[i]!, 8);
    return this;
  }

  /** View of the written bytes (valid until the next write/reset). */
  finish(): Uint8Array {
    return this.buf.subarray(0, (this.bitPos + 7) >>> 3);
  }
}

export class BitReader {
  private bitPos = 0;
  private bitLength: number;

  constructor(private buf: Uint8Array) {
    this.bitLength = buf.length * 8;
  }

  /** Re-targets this reader at a new buffer (lets hot paths reuse one reader: no allocation). */
  reset(buf: Uint8Array): this {
    this.buf = buf;
    this.bitPos = 0;
    this.bitLength = buf.length * 8;
    return this;
  }

  get remainingBits(): number {
    return this.bitLength - this.bitPos;
  }

  /** Skips to the next byte boundary (pairs with a writer section that ended on a padded byte). */
  alignToByte(): this {
    this.bitPos = Math.min(this.bitLength, (this.bitPos + 7) & ~7);
    return this;
  }

  bits(bits: number): number {
    if (bits < 1 || bits > 32) throw new DecodeError(`invalid bit count ${bits}`);
    if (this.bitPos + bits > this.bitLength) throw new DecodeError('unexpected end of message');
    let value = 0;
    for (let read = 0; read < bits; ) {
      const byte = this.buf[this.bitPos >>> 3]!;
      const offset = this.bitPos & 7;
      const n = Math.min(8 - offset, bits - read);
      const chunk = (byte >>> offset) & ((1 << n) - 1);
      value += chunk * POW2[read]!;
      read += n;
      this.bitPos += n;
    }
    return value;
  }

  signed(bits: number): number {
    const v = this.bits(bits);
    return v >= POW2[bits - 1]! ? v - POW2[bits]! : v;
  }

  bool(): boolean {
    return this.bits(1) === 1;
  }

  u8(): number {
    return this.bits(8);
  }

  u16(): number {
    return this.bits(16);
  }

  u32(): number {
    return this.bits(32);
  }

  f64(): number {
    for (let i = 0; i < 8; i++) f64Bytes[i] = this.bits(8);
    return f64[0]!;
  }

  string(lenBits = 8): string {
    const len = this.bits(lenBits);
    if (len * 8 > this.remainingBits) throw new DecodeError('string overruns message');
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = this.bits(8);
    return utf8Decode(bytes);
  }
}
