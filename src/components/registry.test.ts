import { describe, expect, it } from "vitest";
import { addNode, createDocument } from "@/document";
import {
  CHANNEL,
  defaultChannelConfig,
  defaultConfig,
  getComponent,
  listComponents,
} from "./registry";
import { compileScenario } from "./compile";

const DEMO_TYPES = ["client", "load-balancer", "api", "redis", "postgres"];

const SERVICE_KEYS = ["serviceTime", "getLatency", "thinkTime", "consumeTime"];
const SERVER_KEYS = ["concurrency", "maxConnections", "consumers"];

describe("component registry", () => {
  it("ships the components needed to build the demo", () => {
    const types = listComponents().map((c) => c.type);
    for (const t of DEMO_TYPES) expect(types).toContain(t);
  });

  it("every component and property carries its semantics (tooltips are core)", () => {
    for (const c of listComponents()) {
      expect(c.what).toBeTruthy();
      expect(c.effect).toBeTruthy();
      for (const p of c.properties) {
        expect(p.what, `${c.type}.${p.key} what`).toBeTruthy();
        expect(p.effect, `${c.type}.${p.key} effect`).toBeTruthy();
      }
    }
    for (const p of CHANNEL.properties) {
      expect(p.what).toBeTruthy();
      expect(p.effect).toBeTruthy();
    }
  });

  it("ships an expanded library across the families", () => {
    const types = listComponents().map((c) => c.type);
    for (const t of ["mysql", "mongodb", "cassandra", "elasticsearch", "memcached", "s3", "dns", "cdn", "api-gateway", "worker", "lambda"]) {
      expect(types, t).toContain(t);
    }
    expect(types.length).toBeGreaterThanOrEqual(15);
  });

  it("covers the shippable-now breadth: browser, cron, router, switch, cloudfront, queue", () => {
    const types = listComponents().map((c) => c.type);
    for (const t of ["browser", "cron", "router", "switch", "cloudfront", "queue"]) {
      expect(types, t).toContain(t);
    }
    // The new sources are flagged sources; the forwarder/cache/broker profiles reuse
    // their existing laws (short-circuit cache, buffered broker).
    for (const t of ["client", "browser", "cron"]) expect(getComponent(t)?.source).toBe(true);
    expect(getComponent("cloudfront")?.cache).toBe(true);
    expect(getComponent("queue")?.broker).toBe(true);
    // Router/Switch are honest pass-through forwarders, no bespoke law.
    expect(getComponent("router")?.category).toBe("Networking");
  });

  it("every component is a real queue profile: a service knob (sources aside) plus servers", () => {
    for (const c of listComponents()) {
      const keys = Object.keys(defaultConfig(c.type));
      expect(keys.some((k) => SERVICE_KEYS.includes(k)), `${c.type} service knob`).toBe(true);
      if (!c.source) {
        expect(keys.some((k) => SERVER_KEYS.includes(k)), `${c.type} servers knob`).toBe(true);
      }
    }
  });

  it("no shown knob is silently inert: caches short-circuit, service knobs reach compile", () => {
    for (const c of listComponents()) {
      if (c.source) continue;
      const cfg = defaultConfig(c.type);
      const serviceKey = SERVICE_KEYS.find((k) => k in cfg)!;
      const serviceMs = cfg[serviceKey] as number;
      let doc = createDocument({ id: `t-${c.type}`, name: c.type, seed: 1 });
      doc = addNode(doc, c.type, { x: 0, y: 0 }, "n");
      const station = compileScenario(doc).stations[0];
      const expected = 1 / Math.max(0.001, serviceMs);
      expect(station.serviceRatePerMs, `${c.type} wires ${serviceKey}`).toBeCloseTo(expected, 6);
    }
    expect(getComponent("memcached")?.cache).toBe(true);
    expect(getComponent("cdn")?.cache).toBe(true);
  });

  it("pending knobs are tagged, not hidden", () => {
    expect(getComponent("lambda")!.properties.find((p) => p.key === "coldStartMs")?.pending).toBe(true);
    // Postgres read replicas are now wired (capacity), not pending.
    expect(getComponent("postgres")!.properties.find((p) => p.key === "replicas")?.pending).toBeFalsy();
    // Redis memory/eviction are now wired (they derive the hit ratio), not pending.
    const redis = getComponent("redis")!;
    expect(redis.properties.find((p) => p.key === "evictionPolicy")?.pending).toBeFalsy();
    expect(redis.properties.find((p) => p.key === "maxMemoryMB")?.pending).toBeFalsy();
    expect(redis.properties.find((p) => p.key === "workingSetMB")).toBeTruthy();
  });

  it("sharding and quorum knobs are wired (not pending), gated behind their mode", () => {
    // Elasticsearch shards drive real fan-out now, not a pending tag.
    const shards = getComponent("elasticsearch")!.properties.find((p) => p.key === "shards");
    expect(shards?.pending).toBeFalsy();
    expect(shards?.default).toBe(1); // 1 = single node (byte-identical) until raised
    // Cassandra quorum replication: replicationFactor + W/R are wired, hidden behind
    // the toggle (not inert), and the toggle defaults off (byte-identical).
    const cas = getComponent("cassandra")!.properties;
    expect(cas.find((p) => p.key === "quorumReplication")?.default).toBe(false);
    for (const key of ["nodes", "replicationFactor", "writeQuorum", "readQuorum"]) {
      const p = cas.find((x) => x.key === key);
      expect(p?.pending, `${key} not pending`).toBeFalsy();
      expect(p?.showIf, `${key} gated`).toEqual({ key: "quorumReplication", equals: true });
    }
  });

  it("autoscale knobs ship on the compute tiers, gated behind the switch", () => {
    for (const type of ["api", "worker"]) {
      const props = getComponent(type)!.properties;
      const auto = props.find((p) => p.key === "autoscale");
      expect(auto, `${type} autoscale`).toBeDefined();
      expect(auto!.default).toBe(false);
      // Every scaling knob is hidden until the mode is on: gated, not inert.
      for (const key of ["scaleMetric", "minInstances", "maxInstances", "provisionMs"]) {
        expect(props.find((p) => p.key === key)?.showIf, `${type}.${key}`).toEqual({ key: "autoscale", equals: true });
      }
      expect(props.find((p) => p.key === "targetUtilization")?.showIf).toEqual({ key: "scaleMetric", equals: "utilization" });
      expect(props.find((p) => p.key === "targetRps")?.showIf).toEqual({ key: "scaleMetric", equals: "request-rate" });
    }
  });

  it("postgres replicas are read replicas with a lag knob gated behind them", () => {
    const pg = getComponent("postgres")!;
    expect(pg.readReplicas).toBe(true);
    const lag = pg.properties.find((p) => p.key === "replicationLagMs");
    expect(lag?.showIf).toEqual({ key: "replicas", min: 1 });
    expect(lag?.pending).toBeFalsy(); // wired, not inert
  });

  it("select properties enumerate options that include their default", () => {
    for (const c of listComponents()) {
      for (const p of c.properties) {
        if (p.kind === "select") {
          expect(p.options, `${c.type}.${p.key}`).toBeDefined();
          expect(p.options).toContain(p.default);
        }
      }
    }
  });

  it("defaultConfig derives one entry per property", () => {
    const api = getComponent("api")!;
    const cfg = defaultConfig("api");
    expect(Object.keys(cfg).sort()).toEqual(api.properties.map((p) => p.key).sort());
    expect(cfg.concurrency).toBe(200);
  });

  it("unknown types yield an empty config, not a throw", () => {
    expect(defaultConfig("nope")).toEqual({});
  });

  it("defaultChannelConfig has latency + jitter + bandwidth", () => {
    expect(defaultChannelConfig()).toEqual({ latency: 1, jitter: 0, bandwidth: 1000 });
  });
});
