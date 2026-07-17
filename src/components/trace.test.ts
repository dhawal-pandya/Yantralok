import { describe, expect, it } from "vitest";
import { MainThreadHost, type TraceSpan } from "@/engine";
import { addEdge, addNode, createDocument, updateNodeConfig } from "@/document";
import type { SystemDoc } from "@/schema";
import { compileScenario } from "./compile";

// Client → API → Postgres, light load so the whole span tree fits the budget.
function chain(): SystemDoc {
  let d = createDocument({ id: "t", name: "T", seed: 4 });
  d = addNode(d, "client", { x: 0, y: 0 }, "cl");
  d = addNode(d, "api", { x: 1, y: 0 }, "api");
  d = addNode(d, "postgres", { x: 2, y: 0 }, "pg");
  d = addEdge(d, "cl", "api", "e0");
  d = addEdge(d, "api", "pg", "e1");
  d = updateNodeConfig(d, "cl", { requestRate: 120 });
  d = updateNodeConfig(d, "pg", { maxConnections: 20, serviceTime: 8 });
  return d;
}

const run = (d: SystemDoc, horizonMs = 8000) => new MainThreadHost().run(compileScenario(d), { horizonMs });
const byReq = (spans: TraceSpan[]) => {
  const m = new Map<number, TraceSpan[]>();
  for (const s of spans) (m.get(s.req) ?? m.set(s.req, []).get(s.req)!).push(s);
  return m;
};

describe("trace waterfall spans", () => {
  it("captures spans; each request has one enclosing root with ordered phases", () => {
    const r = run(chain());
    expect(r.spans.length).toBeGreaterThan(0);

    let checked = 0;
    for (const [, sps] of byReq(r.spans)) {
      const roots = sps.filter((s) => s.parent === null && s.depth === 0);
      expect(roots).toHaveLength(1);
      const root = roots[0];
      // The root span encloses the whole tree in time.
      expect(root.issue).toBe(Math.min(...sps.map((s) => s.issue)));
      expect(root.end + root.net).toBe(Math.max(...sps.map((s) => s.end + s.net)));
      // Per span: issue ≤ admit ≤ service ≤ end (network → queue → service).
      for (const s of sps) {
        expect(s.admit).toBeGreaterThanOrEqual(s.issue);
        if (s.service >= 0) {
          expect(s.service).toBeGreaterThanOrEqual(s.admit);
          expect(s.end).toBeGreaterThanOrEqual(s.service);
        }
      }
      if (++checked >= 20) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the waterfall's end-to-end span equals the root's duration (the request latency)", () => {
    const r = run(chain());
    const root = r.spans.find((s) => s.parent === null && !s.error)!;
    const sps = r.spans.filter((s) => s.req === root.req);
    const total = Math.max(...sps.map((s) => s.end + s.net)) - Math.min(...sps.map((s) => s.issue));
    expect(total).toBeCloseTo(root.end - root.issue, 6);
    expect(total).toBeGreaterThan(0);
  });

  it("determinism: same seed → identical spans", () => {
    expect(JSON.stringify(run(chain()).spans)).toBe(JSON.stringify(run(chain()).spans));
  });

  it("retries and timeouts are labeled, not just failed hops", () => {
    let d = createDocument({ id: "ct", name: "CT", seed: 2 });
    d = addNode(d, "client", { x: 0, y: 0 }, "cl");
    d = addNode(d, "api", { x: 1, y: 0 }, "api");
    d = addNode(d, "postgres", { x: 2, y: 0 }, "pg");
    d = addEdge(d, "cl", "api", "e0");
    d = addEdge(d, "api", "pg", "e1");
    d = updateNodeConfig(d, "cl", { requestRate: 400 });
    d = updateNodeConfig(d, "api", { concurrency: 100_000, serviceTime: 2, timeout: 50, retries: 3 });
    d = updateNodeConfig(d, "pg", { maxConnections: 4, serviceTime: 30, queueCapacity: 100_000 });

    const r = run(d, 6000);
    expect(r.spans.some((s) => s.timedOut)).toBe(true); // abandoned-by-timeout calls
    expect(r.spans.some((s) => s.attempt > 0)).toBe(true); // retried calls
  });
});
