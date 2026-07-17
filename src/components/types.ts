// The component model. A component is a parameter PROFILE over the engine's laws
// plus sane editable defaults, never a bespoke simulator. Every component and
// property carries its semantics (what it is, how it affects the simulation, the
// law it touches): tooltips are core, not chrome.

export type PropertyKind = "number" | "string" | "select" | "boolean";

/** The teaching DNA attached to every component and property. */
export interface Semantics {
  /** What it is, in one line. */
  what: string;
  /** How it affects the simulation. */
  effect: string;
  /** The behavioral law it touches, if any. */
  law?: string;
}

export interface PropertyDef extends Semantics {
  key: string;
  label: string;
  kind: PropertyKind;
  default: number | string | boolean;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[]; // for kind === "select"
  /** Shown but not yet wired into the engine, tagged so it can't mislead. */
  pending?: boolean;
  /** Only show (and apply) when another property matches: a knob gated behind a
   * mode switch is hidden, not inert. `equals` matches exactly; `min` matches a
   * numeric value ≥ min (e.g. a lag knob needing replicas ≥ 1). */
  showIf?: { key: string; equals?: number | string | boolean; min?: number };
}

/** Broad grouping for the palette (mirrors CLAUDE.md's library sections). */
export type Category =
  | "Networking"
  | "Compute"
  | "Storage"
  | "Messaging"
  | "Infrastructure";

export interface ComponentDef extends Semantics {
  type: string; // stable id stored in SystemDoc node.type
  label: string;
  category: Category;
  /** Status-neutral accent for the node chrome. Semantic status colors are the
   * engine's job later; this is just identity. */
  accent: string;
  /** A traffic source (Client / Browser / Cron Job): compile turns it into an
   * arrival generator at its `requestRate`, shaped by its `pattern`. Not a queue
   * server, so it carries no servers knob. */
  source?: boolean;
  /** A cache: a healthy hit short-circuits the caller (skips the slow tier); a
   * dead one falls through, driving the kill-Redis to Postgres cascade. */
  cache?: boolean;
  /** Load-balances: routes each request to ONE healthy backend, not all of them.
   * The backend is chosen by the `algorithm` property. */
  loadBalance?: boolean;
  /** A store whose `replicas` are READ replicas: reads route to the replica pool
   * with replication lag; writes stay on the primary. Without this flag, `replicas`
   * is a flat capacity multiplier (identical stateless instances). */
  readReplicas?: boolean;
  /** An async message broker: a produce enqueues and acks at once, and a pool of
   * consumers drains the backlog independently. Producing is decoupled from
   * consuming, so consumer lag grows when produce rate exceeds consume capacity. */
  broker?: boolean;
  properties: readonly PropertyDef[];
}

/** The channel a connection carries (edges have config too). */
export interface ChannelDef {
  properties: readonly PropertyDef[];
}

export type NodeConfig = Record<string, number | string | boolean>;
