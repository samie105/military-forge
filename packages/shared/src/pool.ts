/**
 * Object pool: lets hot paths reuse objects instead of allocating every tick (docs/02 §18).
 */
export class Pool<T> {
  private readonly free: T[] = [];

  constructor(
    private readonly create: () => T,
    private readonly reset: (item: T) => void,
    prewarm = 0,
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(create());
  }

  acquire(): T {
    return this.free.pop() ?? this.create();
  }

  release(item: T): void {
    this.reset(item);
    this.free.push(item);
  }

  get available(): number {
    return this.free.length;
  }
}

/**
 * Fixed-capacity slot allocator: hands out stable integer ids in [0, capacity) and recycles
 * them lowest-first, so id assignment is deterministic.
 */
export class IdAllocator {
  private readonly used: Uint8Array;

  constructor(readonly capacity: number) {
    this.used = new Uint8Array(capacity);
  }

  allocate(): number {
    for (let i = 0; i < this.capacity; i++) {
      if (this.used[i] === 0) {
        this.used[i] = 1;
        return i;
      }
    }
    return -1;
  }

  free(id: number): void {
    if (id >= 0 && id < this.capacity) this.used[id] = 0;
  }

  isUsed(id: number): boolean {
    return this.used[id] === 1;
  }
}
