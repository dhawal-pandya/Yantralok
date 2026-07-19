import { describe, expect, it } from "vitest";
import { compileScenario } from "@/components";
import { MainThreadHost } from "@/engine";
import { importDocument } from "@/document";
import { COMPANIES, LESSONS, SCENARIOS, SCENARIO_NOTES, SHOWCASES } from "./index";

const run = (raw: string) => {
  const doc = importDocument(raw);
  const result = new MainThreadHost().run(compileScenario(doc), { horizonMs: 10_000 });
  return { doc, result };
};

describe("shipped scenarios", () => {
  it("ships at least three demos with stable ids matching their documents", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(3);
    for (const s of SCENARIOS) {
      expect(importDocument(s.raw).id).toBe(s.id);
      expect(s.title.length).toBeGreaterThan(0);
    }
  });

  it("every system has referable guide notes (watch / test / stress)", () => {
    for (const s of SCENARIOS) {
      const notes = SCENARIO_NOTES[s.id];
      expect(notes, `${s.title} needs guide notes`).toBeDefined();
      expect(notes.watch.length).toBeGreaterThan(0);
      expect(notes.test.length).toBeGreaterThan(0);
      expect(notes.stress.length).toBeGreaterThan(0);
    }
  });

  it("is three shelves: lessons 1..11, ~11 companies, then showcases last", () => {
    expect(SHOWCASES.length).toBeGreaterThanOrEqual(6);
    for (const s of SHOWCASES) expect(s.lesson).toBeUndefined();
    // Showcases sit LAST now, after every company.
    const firstShowcaseIdx = SCENARIOS.findIndex((s) => s.kind === "showcase");
    const lastCompanyIdx = SCENARIOS.map((s) => s.kind).lastIndexOf("company");
    expect(firstShowcaseIdx).toBeGreaterThanOrEqual(0);
    expect(firstShowcaseIdx).toBeGreaterThan(lastCompanyIdx);

    expect(LESSONS.map((s) => s.lesson)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const s of LESSONS) expect(s.title).toMatch(/^Lesson \d+: /);
    expect(COMPANIES.length).toBeGreaterThanOrEqual(10);
    for (const s of COMPANIES) expect(s.lesson).toBeUndefined();
    expect(SHOWCASES.length + LESSONS.length + COMPANIES.length).toBe(SCENARIOS.length);
  });

  it("each loads and runs: and every COMPANY scenario ships green (zero failures)", () => {
    for (const s of SCENARIOS) {
      const { result } = run(s.raw);
      // Every shelf must at least keep serving requests (showcases are allowed to
      // degrade under stress, but never to stop completing).
      expect(result.totals.completions, `${s.title} must keep serving`).toBeGreaterThan(0);
      // Policy: companies always deliver their stated scale; breaking things is
      // the Lessons' and Showcases' job (or one click of Failure injection away).
      if (s.kind === "company") {
        expect(result.totals.failures, `${s.title} must ship green`).toBe(0);
      }
    }
  });

  it("each demonstrates its distinct behavior", () => {
    const byId = (id: string) => run(SCENARIOS.find((s) => s.id === id)!.raw);

    // Cache shield: idle Postgres until the kill, then it saturates and requests fail.
    const cache = byId("scn-cache-shield-0000-000000000002").result;
    expect(cache.totals.failures).toBeGreaterThan(0);

    // Retry storm: amplification alone (no kill) drives failures.
    expect(byId("scn-retry-storm-0000-000000000003").result.totals.failures).toBeGreaterThan(0);

    // Flash crowd: the spike hurts first (shed load on one instance), the fleet
    // grows, failures stop, and the bottleneck moves to the next tier.
    const auto = byId("scn-autoscale-flash-00000032").result;
    const api = (i: number) => auto.windows[i].stations.find((s) => s.id === "api")!;
    expect(api(5).instances).toBe(1); // t≈600ms: still one instance, ρ pegged
    expect(auto.windows[5].bottleneck).toBe("api");
    expect(auto.totals.failures).toBeGreaterThan(0); // overflow while undersized
    const last = auto.windows.length - 1;
    expect(api(last).instances).toBeGreaterThanOrEqual(4); // fleet grew to demand
    for (const w of auto.windows.slice(-20)) expect(w.failureRate).toBe(0); // healthy
    expect(auto.windows[last].bottleneck).toBe("postgres"); // the next wall

    // Netflix: the CDN dies at 4s → the pre-provisioned ×5 fleet absorbs the
    // 20× flood outright: ρ jumps an order of magnitude, nothing fails, and
    // (thanks to EVCache) the fleet never even needs to grow.
    const nf = byId("scn-netflix-0000-0000-000000000010").result;
    const nfApi = (i: number) => nf.windows[i].stations.find((s) => s.id === "api")!;
    expect(nfApi(30).instances).toBe(5); // floored at the headroom min throughout
    expect(nfApi(nf.windows.length - 1).instances).toBe(5);
    expect(nfApi(30).utilization).toBeLessThan(0.1); // pre-kill: origin nearly idle
    expect(nfApi(nf.windows.length - 1).utilization).toBeGreaterThan(0.25); // absorbed

    // Reddit: the memcached shield keeps the Postgres pool comfortable at scale.
    const rd = byId("scn-reddit-sub-00000000000023").result;
    for (const w of rd.windows.slice(-10)) {
      expect(w.stations.find((s) => s.id === "postgres")!.utilization).toBeLessThan(0.6);
    }

    // IRCTC Tatkal: the waiting room converts the 10 AM burst into WAIT TIME:
    // many seconds of latency, zero failures (companies-green test covers the zero).
    const tm = byId("scn-irctc-tatkal-00000050").result;
    const tmMaxLatency = tm.windows.reduce(
      (a, w) => (Number.isFinite(w.meanLatency) ? Math.max(a, w.meanLatency) : a),
      0,
    );
    expect(tmMaxLatency).toBeGreaterThan(1000); // the queue IS the product

    // X: MySQL read replicas serve reads with a 10ms lag → a measurable stale rate.
    const x = byId("scn-x-timeline-0000-000000000011").result;
    const staleTail = x.windows
      .slice(-20)
      .map((w) => w.stations.find((s) => s.id === "mysql")!.staleRate)
      .filter(Number.isFinite);
    expect(staleTail.length).toBeGreaterThan(0);
    const meanStale = staleTail.reduce((a, b) => a + b, 0) / staleTail.length;
    expect(meanStale).toBeGreaterThan(0.1); // replica reads land inside the lag window
    expect(meanStale).toBeLessThan(0.6);
  });

  it("the showcases and new lessons show their combined-law behavior", () => {
    const byId = (id: string) => run(SCENARIOS.find((s) => s.id === id)!.raw);
    const max = (xs: number[]) => Math.max(...xs);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    // Kafka showcase: a burst produces past consume capacity, so the consumer lag
    // (backlog) climbs, then the consumers drain it back down once the burst passes.
    const kafka = byId("scn-showcase-kafka-00000041").result;
    const backlog = kafka.windows.map((w) => w.stations.find((s) => s.id === "kafka")!.backlog);
    expect(max(backlog)).toBeGreaterThan(150); // the burst builds a real backlog
    expect(backlog[backlog.length - 1]).toBeLessThan(max(backlog) * 0.4); // then drains

    // Shared DB: Orders' burst fills the shared Postgres pool, so its queue (which
    // Inventory also waits in) goes from ~empty to hundreds deep, then recovers.
    const shared = byId("scn-showcase-shared-db-000040").result;
    const pgQueue = shared.windows.map((w) => w.stations.find((s) => s.id === "postgres")!.queue);
    expect(max(pgQueue.slice(0, 20))).toBeLessThan(5); // baseline: the pool is quiet
    expect(max(pgQueue.slice(30, 60))).toBeGreaterThan(50); // burst: the shared pool starves
    expect(shared.windows[shared.windows.length - 1].throughput).toBeGreaterThan(0); // still serving

    // Cascade & Rewind: killing Redis causes a real cascade (failures), then the
    // system recovers once Redis heals, still serving at the end.
    const cascade = byId("scn-showcase-cascade-0000042").result;
    expect(cascade.totals.failures).toBeGreaterThan(0); // the cache death cascades
    const crTail = cascade.windows.slice(-10);
    expect(mean(crTail.map((w) => w.throughput))).toBeGreaterThan(300); // recovered on heal
    expect(mean(crTail.map((w) => w.failureRate))).toBeLessThan(50); // and mostly succeeding

    // Lesson 8 vs Lesson 2: the same retry storm, but the breaker rests the DB so
    // throughput recovers in bursts, where Lesson 2 stays pinned at zero.
    const lateThru = (r: { windows: { throughput: number }[] }) =>
      max(r.windows.slice(-40).map((w) => w.throughput));
    const storm = byId("scn-retry-storm-0000-000000000003").result;
    const breaker = byId("scn-lesson-breaker-000000000043").result;
    expect(lateThru(storm)).toBeLessThan(50); // Lesson 2 collapsed for good
    expect(lateThru(breaker)).toBeGreaterThan(150); // Lesson 8 recovers
    expect(breaker.totals.failures).toBeLessThan(storm.totals.failures); // and fails less overall

    // Lesson 9: producer decoupled from consumer; the lag climbs while the
    // producer's own latency stays at the link cost.
    const async = byId("scn-lesson-async-000000000044").result;
    const asyncBacklog = async.windows.map((w) => w.stations.find((s) => s.id === "kafka")!.backlog);
    expect(asyncBacklog[asyncBacklog.length - 1]).toBeGreaterThan(asyncBacklog[10] + 100); // lag grows
    expect(mean(async.windows.slice(-10).map((w) => w.meanLatency))).toBeLessThan(20); // producer stays fast

    // Lesson 10 (sharding): green until the shard is killed at 5s, then only that
    // cell's ~1/4 slice fails while the store keeps serving the rest.
    const shard = byId("scn-lesson-sharding-000000045").result;
    const wps = 1000 / shard.windows[0].windowMs;
    const early = shard.windows.slice(0, Math.floor(4 * wps)); // first ~4s, pre-kill
    const post = shard.windows.slice(Math.floor(6 * wps)); // after the 5s kill settles
    expect(mean(early.map((w) => w.failureRate))).toBeLessThan(5); // healthy before the kill
    expect(mean(post.map((w) => w.failureRate))).toBeGreaterThan(50); // the dead shard's slice fails
    expect(mean(post.map((w) => w.throughput))).toBeGreaterThan(300); // other shards keep serving

    // Lesson 11 (quorum): a weak quorum (W=1,R=1,RF=3) reads ~2/3 stale.
    const quorum = byId("scn-lesson-quorum-0000000046").result;
    const staleQ = quorum.windows
      .slice(-30)
      .map((w) => w.stations.find((s) => s.id === "cassandra")!.staleRate)
      .filter(Number.isFinite);
    expect(staleQ.length).toBeGreaterThan(0);
    const meanStaleQ = staleQ.reduce((a, b) => a + b, 0) / staleQ.length;
    expect(meanStaleQ).toBeGreaterThan(0.5); // weak quorum: measurably stale
    expect(meanStaleQ).toBeLessThan(0.8);

    // Frankenstein: nearly the whole catalog in one over-provisioned system that
    // still runs green under sustained load ("spared no expense").
    const frank = run(SCENARIOS.find((s) => s.id === "scn-showcase-frankenstein-051")!.raw);
    const frankTypes = new Set(frank.doc.graph.nodes.map((n) => n.type));
    expect(frankTypes.size).toBeGreaterThanOrEqual(27); // ~the entire component catalog
    expect(frank.result.totals.completions).toBeGreaterThan(500); // real throughput
    expect(frank.result.totals.failures).toBe(0); // over-built: nothing fails
  });
});
