// Autoscaling law validation: a damped HPA-style control loop resizes a station's
// fleet toward a target metric. Validated like every other law: convergence,
// damping, the provision lag, and determinism.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { Scenario, StationScaling } from "../scenario";
import { createNetwork, readNetworkCounters, type NetworkState } from "./network";

// One instance = 1 server × 10ms service ⇒ 100 req/s of capacity.
const scaled = (
  ratePerMs: number,
  scaling: Partial<StationScaling>,
  seed = 11,
): Scenario => {
  const s: StationScaling = {
    perInstanceServers: 1,
    minInstances: 1,
    maxInstances: 10,
    initialInstances: 1,
    metric: "utilization",
    target: 0.7,
    evalIntervalMs: 1000,
    provisionMs: 1000,
    stabilizationMs: 5000,
    ...scaling,
  };
  return {
    seed,
    stations: [
      {
        id: "api",
        servers: s.initialInstances * s.perInstanceServers,
        serviceRatePerMs: 1 / 10,
        queueCapacity: 1e9,
        deps: [],
        scaling: s,
      },
    ],
    arrivals: [{ station: 0, ratePerMs }],
    interventions: [],
  };
};

const run = (scenario: Scenario, horizonMs = 60_000) =>
  new MainThreadHost().run(scenario, { horizonMs, sampleIntervalMs: 1000 });

const instancesOf = (r: ReturnType<MainThreadHost["run"]>) =>
  r.windows.map((w) => w.stations[0].instances);

describe("autoscaling: convergence law", () => {
  // λ=350/s vs 100/s per instance at target ρ=0.7 ⇒ steady state 5 instances.
  it("an overloaded tier grows to the demand and settles at the target", () => {
    const r = run(scaled(0.35, {}));
    const tail = r.windows.slice(-15);
    for (const w of tail) {
      expect(w.stations[0].instances).toBeGreaterThanOrEqual(5);
      expect(w.stations[0].instances).toBeLessThanOrEqual(6);
    }
    const meanRho = tail.reduce((a, w) => a + w.stations[0].utilization, 0) / tail.length;
    expect(meanRho).toBeGreaterThan(0.5);
    expect(meanRho).toBeLessThan(0.9);
  });

  it("damped: the settled fleet does not oscillate", () => {
    const tail = instancesOf(run(scaled(0.35, {}))).slice(-20);
    expect(new Set(tail).size).toBeLessThanOrEqual(2); // settled, not flapping
  });

  it("raises the throughput ceiling a fixed tier is stuck under", () => {
    const fixed: Scenario = { ...scaled(0.35, {}) };
    fixed.stations = [{ ...fixed.stations[0], scaling: undefined }]; // 1 server forever
    const elastic = run(scaled(0.35, {})).totals.completions;
    const rigid = run(fixed).totals.completions;
    expect(elastic).toBeGreaterThan(rigid * 2.5);
  });

  it("scales down an over-provisioned fleet and stops at the floor demand needs", () => {
    // 10 instances (1000/s capacity) for λ=50/s ⇒ 1 instance at ρ=0.5 suffices.
    // (Not λ=70: that puts one instance exactly AT the ρ=0.7 target, the knife
    // edge where any measurement noise legitimately flaps the fleet ±1, the
    // same behavior a real HPA shows at an exact-target steady state.)
    const r = run(scaled(0.05, { initialInstances: 10 }));
    const tail = instancesOf(r).slice(-15);
    for (const i of tail) expect(i).toBe(1);
  });

  it("never exceeds max instances: autoscaling moves the wall, not removes it", () => {
    const r = run(scaled(1.0, { maxInstances: 4 })); // demand ⇒ ~15, cap 4
    for (const i of instancesOf(r)) expect(i).toBeLessThanOrEqual(4);
    const lastRho = r.windows[r.windows.length - 1].stations[0].utilization;
    expect(lastRho).toBeGreaterThan(0.95); // saturated like a fixed tier
  });
});

describe("autoscaling: rate metric", () => {
  it("request-rate scaling jumps straight to ceil(rate / target)", () => {
    // 450/s at 100 req/s per instance ⇒ 5 instances, in one decision.
    const r = run(scaled(0.45, { metric: "rate", target: 100 }), 30_000);
    const tail = instancesOf(r).slice(-10);
    for (const i of tail) expect(i).toBe(5);
    // Rate sees true demand (ρ is capped at 1), so 5 are ordered by the 1st tick
    // and online right after the provision delay.
    expect(instancesOf(r)[2]).toBe(5); // window ending t=3000 (tick 1s + boot 1s)
  });
});

describe("autoscaling: provision lag", () => {
  it("new capacity arrives only after the boot time", () => {
    const r = run(scaled(0.35, { provisionMs: 3000 }), 20_000);
    const inst = instancesOf(r);
    expect(inst[0]).toBe(1); // t=1000: first decision just made
    expect(inst[1]).toBe(1); // t=2000: still booting
    expect(inst[2]).toBe(1); // t=3000: still booting
    expect(inst[3]).toBeGreaterThan(1); // t=4000: 1s tick + 3s boot ⇒ online
  });
});

describe("autoscaling: determinism", () => {
  const scenario = scaled(0.35, {}, 424242);

  it("golden-trace: two same-seed runs are byte-identical", () => {
    const a = run(scenario, 20_000);
    const b = run(scenario, 20_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: a snapshot taken mid-provisioning replays exactly", () => {
    const mk = () => {
      const net = createNetwork(scenario);
      return new Simulation<NetworkState>({
        handler: net.handler,
        initialState: net.state,
        seed: scenario.seed,
        init: net.init,
        recordTrace: false,
      });
    };
    const cont = mk();
    cont.run(15_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 15_000));

    const s = mk();
    s.run(1500); // between the first decision (t=1000) and its arrival (t=2000)
    const s2 = Simulation.restore(s.snapshot(), createNetwork(scenario).handler, { recordTrace: false });
    s2.run(15_000);
    expect(JSON.stringify(readNetworkCounters(s2.state, 15_000))).toBe(want);
  });

  it("an unscaled scenario schedules no control-loop events", () => {
    const fixed: Scenario = {
      seed: 5,
      stations: [{ id: "s", servers: 2, serviceRatePerMs: 1 / 10, queueCapacity: 1e9, deps: [] }],
      arrivals: [{ station: 0, ratePerMs: 0.05 }],
      interventions: [],
    };
    const net = createNetwork(fixed);
    const sim = new Simulation<NetworkState>({
      handler: net.handler,
      initialState: net.state,
      seed: fixed.seed,
      init: net.init,
      recordTrace: true,
    });
    sim.run(10_000);
    expect(sim.trace.some((e) => e.kind === "scaleTick" || e.kind === "scaleUp")).toBe(false);
  });
});

describe("autoscaling: interaction with failure injection", () => {
  it("makes no decisions while dead, then recovers after restart", () => {
    const scenario = scaled(0.35, {});
    scenario.interventions = [
      { atMs: 20_000, kind: "kill", station: 0 },
      { atMs: 30_000, kind: "restart", station: 0 },
    ];
    const r = run(scenario, 60_000);
    const inst = instancesOf(r);
    const dead = inst.slice(21, 30); // fleet frozen while down (no metrics)
    expect(new Set(dead).size).toBe(1);
    const tail = inst.slice(-10); // converges again after restart
    for (const i of tail) {
      expect(i).toBeGreaterThanOrEqual(5);
      expect(i).toBeLessThanOrEqual(6);
    }
  });
});
