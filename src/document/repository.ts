// The persistence seam. All persistence routes through this interface; v1 ships
// only the local Dexie impl. A future RemoteSystemRepository slots in behind the
// same interface: the interface IS the backend stub.
import { SCHEMA_VERSION, SystemDoc, type SystemMeta } from "@/schema";

export interface SystemRepository {
  /** Lightweight metadata for every stored system. */
  list(): Promise<SystemMeta[]>;
  /** Load + migrate + validate one system. Throws SystemNotFoundError if absent. */
  load(id: string): Promise<SystemDoc>;
  /** Validate + persist a system (insert or overwrite by id). */
  save(doc: SystemDoc): Promise<void>;
  /** Remove a system. No-op if it does not exist. */
  delete(id: string): Promise<void>;
  /** Import a `.yantra` file (text or parsed JSON): validate + migrate, persist,
   * return the stored document. Throws DocumentImportError on bad input. */
  importFile(input: unknown): Promise<SystemDoc>;
  /** Serialize a stored system to a `.yantra` Blob. Throws if absent. */
  exportFile(id: string): Promise<Blob>;
}

export class SystemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No system with id ${id}.`);
    this.name = "SystemNotFoundError";
  }
}

/** Build a new, validated document with managed id/timestamps. Lives in the
 * document layer (not the engine), so wall-clock + uuid are allowed here. */
export function createDocument(
  input: { name: string; seed?: number } & Partial<
    Pick<SystemDoc, "id" | "graph" | "workloads" | "interventions" | "view">
  >,
): SystemDoc {
  const now = new Date().toISOString();
  return SystemDoc.parse({
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
    seed: input.seed ?? 0,
    graph: input.graph ?? { nodes: [], edges: [] },
    workloads: input.workloads ?? [],
    interventions: input.interventions ?? [],
    view: input.view,
  });
}
