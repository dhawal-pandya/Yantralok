// Local-first persistence on IndexedDB via Dexie. Multiple systems per user, no
// auth. Currently the only implementation of SystemRepository.
import Dexie, { type Table } from "dexie";
import { SystemDoc, parseDocument, toMeta, type SystemMeta } from "@/schema";
import { exportBlob } from "./serialize";
import {
  SystemNotFoundError,
  type SystemRepository,
} from "./repository";

class YantralokDb extends Dexie {
  // Index id (primary) + fields used for listing/sorting.
  systems!: Table<SystemDoc, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ systems: "id, name, updatedAt" });
  }
}

export class DexieSystemRepository implements SystemRepository {
  private readonly db: YantralokDb;

  constructor(dbName = "yantralok") {
    this.db = new YantralokDb(dbName);
  }

  async list(): Promise<SystemMeta[]> {
    const docs = await this.db.systems.toArray();
    // Stable, deterministic order: most recently updated first, id as tiebreak.
    return docs
      .map(toMeta)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async load(id: string): Promise<SystemDoc> {
    const stored = await this.db.systems.get(id);
    if (!stored) throw new SystemNotFoundError(id);
    // Defensive migrate + validate on every load.
    return parseDocument(stored);
  }

  async save(doc: SystemDoc): Promise<void> {
    // Validate before persisting; never store an invalid document.
    const valid = SystemDoc.parse(doc);
    await this.db.systems.put(valid);
  }

  async delete(id: string): Promise<void> {
    await this.db.systems.delete(id);
  }

  async importFile(input: unknown): Promise<SystemDoc> {
    const doc = parseDocument(input);
    await this.save(doc);
    return doc;
  }

  async exportFile(id: string): Promise<Blob> {
    const doc = await this.load(id);
    return exportBlob(doc);
  }

  /** Test/teardown helper: close and drop the underlying IndexedDB database. */
  async destroy(): Promise<void> {
    await this.db.delete();
  }
}
