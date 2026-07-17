import { describe, expect, it } from "vitest";
import {
  createNetwork,
  MainThreadHost,
  readNetworkCounters,
  Simulation,
  type NetworkState,
} from "@/engine";
import { addEdge, addNode, createDocument, updateNodeConfig } from "@/document";
import type { SystemDoc } from "@/schema";
import { compileScenario } from "./compile";

// Client → LB → { API × 3 }. APIs are over-provisioned so counts reflect ROUTING.
function lbDoc(over?: { algorithm?: string; rate?: number }): SystemDoc {
  let doc = createDocument({ id: "lb", name: "LB", seed: 21 });
  doc = addNode(doc, "client", { x: 0, y: 0 }, "cl");
  doc = addNode(doc, "load-balancer", { x: 1, y: 0 }, "lb");
  doc = addNode(doc, "api", { x: 2, y: 0 }, "a1");
  doc = addNode(doc, "api", { x: 2, y: 1 }, "a2");
  doc = addNode(doc, "api", { x: 2, y: 2 }, "a3");
  doc = addEdge(doc, "cl", "lb", "e0");
  doc = addEdge(doc, "lb", "a1", "e1");
  doc = addEdge(doc, "lb", "a2", "e2");
  doc = addEdge(doc, "lb", "a3", "e3");
  doc = updateNodeConfig(doc, "cl", { requestRate: over?.rate ?? 600 });
  if (over?.algorithm) doc = updateNodeConfig(doc, "lb", { algorithm: over.algorithm });
  return doc;
}

function counts(doc: SystemDoc, horizonMs = 20_000) {
  const scenario = compileScenario(doc);
  const net = createNetwork(scenario);
  const sim = new Simulation<NetworkState>({
    handler: net.handler,
    initialState: net.state,
    seed: scenario.seed,
    init: net.init,
    recordTrace: false,
  });
  sim.run(horizonMs);
  const c = readNetworkCounters(sim.state, horizonMs);
  const at = (id: string) => c.stations[scenario.stations.findIndex((s) => s.id === id)].arrivals;
  return { roots: at("cl"), a1: at("a1"), a2: at("a2"), a3: at("a3"), result: c };
}

// Sums can trail roots by the handful of requests still in flight at the horizon.
const routedAll = (sum: number, roots: number) => {
  expect(sum).toBeLessThanOrEqual(roots);
  expect(roots - sum).toBeLessThanOrEqual(Math.max(5, roots * 0.005));
};

describe("load balancing: call-one routing", () => {
  it("round-robin splits load ~evenly across the 3 backends", () => {
    const { roots, a1, a2, a3 } = counts(lbDoc());
    routedAll(a1 + a2 + a3, roots); // each request hits exactly ONE backend
    const third = roots / 3;
    for (const a of [a1, a2, a3]) expect(Math.abs(a - third) / third).toBeLessThan(0.05);
  });

  it("least-connections also spreads load across all backends", () => {
    const { roots, a1, a2, a3 } = counts(lbDoc({ algorithm: "least-connections" }));
    routedAll(a1 + a2 + a3, roots);
    for (const a of [a1, a2, a3]) expect(a).toBeGreaterThan(roots * 0.15); // no backend starved
  });

  it("killing one backend shifts its share to the others: not a 1/3 outage", () => {
    const doc: SystemDoc = {
      ...lbDoc(),
      interventions: [{ id: "k", atLogicalTime: 0, kind: "kill", target: "a1" }],
    };
    const { roots, a1, a2, a3 } = counts(doc);
    expect(a1).toBe(0); // dead backend is taken out of rotation
    routedAll(a2 + a3, roots); // all load absorbed by the survivors
    expect(Math.abs(a2 - a3) / roots).toBeLessThan(0.05); // ~evenly between them

    // And it's not an outage: throughput stays high.
    const r = new MainThreadHost().run(compileScenario(doc), { horizonMs: 20_000 });
    expect(r.totals.completions).toBeGreaterThan(r.totals.failures * 20);
  });
});

describe("replicas raise the throughput ceiling", () => {
  const oneApi = (replicas: number): SystemDoc => {
    let doc = createDocument({ id: "rep", name: "Rep", seed: 8 });
    doc = addNode(doc, "client", { x: 0, y: 0 }, "cl");
    doc = addNode(doc, "api", { x: 1, y: 0 }, "api");
    doc = addEdge(doc, "cl", "api", "e0");
    doc = updateNodeConfig(doc, "cl", { requestRate: 1200 }); // overloads a small API
    doc = updateNodeConfig(doc, "api", { concurrency: 10, serviceTime: 20, replicas });
    return doc;
  };

  it("doubling capacity (1 replica) roughly doubles sustained throughput", () => {
    const run = (r: number) => new MainThreadHost().run(compileScenario(oneApi(r)), { horizonMs: 20_000 }).totals.completions;
    const base = run(0); // ceiling ≈ 10/20ms = 500 rps
    const scaled = run(1); // ceiling ≈ 20/20ms = 1000 rps
    expect(scaled).toBeGreaterThan(base * 1.5);
  });
});

describe("selection stays deterministic", () => {
  it("round-robin and random are byte-identical across same-seed runs", () => {
    for (const algorithm of ["round-robin", "random"]) {
      const doc = lbDoc({ algorithm });
      const run = () => new MainThreadHost().run(compileScenario(doc), { horizonMs: 10_000 });
      expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    }
  });
});
