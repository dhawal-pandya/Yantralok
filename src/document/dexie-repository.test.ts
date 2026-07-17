import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFixture } from "@/__fixtures__/load";
import { DocumentImportError, SCHEMA_VERSION } from "@/schema";
import { DexieSystemRepository } from "./dexie-repository";
import { createDocument, SystemNotFoundError } from "./repository";
import { serializeDocument } from "./serialize";

let repo: DexieSystemRepository;
let dbCounter = 0;

beforeEach(() => {
  // Fresh, isolated IndexedDB database per test.
  repo = new DexieSystemRepository(`test-db-${dbCounter++}`);
});

afterEach(async () => {
  await repo.destroy();
});

describe("DexieSystemRepository", () => {
  it("creates, saves, lists, loads, and deletes multiple systems", async () => {
    const a = createDocument({ name: "Alpha", seed: 1 });
    const b = createDocument({ name: "Bravo", seed: 2 });
    await repo.save(a);
    await repo.save(b);

    const list = await repo.list();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.name).sort()).toEqual(["Alpha", "Bravo"]);

    const loadedA = await repo.load(a.id);
    expect(loadedA).toEqual(a);

    await repo.delete(a.id);
    const after = await repo.list();
    expect(after.map((m) => m.id)).toEqual([b.id]);

    // Deleting a missing id is a no-op.
    await expect(repo.delete("does-not-exist")).resolves.toBeUndefined();
  });

  it("overwrites a system saved under the same id", async () => {
    const doc = createDocument({ id: "fixed-id", name: "v1" });
    await repo.save(doc);
    await repo.save({ ...doc, name: "v2" });
    expect((await repo.list())).toHaveLength(1);
    expect((await repo.load("fixed-id")).name).toBe("v2");
  });

  it("throws SystemNotFoundError for a missing load", async () => {
    await expect(repo.load("nope")).rejects.toBeInstanceOf(SystemNotFoundError);
  });

  it("imports the version n-1 fixture, upgrades it, and stores it", async () => {
    const doc = await repo.importFile(readFixture("v0-system.yantra"));
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);

    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Legacy System");

    const loaded = await repo.load(doc.id);
    expect(loaded.interventions).toEqual([]);
  });

  it("export → reimport yields a byte-identical document", async () => {
    const doc = createDocument({ name: "Exportable", seed: 99 });
    await repo.save(doc);

    const blob = await repo.exportFile(doc.id);
    const text = await blob.text();
    const reimported = await repo.importFile(text);

    expect(serializeDocument(reimported)).toBe(text);
    expect(reimported).toEqual(doc);
  });

  it("rejects importing an invalid file with a clear error", async () => {
    await expect(repo.importFile(readFixture("invalid-system.yantra"))).rejects.toBeInstanceOf(
      DocumentImportError,
    );
    // Nothing was persisted.
    expect(await repo.list()).toHaveLength(0);
  });

  it("exportFile throws for a missing system", async () => {
    await expect(repo.exportFile("nope")).rejects.toBeInstanceOf(SystemNotFoundError);
  });
});
