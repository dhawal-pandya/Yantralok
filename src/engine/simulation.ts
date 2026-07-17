// Deterministic discrete-event core. Logical clock, total event order by
// (time, seq), snapshot/restore via deterministic replay.
import { createPrng, type Prng } from "./prng";
import { MinHeap } from "./heap";

export interface SimEvent {
  time: number;
  seq: number;
  kind: string;
  data?: Record<string, number>;
}

export interface SimContext<S> {
  readonly now: number;
  readonly state: S;
  readonly prng: Prng;
  schedule(delay: number, kind: string, data?: Record<string, number>): void;
}

export type EventHandler<S> = (ctx: SimContext<S>, event: SimEvent) => void;

export interface Snapshot<S> {
  now: number;
  seq: number;
  prngState: number[];
  heap: SimEvent[];
  state: S;
}

export interface SimulationOptions<S> {
  handler: EventHandler<S>;
  seed?: number;
  initialState?: S;
  init?: (ctx: SimContext<S>) => void;
  recordTrace?: boolean;
  restoreFrom?: Snapshot<S>;
}

const eventLess = (a: SimEvent, b: SimEvent): boolean =>
  a.time < b.time || (a.time === b.time && a.seq < b.seq);

export class Simulation<S> {
  now = 0;
  state: S;
  trace: SimEvent[] = [];
  readonly recordTrace: boolean;

  private seq = 0;
  private readonly prng: Prng;
  private readonly heap: MinHeap<SimEvent>;
  private readonly handler: EventHandler<S>;
  private readonly ctx: SimContext<S>;

  constructor(options: SimulationOptions<S>) {
    this.handler = options.handler;
    this.recordTrace = options.recordTrace ?? true;
    const r = options.restoreFrom;
    if (r) {
      this.now = r.now;
      this.seq = r.seq;
      this.state = structuredClone(r.state);
      this.prng = createPrng(0, r.prngState.slice());
      this.heap = new MinHeap(eventLess, structuredClone(r.heap));
    } else {
      if (options.initialState === undefined)
        throw new Error("initialState is required when not restoring");
      this.state = options.initialState;
      this.prng = createPrng(options.seed ?? 0);
      this.heap = new MinHeap(eventLess);
    }
    this.ctx = this.createContext();
    if (!r) options.init?.(this.ctx);
  }

  static restore<S>(
    snapshot: Snapshot<S>,
    handler: EventHandler<S>,
    options?: { recordTrace?: boolean },
  ): Simulation<S> {
    return new Simulation<S>({
      handler,
      restoreFrom: snapshot,
      recordTrace: options?.recordTrace,
    });
  }

  get pending(): number {
    return this.heap.size;
  }

  schedule(delay: number, kind: string, data?: Record<string, number>): void {
    if (delay < 0) throw new Error(`negative delay: ${delay}`);
    this.heap.push({ time: this.now + delay, seq: this.seq++, kind, data });
  }

  step(): boolean {
    const event = this.heap.pop();
    if (event === undefined) return false;
    this.now = event.time;
    if (this.recordTrace) this.trace.push(event);
    this.handler(this.ctx, event);
    return true;
  }

  run(until: number): void {
    for (;;) {
      const next = this.heap.peek();
      if (next === undefined || next.time > until) break;
      this.step();
    }
  }

  snapshot(): Snapshot<S> {
    return {
      now: this.now,
      seq: this.seq,
      prngState: this.prng.getState(),
      heap: structuredClone(this.heap.toArray()),
      state: structuredClone(this.state),
    };
  }

  private createContext(): SimContext<S> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters need a closure ref
    const self = this;
    return {
      get now() {
        return self.now;
      },
      get state() {
        return self.state;
      },
      get prng() {
        return self.prng;
      },
      schedule: (delay, kind, data) => self.schedule(delay, kind, data),
    };
  }
}
