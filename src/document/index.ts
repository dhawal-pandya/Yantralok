// Document operations, the SystemRepository seam + its Dexie implementation, and
// .yantra import/export.

export {
  type SystemRepository,
  SystemNotFoundError,
  createDocument,
} from "./repository";
export { DexieSystemRepository } from "./dexie-repository";
export {
  serializeDocument,
  exportBlob,
  importDocument,
  YANTRA_EXTENSION,
  YANTRA_MIME,
} from "./serialize";
export { toMermaid, toSimulationReport } from "./exports";
export {
  addNode,
  removeNode,
  moveNode,
  updateNodeConfig,
  addEdge,
  removeEdge,
  updateEdgeConfig,
  renameSystem,
  addIntervention,
  removeIntervention,
  updateIntervention,
  touch,
  type Point,
  type EdgeHandles,
} from "./graph-ops";

// Re-exported for convenience so consumers of the document layer get the doc
// types + the import-error type without reaching into @/schema directly.
export {
  type SystemDoc,
  type SystemMeta,
  DocumentImportError,
} from "@/schema";
