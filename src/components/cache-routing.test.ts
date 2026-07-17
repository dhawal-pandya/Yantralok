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

// Client → API → {Redis (cache), Postgres}. Everything downstream is over-provisioned
// so counts reflect ROUTING, not queueing. API does not retry, so a call to a
// dependency is counted exactly once per request (clean fractions).
function routingDoc(over?: { hitRatio?: number; writeRatio?: number; rate?: number }): SystemDoc {
  let doc = createDocument({ id: "route", name: "Routing", seed: 77 });
  doc = addNode(doc, "client", { x: 0, y: 0 }, "cl");
  doc = addNode(doc, "api", { x: 1, y: 0 }, "api");
  doc = addNode(doc, "redis", { x: 2, y: 0 }, "rd");
  doc = addNode(doc, "postgres", { x: 3, y: 0 }, "pg");
  doc = addEdge(doc, "cl", "api", "e0");
  doc = addEdge(doc, "api", "rd", "e1");
  doc = addEdge(doc, "api", "pg", "e2");
  doc = updateNodeConfig(doc, "cl", { requestRate: over?.rate ?? 600, writeRatio: over?.writeRatio ?? 0 });
  doc = updateNodeConfig(doc, "api", { concurrency: 100_000, serviceTime: 1, retries: 0, timeout: 0 });
  doc = updateNodeConfig(doc, "rd", { concurrency: 100_000, getLatency: 0.5, hitRatio: over?.hitRatio ?? 0.9 });
  doc = updateNodeConfig(doc, "pg", { maxConnections: 100_000, serviceTime: 2 });
  return doc;
}

function counters(doc: SystemDoc, horizonMs = 30_000) {
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
  const at = (id: string) => c.stations[scenario.stations.findIndex((s) => s.id === id)];
  return { roots: at("cl").arrivals, redis: at("rd"), pg: at("pg") };
}

describe("cache hit/miss law", () => {
  it("measured hit rate ≈ h and DB load ≈ (1−h)·λ", () => {
    const h = 0.85;
    const { redis, pg } = counters(routingDoc({ hitRatio: h }));
    const reads = redis.arrivals; // all reads consult the cache
    const measuredHit = redis.hits / (redis.hits + redis.misses);
    expect(measuredHit).toBeCloseTo(h, 1); // within ~0.05
    expect(pg.arrivals / reads).toBeCloseTo(1 - h, 1); // misses fall through to the DB
  });

  it("killing the cache drives everything to the DB (h → 0)", () => {
    let doc = routingDoc({ hitRatio: 0.9 });
    doc = { ...doc, interventions: [{ id: "k", atLogicalTime: 0, kind: "kill", target: "rd" }] };
    const { roots, pg } = counters(doc);
    expect(pg.arrivals / roots).toBeGreaterThan(0.98); // 100% of reads reach the DB
  });

  it("a perfect cache hides the DB entirely", () => {
    const { pg } = counters(routingDoc({ hitRatio: 1 }));
    expect(pg.arrivals).toBe(0);
  });
});

describe("request-type routing", () => {
  it("writes bypass the cache to the DB; reads use the cache", () => {
    // Perfect cache so a read never reaches the DB, then every DB call is a write.
    const { roots, redis, pg } = counters(routingDoc({ hitRatio: 1, writeRatio: 0.3 }));
    expect(redis.arrivals / roots).toBeCloseTo(0.7, 1); // only reads consult the cache
    expect(redis.misses).toBe(0);
    expect(pg.arrivals / roots).toBeCloseTo(0.3, 1); // only writes reach the DB
  });
});

describe("determinism holds with hit/miss + write rolls", () => {
  it("same seed → byte-identical run", () => {
    const doc = routingDoc({ hitRatio: 0.85, writeRatio: 0.25 });
    const run = () => new MainThreadHost().run(compileScenario(doc), { horizonMs: 10_000 });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
