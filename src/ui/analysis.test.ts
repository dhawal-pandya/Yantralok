import { describe, expect, it } from "vitest";
import type { TraceSpan } from "@/engine";
import {
  criticalPath,
  edgeLatency,
  latencyContribution,
  legKey,
  slowestRequest,
} from "./analysis";

// Minimal span builder: only the fields these derivations read.
function span(p: Partial<TraceSpan> & Pick<TraceSpan, "call" | "station">): TraceSpan {
  return {
    req: 1,
    parent: null,
    depth: 0,
    issue: 0,
    admit: 0,
    service: 0,
    end: 0,
    net: 0,
    attempt: 0,
    timedOut: false,
    error: false,
    ...p,
  };
}

describe("criticalPath", () => {
  it("follows the whole chain when each call has one child", () => {
    const spans = [
      span({ call: 0, station: "A", issue: 0, admit: 0, end: 30 }),
      span({ call: 1, parent: 0, station: "B", issue: 1, admit: 2, end: 20 }),
      span({ call: 2, parent: 1, station: "C", issue: 3, admit: 4, end: 12 }),
    ];
    const { stations, legs } = criticalPath(spans, 1);
    expect([...stations].sort()).toEqual(["A", "B", "C"]);
    expect(legs).toEqual(new Set([legKey("A", "B"), legKey("B", "C")]));
  });

  it("takes the slowest branch of a parallel fan-out", () => {
    // A fans out to B (returns at 8) and C (returns at 20). C gates A.
    const spans = [
      span({ call: 0, station: "A", end: 22 }),
      span({ call: 1, parent: 0, station: "B", end: 8, net: 0 }),
      span({ call: 2, parent: 0, station: "C", end: 18, net: 2 }),
    ];
    const { stations, legs } = criticalPath(spans, 1);
    expect(stations).toEqual(new Set(["A", "C"]));
    expect(legs).toEqual(new Set([legKey("A", "C")]));
  });

  it("returns empty sets when the request has no spans", () => {
    const { stations, legs } = criticalPath([span({ call: 0, station: "A" })], 99);
    expect(stations.size).toBe(0);
    expect(legs.size).toBe(0);
  });
});

describe("slowestRequest", () => {
  it("picks the request with the longest end-to-end life", () => {
    const spans = [
      span({ req: 1, call: 0, station: "A", issue: 0, end: 10, net: 0 }),
      span({ req: 2, call: 1, station: "A", issue: 0, end: 40, net: 0 }),
    ];
    expect(slowestRequest(spans)).toBe(2);
  });

  it("returns null on an empty trace", () => {
    expect(slowestRequest([])).toBeNull();
  });
});

describe("latencyContribution", () => {
  it("sums queue+service (end - admit) per station", () => {
    const spans = [
      span({ call: 0, station: "A", admit: 0, end: 10 }),
      span({ call: 1, station: "B", admit: 2, end: 12 }), // 10
      span({ call: 2, station: "B", admit: 0, end: 5 }), // 5 -> B total 15
    ];
    const c = latencyContribution(spans);
    expect(c.get("A")).toBe(10);
    expect(c.get("B")).toBe(15);
  });
});

describe("edgeLatency", () => {
  it("means the round-trip (end + net - issue) per leg", () => {
    const spans = [
      span({ call: 0, station: "A" }),
      span({ call: 1, parent: 0, station: "B", issue: 0, end: 10, net: 2 }), // 12
      span({ call: 2, parent: 0, station: "B", issue: 0, end: 6, net: 2 }), // 8 -> mean 10
    ];
    const e = edgeLatency(spans);
    expect(e.get(legKey("A", "B"))).toBe(10);
  });
});
