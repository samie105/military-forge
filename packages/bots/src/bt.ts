/**
 * A small behaviour tree (docs/08 §9). The brain ticks it from the root at 10 Hz; actions don't
 * run for long themselves, they set intents (where to go, who to shoot, a throw, a dodge) that the
 * per-tick layers carry out. `trace` records the branch that ran last, for tests and the debug view.
 */

export const Status = {
  Success: 0,
  Failure: 1,
  Running: 2,
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export interface BtNode<C> {
  readonly name: string;
  tick(ctx: C, trace: string[]): Status;
}

/** Runs children in order until one doesn't fail. */
export class Selector<C> implements BtNode<C> {
  constructor(
    readonly name: string,
    readonly children: readonly BtNode<C>[],
  ) {}

  tick(ctx: C, trace: string[]): Status {
    for (const c of this.children) {
      const s = c.tick(ctx, trace);
      if (s !== Status.Failure) return s;
    }
    return Status.Failure;
  }
}

/** Runs children in order while they succeed. */
export class Sequence<C> implements BtNode<C> {
  constructor(
    readonly name: string,
    readonly children: readonly BtNode<C>[],
  ) {}

  tick(ctx: C, trace: string[]): Status {
    for (const c of this.children) {
      const s = c.tick(ctx, trace);
      if (s !== Status.Success) return s;
    }
    return Status.Success;
  }
}

export class Condition<C> implements BtNode<C> {
  constructor(
    readonly name: string,
    private readonly test: (ctx: C) => boolean,
  ) {}

  tick(ctx: C): Status {
    return this.test(ctx) ? Status.Success : Status.Failure;
  }
}

export class Action<C> implements BtNode<C> {
  constructor(
    readonly name: string,
    private readonly run: (ctx: C) => Status,
  ) {}

  tick(ctx: C, trace: string[]): Status {
    const s = this.run(ctx);
    if (s !== Status.Failure) trace.push(this.name);
    return s;
  }
}
