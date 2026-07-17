// Shared schemas + the TypeScript types derived from them.
// The single source of truth for the document model.
//
// Engine, components, document, and ui all depend on this module; this module
// depends on nothing (except Zod).

export {
  SCHEMA_VERSION,
  SystemDoc,
  toMeta,
  type SystemNode,
  type SystemEdge,
  type Workload,
  type Intervention,
  type SystemMeta,
} from "./document";

export { migrate, parseDocument, DocumentImportError } from "./migrations";
