import { describe, expect, it } from "vitest";
import { readFixture } from "@/__fixtures__/load";
import { SCHEMA_VERSION } from "./document";
import { DocumentImportError, migrate, parseDocument } from "./migrations";

describe("migrate", () => {
  it("upgrades a v0 doc to current, adding interventions", () => {
    const v0 = { schemaVersion: 0, name: "x" };
    const out = migrate(v0);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.interventions).toEqual([]);
  });

  it("treats a missing schemaVersion as 0", () => {
    expect(migrate({ name: "x" }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("is a no-op on a current-version doc", () => {
    const cur = { schemaVersion: SCHEMA_VERSION, interventions: [{ id: "i1" }] };
    expect(migrate(cur)).toEqual(cur);
  });

  it("rejects a version newer than supported", () => {
    expect(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 })).toThrow(
      DocumentImportError,
    );
  });

  it("rejects non-objects", () => {
    expect(() => migrate(null)).toThrow(DocumentImportError);
    expect(() => migrate([])).toThrow(DocumentImportError);
  });
});

describe("parseDocument", () => {
  it("loads and upgrades the version n-1 fixture", () => {
    const doc = parseDocument(readFixture("v0-system.yantra"));
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.interventions).toEqual([]); // added by the 0 → 1 migration
    expect(doc.name).toBe("Legacy System");
    expect(doc.graph.nodes).toHaveLength(2);
  });

  it("accepts already-parsed JSON, not just text", () => {
    const obj = JSON.parse(readFixture("v0-system.yantra"));
    expect(parseDocument(obj).id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects malformed JSON with a clear error", () => {
    expect(() => parseDocument("{ not json")).toThrow(/not valid JSON/i);
  });

  it("rejects a schema-invalid file with a clear, surfaced error", () => {
    let err: unknown;
    try {
      parseDocument(readFixture("invalid-system.yantra"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DocumentImportError);
    // The message names the offending fields.
    expect((err as Error).message).toMatch(/seed/);
    expect((err as Error).message).toMatch(/position/);
  });
});
