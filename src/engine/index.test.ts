import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@/engine";

describe("engine scaffold", () => {
  it("exposes a version string derived from the schema version", () => {
    expect(ENGINE_VERSION).toBe("0.0.0+schema1");
  });
});
