import { describe, expect, it } from "vitest";
import { Simulation } from "./simulation";
import {
  initialQueueState,
  queueHandler,
  seedArrivals,
  type QueueParams,
} from "./models/single-server-queue";

const PARAMS: QueueParams = {
  arrivalRate: 0.8,
  serviceRate: 1,
  servers: 1,
  queueCapacity: Infinity,
};

const build = (seed: number): Simulation<ReturnType<typeof initialQueueState>> =>
  new Simulation({
    seed,
    initialState: initialQueueState(PARAMS),
    handler: queueHandler,
    init: seedArrivals,
  });

describe("Simulation determinism", () => {
  it("golden trace: same seed -> byte-identical trace and state", () => {
    const a = build(123);
    const b = build(123);
    a.run(3000);
    b.run(3000);
    expect(a.trace).toEqual(b.trace);
    expect(a.state).toEqual(b.state);
    expect(a.now).toEqual(b.now);
  });

  it("different seeds diverge", () => {
    const a = build(123);
    const c = build(124);
    a.run(3000);
    c.run(3000);
    expect(c.trace).not.toEqual(a.trace);
  });

  it("replay-equivalence: restore from a snapshot reproduces the tail exactly", () => {
    const full = build(77);
    full.run(3000);

    const part = build(77);
    part.run(1200);
    const snap = part.snapshot();

    const resumed = Simulation.restore(snap, queueHandler);
    resumed.run(3000);

    const tail = full.trace.filter((e) => e.time > snap.now);
    expect(resumed.trace).toEqual(tail);
    expect(resumed.state).toEqual(full.state);
    expect(resumed.now).toEqual(full.now);
  });
});
