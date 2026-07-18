// Pure, engine-free cost estimation over a run (TCO-style). Each component maps
// to a representative AWS on-demand price profile; fixed infra bills by instance
// count, usage bills at the request rate measured over the run window, then both
// extrapolate to hour / day / month / year as if the window were steady state.
import { defaultConfig, getComponent } from "./registry";
import type { RunResult } from "@/engine";
import type { SystemDoc } from "@/schema";

export const HOURS_PER_DAY = 24;
/** AWS's billing convention: 730 h/month, 8760 h/year. */
export const HOURS_PER_MONTH = 730;
export const HOURS_PER_YEAR = 8760;

/** Lambda compute, $ per GB-second (1 GB memory assumed). */
const LAMBDA_GBS = 0.0000166667;

interface PriceProfile {
  basis: string; // what the estimate stands on, shown in the breakdown
  hourly?: number; // $ per billed shape-hour
  perMReq?: number; // $ per million requests handled
  gbSeconds?: boolean; // also bill measured compute time at the Lambda GB-s rate
  /** Capacity knob -> billed shape count: one shape per `perUnit` of `key`, so a
   * concurrency-400 API bills two m5.large, not one. Defaults map to one shape. */
  sizing?: { key: string; perUnit: number };
  apiCallsPerMsg?: number; // per-message API-call multiplier (SQS: send+receive+delete)
  egressPerGB?: number; // $ / GB served, sized by the node's avgObjectKB knob
  storagePerGBMonth?: number; // $ / GB-month, reads the node's storageGB knob
}

// Representative on-demand us-east-1 rates, rounded. Traffic sources (client /
// browser / cron) are the users, not billed infra, so they carry no profile.
const PRICING: Record<string, PriceProfile> = {
  api: {
    basis: "EC2 m5.large per 200 threads",
    hourly: 0.096,
    sizing: { key: "concurrency", perUnit: 200 },
  },
  worker: {
    basis: "EC2 m5.large per 50 workers",
    hourly: 0.096,
    sizing: { key: "concurrency", perUnit: 50 },
  },
  lambda: { basis: "Lambda, 1 GB memory", perMReq: 0.2, gbSeconds: true },
  "load-balancer": {
    basis: "ALB + LCUs (approx)",
    hourly: 0.0225,
    perMReq: 0.1,
  },
  "api-gateway": { basis: "API Gateway (HTTP API)", perMReq: 1.0 },
  "reverse-proxy": {
    basis: "EC2 m5.large (self-run)",
    hourly: 0.096,
    sizing: { key: "maxConnections", perUnit: 10000 },
  },
  ingress: { basis: "ALB + LCUs (approx)", hourly: 0.0225, perMReq: 0.1 },
  firewall: { basis: "Network Firewall endpoint", hourly: 0.395 },
  router: { basis: "VPC routing (no direct charge)", hourly: 0 },
  switch: { basis: "VPC networking (no direct charge)", hourly: 0 },
  dns: { basis: "Route 53 queries", perMReq: 0.4 },
  cdn: {
    basis: "CDN requests + egress at avg object size",
    perMReq: 0.75,
    egressPerGB: 0.085,
  },
  cloudfront: {
    basis: "CloudFront requests + egress at avg object size",
    perMReq: 0.75,
    egressPerGB: 0.085,
  },
  redis: {
    basis: "ElastiCache cache.m5.large per 16 IO threads",
    hourly: 0.156,
    sizing: { key: "concurrency", perUnit: 16 },
  },
  memcached: {
    basis: "ElastiCache cache.m5.large per 16 IO threads",
    hourly: 0.156,
    sizing: { key: "concurrency", perUnit: 16 },
  },
  postgres: {
    basis: "RDS db.m5.large per 100 connections + storage",
    hourly: 0.178,
    sizing: { key: "maxConnections", perUnit: 100 },
    storagePerGBMonth: 0.115,
  },
  mysql: {
    basis: "RDS db.m5.large per 100 connections + storage",
    hourly: 0.171,
    sizing: { key: "maxConnections", perUnit: 100 },
    storagePerGBMonth: 0.115,
  },
  mongodb: {
    basis: "DocumentDB db.r5.large per 100 connections + storage",
    hourly: 0.277,
    sizing: { key: "maxConnections", perUnit: 100 },
    storagePerGBMonth: 0.1,
  },
  cassandra: {
    basis: "EC2 i3.large per node, per 100 connections",
    hourly: 0.156,
    sizing: { key: "maxConnections", perUnit: 100 },
  },
  elasticsearch: {
    basis: "OpenSearch m5.large.search per shard, per 100 connections",
    hourly: 0.142,
    sizing: { key: "maxConnections", perUnit: 100 },
  },
  s3: {
    basis: "S3 requests + egress + storage",
    perMReq: 0.4,
    egressPerGB: 0.09,
    storagePerGBMonth: 0.023,
  },
  kafka: {
    basis: "MSK kafka.m5.large per 8 consumers",
    hourly: 0.21,
    sizing: { key: "consumers", perUnit: 8 },
  },
  rabbitmq: {
    basis: "Amazon MQ mq.m5.large per 4 consumers",
    hourly: 0.288,
    sizing: { key: "consumers", perUnit: 4 },
  },
  nats: {
    basis: "EC2 m5.large (self-run) per 6 consumers",
    hourly: 0.096,
    sizing: { key: "consumers", perUnit: 6 },
  },
  sqs: {
    basis: "SQS, 3 API calls per message",
    perMReq: 0.4,
    apiCallsPerMsg: 3,
  },
  queue: {
    basis: "SQS-style, 3 API calls per message",
    perMReq: 0.4,
    apiCallsPerMsg: 3,
  },
};

export interface NodeCost {
  id: string;
  type: string;
  basis: string;
  instances: number; // billed shapes: fleet (replicas/shards/autoscale) × capacity sizing
  reqPerSec: number; // mean arrival rate measured over the run
  infraHourly: number; // $ / h: shapes × hourly rate + storage
  usageHourly: number; // $ / h: request, egress, and compute charges at the measured rate
  hourly: number;
}

export interface CostEstimate {
  nodes: NodeCost[]; // billed nodes, costliest first
  hourly: number;
  measuredMs: number; // the run window the usage was measured over
  /** Sources whose traffic pattern isn't constant ("Client (burst)"). The
   * extrapolation bills the measured window on repeat, so a burst or ramp run
   * prices the stress you designed, not a typical month. */
  nonSteady: string[];
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

// The fleet a node stands for: measured mean instances when autoscaling (the run
// decides), else the peer/shard/replica knobs.
function fleetCount(
  cfg: Record<string, unknown>,
  meanInstances: number | undefined,
): number {
  if (cfg.autoscale === true)
    return meanInstances ?? Math.max(1, num(cfg.minInstances, 1));
  if (cfg.quorumReplication === true) return Math.max(1, num(cfg.nodes, 1));
  if (num(cfg.shards, 1) > 1) return num(cfg.shards, 1);
  return 1 + Math.max(0, num(cfg.replicas, 0));
}

/** Estimate the run's steady-state cost. `doc` must be the document the run was
 * compiled from, so configs match the measured usage. */
export function estimateCost(doc: SystemDoc, result: RunResult): CostEstimate {
  // Per-station means over the sample windows: arrival rate and (when
  // autoscaling) live instance count.
  const rate = new Map<string, number>();
  const fleet = new Map<string, number>();
  result.stationIds.forEach((id, k) => {
    let calls = 0;
    let inst = 0;
    let instN = 0;
    for (const w of result.windows) {
      const st = w.stations[k];
      if (Number.isFinite(st.calls)) calls += st.calls;
      if (Number.isFinite(st.instances)) {
        inst += st.instances;
        instN++;
      }
    }
    rate.set(id, result.windows.length > 0 ? calls / result.windows.length : 0);
    if (instN > 0) fleet.set(id, inst / instN);
  });

  const nodes: NodeCost[] = [];
  const nonSteady: string[] = [];
  for (const n of doc.graph.nodes) {
    const cfg = { ...defaultConfig(n.type), ...n.config };
    const def = getComponent(n.type);
    if (def?.source) {
      // Burst and ramp windows never extrapolate fairly; a periodic swing does
      // once the run covers at least one full cycle (its mean is representative).
      const pattern =
        typeof cfg.pattern === "string" ? cfg.pattern : "constant";
      const distorts =
        pattern === "burst" ||
        pattern === "ramp" ||
        (pattern === "periodic" && num(cfg.periodMs, 5000) > result.horizonMs);
      if (distorts) nonSteady.push(`${def.label} (${pattern})`);
      continue;
    }
    const price = PRICING[n.type];
    if (!price) continue;

    const units = price.sizing
      ? Math.max(
          1,
          Math.ceil(
            num(cfg[price.sizing.key], price.sizing.perUnit) /
              price.sizing.perUnit,
          ),
        )
      : 1;
    const instances = fleetCount(cfg, fleet.get(n.id)) * units;
    const reqPerSec = rate.get(n.id) ?? 0;

    let infraHourly = (price.hourly ?? 0) * instances;
    if (price.storagePerGBMonth)
      infraHourly +=
        (num(cfg.storageGB) * price.storagePerGBMonth) / HOURS_PER_MONTH;

    let usageHourly =
      ((reqPerSec * (price.apiCallsPerMsg ?? 1) * 3600) / 1e6) *
      (price.perMReq ?? 0);
    if (price.gbSeconds)
      usageHourly +=
        reqPerSec * 3600 * (num(cfg.serviceTime, 30) / 1000) * LAMBDA_GBS;
    // KB/req × req/s × 3600 = KB/h; /1e6 -> GB/h.
    if (price.egressPerGB !== undefined)
      usageHourly +=
        ((reqPerSec * num(cfg.avgObjectKB) * 3600) / 1e6) *
        num(cfg.egressRatePerGB, price.egressPerGB);

    nodes.push({
      id: n.id,
      type: n.type,
      basis: price.basis,
      instances,
      reqPerSec,
      infraHourly,
      usageHourly,
      hourly: infraHourly + usageHourly,
    });
  }
  nodes.sort((a, b) => b.hourly - a.hourly);

  return {
    nodes,
    hourly: nodes.reduce((a, c) => a + c.hourly, 0),
    measuredMs: result.horizonMs,
    nonSteady,
  };
}

export const fmtUSD = (x: number): string => {
  if (x === 0) return "$0";
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 100) return `$${Math.round(x).toLocaleString("en-US")}`;
  if (x >= 0.01) return `$${x.toFixed(2)}`;
  return `$${x.toFixed(4)}`;
};
