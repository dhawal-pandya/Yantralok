// `.yantra` serialization. Content is always plain JSON; the extension is only a
// label. Export serializes; import parses, migrates, then validates (parseDocument,
// in schema/).
import { parseDocument, type SystemDoc } from "@/schema";

export const YANTRA_EXTENSION = ".yantra";
export const YANTRA_MIME = "application/json";

/** Deterministic JSON: object keys sorted recursively. Guarantees a serialize →
 * import → serialize round trip is byte-identical regardless of key order. */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) throw new Error("Cannot serialize a document with cycles.");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[key];
      if (val !== undefined) out[key] = normalize(val);
    }
    return out;
  };
  return JSON.stringify(normalize(value), null, 2);
}

/** Serialize a document to `.yantra` text. */
export const serializeDocument = (doc: SystemDoc): string => stableStringify(doc);

/** Serialize a document to a `.yantra` Blob (for file download). */
export const exportBlob = (doc: SystemDoc): Blob =>
  new Blob([serializeDocument(doc)], { type: YANTRA_MIME });

/** Import from `.yantra` text or already-parsed JSON. Validates + migrates;
 * throws DocumentImportError on any failure. */
export const importDocument = (input: unknown): SystemDoc => parseDocument(input);
