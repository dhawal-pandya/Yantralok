import { describe, expect, it } from "vitest";
import { DocumentImportError } from "@/schema";
import { createDocument } from "./repository";
import { exportBlob, importDocument, serializeDocument } from "./serialize";

const sampleDoc = () =>
  createDocument({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Round Trip",
    seed: 7,
    graph: {
      nodes: [
        { id: "n1", type: "api", position: { x: 0, y: 0 }, config: { c: 200 } },
        { id: "n2", type: "redis", position: { x: 9, y: 9 }, config: {} },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", config: {} }],
    },
    workloads: [{ id: "w1", kind: "poisson", rate: 200, target: "n1", request: {} }],
  });

describe("serialize / import round trip", () => {
  it("export → import → export is byte-identical", () => {
    const doc = sampleDoc();
    const first = serializeDocument(doc);
    const reimported = importDocument(first);
    const second = serializeDocument(reimported);
    expect(second).toBe(first);
  });

  it("the reimported document deep-equals the original", () => {
    const doc = sampleDoc();
    expect(importDocument(serializeDocument(doc))).toEqual(doc);
  });

  it("serialization is key-order independent (stable)", () => {
    const doc = sampleDoc();
    // Same content, different key insertion order, must serialize identically.
    const shuffled = {
      name: doc.name,
      schemaVersion: doc.schemaVersion,
      graph: doc.graph,
      seed: doc.seed,
      updatedAt: doc.updatedAt,
      interventions: doc.interventions,
      createdAt: doc.createdAt,
      workloads: doc.workloads,
      id: doc.id,
    };
    expect(serializeDocument(shuffled as typeof doc)).toBe(serializeDocument(doc));
  });

  it("exportBlob carries the serialized text", async () => {
    const doc = sampleDoc();
    const text = await exportBlob(doc).text();
    expect(text).toBe(serializeDocument(doc));
  });

  it("rejects invalid input", () => {
    expect(() => importDocument("{ broken")).toThrow(DocumentImportError);
    expect(() => importDocument({ schemaVersion: 1 })).toThrow(DocumentImportError);
  });
});
