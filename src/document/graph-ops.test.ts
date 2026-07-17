import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DexieSystemRepository } from "./dexie-repository";
import {
  addEdge,
  addIntervention,
  addNode,
  moveNode,
  removeEdge,
  removeIntervention,
  removeNode,
  updateNodeConfig,
} from "./graph-ops";
import { createDocument, touch } from "./index";

// Build Client → Load Balancer → API → Redis → Postgres by hand.
const DEMO = [
  ["client", "n-client"],
  ["load-balancer", "n-lb"],
  ["api", "n-api"],
  ["redis", "n-redis"],
  ["postgres", "n-pg"],
] as const;

function buildDemo() {
  let doc = createDocument({ id: "sys-demo", name: "Demo", seed: 1 });
  DEMO.forEach(([type, id], i) => {
    doc = addNode(doc, type, { x: i * 180, y: 0 }, id);
  });
  for (let i = 0; i < DEMO.length - 1; i++) {
    doc = addEdge(doc, DEMO[i][1], DEMO[i + 1][1], `e${i}`);
  }
  return doc;
}

describe("graph-ops: hand-building the demo", () => {
  it("produces the 5-node, 4-edge pipeline", () => {
    const doc = buildDemo();
    expect(doc.graph.nodes.map((n) => n.type)).toEqual([
      "client",
      "load-balancer",
      "api",
      "redis",
      "postgres",
    ]);
    expect(doc.graph.edges).toHaveLength(4);
    expect(doc.graph.edges.map((e) => [e.source, e.target])).toEqual([
      ["n-client", "n-lb"],
      ["n-lb", "n-api"],
      ["n-api", "n-redis"],
      ["n-redis", "n-pg"],
    ]);
  });

  it("seeds each node with its component defaults", () => {
    const doc = buildDemo();
    const api = doc.graph.nodes.find((n) => n.id === "n-api")!;
    expect(api.config.concurrency).toBe(200);
    const pg = doc.graph.nodes.find((n) => n.id === "n-pg")!;
    expect(pg.config.maxConnections).toBe(100);
  });

  it("seeds each edge with default channel config", () => {
    const doc = buildDemo();
    expect(doc.graph.edges[0].config).toEqual({ latency: 1, jitter: 0, bandwidth: 1000 });
  });

  it("persists chosen connection handles when given", () => {
    let doc = buildDemo();
    doc = addEdge(doc, "n-pg", "n-client", "e-back", {
      sourceHandle: "s-r",
      targetHandle: "t-l",
    });
    const edge = doc.graph.edges.find((e) => e.id === "e-back")!;
    expect(edge.sourceHandle).toBe("s-r");
    expect(edge.targetHandle).toBe("t-l");
    // Edges added without handles stay clean (no keys), so old files round-trip.
    expect(doc.graph.edges[0].sourceHandle).toBeUndefined();
    expect("sourceHandle" in doc.graph.edges[0]).toBe(false);
  });

  it("ignores self-loops and duplicate edges", () => {
    let doc = buildDemo();
    const before = doc.graph.edges.length;
    doc = addEdge(doc, "n-api", "n-api"); // self-loop
    doc = addEdge(doc, "n-client", "n-lb"); // duplicate
    expect(doc.graph.edges).toHaveLength(before);
  });

  it("removing a node drops its dangling edges", () => {
    let doc = buildDemo();
    doc = removeNode(doc, "n-api");
    expect(doc.graph.nodes.find((n) => n.id === "n-api")).toBeUndefined();
    // edges lb→api and api→redis are gone; client→lb and redis→pg remain
    expect(doc.graph.edges.map((e) => e.id).sort()).toEqual(["e0", "e3"]);
  });

  it("adds interventions sorted by time and removes them by id", () => {
    let doc = buildDemo();
    doc = addIntervention(doc, { atLogicalTime: 5000, kind: "kill", target: "n-redis", id: "iv2" });
    doc = addIntervention(doc, { atLogicalTime: 1000, kind: "delay", target: "n-pg", param: 300, id: "iv1" });
    expect(doc.interventions.map((i) => i.id)).toEqual(["iv1", "iv2"]); // sorted by time
    expect(doc.interventions[1].param).toBeUndefined();
    doc = removeIntervention(doc, "iv1");
    expect(doc.interventions.map((i) => i.id)).toEqual(["iv2"]);
  });

  it("preserves a shard-scoped intervention's cell index (per-cell failure injection)", () => {
    let doc = buildDemo();
    doc = addIntervention(doc, { atLogicalTime: 4000, kind: "kill", target: "n-pg", shard: 2, id: "ivs" });
    expect(doc.interventions.find((i) => i.id === "ivs")?.shard).toBe(2);
  });

  it("removeEdge and moveNode are surgical and immutable", () => {
    const doc = buildDemo();
    const moved = moveNode(doc, "n-api", { x: 5, y: 9 });
    expect(moved).not.toBe(doc); // new object
    expect(doc.graph.nodes.find((n) => n.id === "n-api")!.position).toEqual({ x: 360, y: 0 });
    expect(moved.graph.nodes.find((n) => n.id === "n-api")!.position).toEqual({ x: 5, y: 9 });
    expect(removeEdge(doc, "e0").graph.edges).toHaveLength(3);
  });
});

describe("edit-a-default → save → reload is intact", () => {
  let repo: DexieSystemRepository;
  beforeEach(() => {
    repo = new DexieSystemRepository(`p3-${Math.random()}`);
  });
  afterEach(async () => {
    await repo.destroy();
  });

  it("persists an edited default on every node across a reload", async () => {
    let doc = buildDemo();
    // Edit at least one default on every node.
    doc = updateNodeConfig(doc, "n-client", { requestRate: 5000 });
    doc = updateNodeConfig(doc, "n-lb", { algorithm: "least-connections" });
    doc = updateNodeConfig(doc, "n-api", { concurrency: 32 });
    doc = updateNodeConfig(doc, "n-redis", { maxMemoryMB: 4096 });
    doc = updateNodeConfig(doc, "n-pg", { maxConnections: 20 });

    await repo.save(touch(doc));

    // Simulate "reload the app": a brand-new repository over the same IndexedDB.
    const reloaded = await repo.load("sys-demo");
    expect(reloaded.graph.nodes).toHaveLength(5);
    expect(reloaded.graph.edges).toHaveLength(4);
    const cfg = (id: string) => reloaded.graph.nodes.find((n) => n.id === id)!.config;
    expect(cfg("n-client").requestRate).toBe(5000);
    expect(cfg("n-lb").algorithm).toBe("least-connections");
    expect(cfg("n-api").concurrency).toBe(32);
    expect(cfg("n-redis").maxMemoryMB).toBe(4096);
    expect(cfg("n-pg").maxConnections).toBe(20);
  });

  it("lists the saved system", async () => {
    await repo.save(touch(buildDemo()));
    const list = await repo.list();
    expect(list.map((m) => m.name)).toContain("Demo");
  });
});
