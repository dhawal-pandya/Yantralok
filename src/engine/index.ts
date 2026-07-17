// Pure deterministic engine. Public surface.
import { SCHEMA_VERSION } from "@/schema";

export const ENGINE_VERSION = `0.0.0+schema${SCHEMA_VERSION}`;

export { createPrng, type Prng } from "./prng";
export { MinHeap } from "./heap";
export {
  Simulation,
  type SimEvent,
  type SimContext,
  type EventHandler,
  type Snapshot,
} from "./simulation";
export {
  initialQueueState,
  seedArrivals,
  queueHandler,
  readQueueCounters,
  computeQueueMetrics,
  type QueueParams,
  type QueueState,
  type QueueMetrics,
  type QueueCounters,
} from "./models/single-server-queue";
export {
  createNetwork,
  readNetworkCounters,
  computeWindowMetrics,
  type NetworkState,
  type NetworkCounters,
  type WindowMetrics,
  type StationMetric,
} from "./models/network";
export {
  MainThreadHost,
  type SimulationHost,
  type RunResult,
  type RunOptions,
  type Segment,
  type TraceSpan,
  type LatencyWindow,
} from "./host";
export type {
  Scenario,
  ScenarioStation,
  ScenarioArrival,
  ScenarioIntervention,
  DependencyCall,
  InterventionKind,
  Routing,
  LbAlgorithm,
  ScalingMetric,
  StationScaling,
  StationReplication,
  StationBroker,
  BrokerGroup,
  StationShards,
  StationQuorum,
  ArrivalShape,
  ServiceDist,
} from "./scenario";
