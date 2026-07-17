// Test helper: read a `.yantra` fixture as text. Node-only (used from tests).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
