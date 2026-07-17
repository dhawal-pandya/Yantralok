// The canonical, versioned document schema. One Zod schema serves the in-memory
// document, the IndexedDB record, and the exported `.yantra` file. Zod yields both
// the runtime validator (for untrusted imports) and the TS types.
import { z } from "zod";

/** Bumped as the on-disk `.yantra` document format evolves. */
export const SCHEMA_VERSION = 1;

const Position = z.object({ x: z.number(), y: z.number() });

// `config` / `request` are open per-component bags, validated + defaulted by the
// component library. Here they are just JSON objects.
const ConfigBag = z.record(z.string(), z.unknown());

const Node = z.object({
  id: z.string(),
  type: z.string(),
  position: Position,
  config: ConfigBag.default({}),
});

const Edge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  // Chosen ports; presentation only, ignored by compile/engine.
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  config: ConfigBag.default({}),
});

const Graph = z.object({
  nodes: z.array(Node).default([]),
  edges: z.array(Edge).default([]),
});

const Workload = z.object({
  id: z.string(),
  kind: z.string(), // poisson | constant | burst | periodic | ...
  rate: z.number(),
  target: z.string(),
  request: ConfigBag.default({}),
});

const Intervention = z.object({
  id: z.string(),
  atLogicalTime: z.number(),
  kind: z.string(), // kill | restart | delay | partition | ...
  target: z.string(),
  param: z.number().optional(), // e.g. delay: extra ms (additive, backward-compatible)
  shard: z.number().int().optional(), // kill/restart one cell of a sharded store
});

// Convenience only: viewport/selection. Not part of the reproducible run.
const View = z.record(z.string(), z.unknown());

/** The whole document. `seed + graph + workloads + interventions` is the
 * complete, reproducible run definition (the event-sourcing source of truth). */
export const SystemDoc = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  seed: z.number().int(),
  graph: Graph,
  workloads: z.array(Workload).default([]),
  interventions: z.array(Intervention).default([]),
  view: View.optional(),
});

export type SystemDoc = z.infer<typeof SystemDoc>;
export type SystemNode = z.infer<typeof Node>;
export type SystemEdge = z.infer<typeof Edge>;
export type Workload = z.infer<typeof Workload>;
export type Intervention = z.infer<typeof Intervention>;

/** The list-view projection of a document. */
export interface SystemMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export const toMeta = (doc: SystemDoc): SystemMeta => ({
  id: doc.id,
  name: doc.name,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  schemaVersion: doc.schemaVersion,
});
