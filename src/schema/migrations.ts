// Migration chain. Every load/import runs migrate(): a chain of pure functions
// upgrading any older schemaVersion to current. A version n-1 fixture must always
// load and upgrade, a permanent invariant.
import { SCHEMA_VERSION, SystemDoc } from "./document";

/** Thrown when an imported file cannot be parsed, migrated, or validated. */
export class DocumentImportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentImportError";
  }
}

type RawDoc = Record<string, unknown>;
/** A migration upgrades a doc from version `key` to `key + 1`. Pure. */
type Migration = (doc: RawDoc) => RawDoc;

// Keyed by source version. migrations[n] takes a v-n doc to a v-(n+1) doc.
const migrations: Record<number, Migration> = {
  // v0 to v1: `interventions` was added to the run definition.
  0: (doc) => ({ ...doc, interventions: doc.interventions ?? [], schemaVersion: 1 }),
};

const readVersion = (doc: RawDoc): number => {
  const v = doc.schemaVersion;
  return typeof v === "number" ? v : 0;
};

/** Upgrade a raw document object to the current schemaVersion. Pure; does not
 * validate field shapes, that is the validator's job (see parseDocument). */
export function migrate(input: unknown): RawDoc {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DocumentImportError("Document is not a JSON object.");
  }
  let doc = input as RawDoc;
  let version = readVersion(doc);
  if (version > SCHEMA_VERSION) {
    throw new DocumentImportError(
      `Document schemaVersion ${version} is newer than supported (${SCHEMA_VERSION}). Update the app.`,
    );
  }
  while (version < SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) {
      throw new DocumentImportError(`No migration from schemaVersion ${version}.`);
    }
    doc = step(doc);
    const next = readVersion(doc);
    if (next <= version) {
      throw new DocumentImportError(`Migration from ${version} did not advance the version.`);
    }
    version = next;
  }
  return doc;
}

/** The import pipeline: parse (if text), migrate, then validate. Throws
 * DocumentImportError with a clear message on any failure. */
export function parseDocument(input: unknown): SystemDoc {
  let json = input;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch (e) {
      throw new DocumentImportError("File is not valid JSON.", e);
    }
  }
  const migrated = migrate(json);
  const result = SystemDoc.safeParse(migrated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new DocumentImportError(`Document failed validation: ${issues}`, result.error);
  }
  return result.data;
}
