// The component library. Components are parameter profiles over the engine's
// universal laws plus sane editable defaults, NOT bespoke simulators.
// May import from @/engine and @/schema.

export {
  listComponents,
  getComponent,
  defaultConfig,
  defaultChannelConfig,
  CHANNEL,
} from "./registry";
export { compileScenario } from "./compile";
export {
  estimateCost,
  fmtUSD,
  HOURS_PER_DAY,
  HOURS_PER_MONTH,
  HOURS_PER_YEAR,
} from "./cost";
export type { CostEstimate, NodeCost } from "./cost";
export type {
  ComponentDef,
  PropertyDef,
  PropertyKind,
  ChannelDef,
  Category,
  Semantics,
  NodeConfig,
} from "./types";
