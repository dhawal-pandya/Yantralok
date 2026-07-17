import { describe, expect, it } from "vitest";
import { compileScenario } from "@/components";
import { MainThreadHost } from "@/engine";
import { addEdge, addNode, updateNodeConfig } from "./graph-ops";
import { createDocument } from "./repository";
import { toMermaid, toSimulationReport } from "./exports";

function demoDoc() {
  let doc = createDocument({ id: "sys-x", name: "Export Demo", seed: 9 });
  doc = addNode(doc, "client", { x: 0, y: 0 }, "c");
  doc = addNode(doc, "api", { x: 1, y: 0 }, "a");
  doc = addNode(doc, "postgres", { x: 2, y: 0 }, "p");
  doc = addEdge(doc, "c", "a", "e1");
  doc = addEdge(doc, "a", "p", "e2");
  doc = updateNodeConfig(doc, "c", { requestRate: 150 });
  // A tight pool makes Postgres the clear busiest tier without saturating the API.
  doc = updateNodeConfig(doc, "p", { maxConnections: 3, serviceTime: 15 });
  return doc;
}

describe("toMermaid", () => {
  it("renders a flowchart with component labels and latency-labeled edges", () => {
    const m = toMermaid(demoDoc());
    expect(m.startsWith("flowchart LR")).toBe(true);
    for (const label of ["Client", "API", "Postgres"])
      expect(m).toContain(`"${label}"`);
    expect(m).toContain("-->|1ms|");
    // node ids are aliased, not raw graph ids
    expect(m).toContain("N0");
    expect(m).not.toContain('"c"');
  });

  it("omits dangling edges gracefully", () => {
    const doc = { ...demoDoc() };
    doc.graph = {
      ...doc.graph,
      edges: [
        ...doc.graph.edges,
        { id: "bad", source: "c", target: "ghost", config: {} },
      ],
    };
    const m = toMermaid(doc);
    expect(m.split("\n").filter((l) => l.includes("-->"))).toHaveLength(2);
  });
});

describe("toSimulationReport", () => {
  it("summarizes outcome, per-station peak load, and the bottleneck", () => {
    const doc = demoDoc();
    const result = new MainThreadHost().run(compileScenario(doc), {
      horizonMs: 8000,
    });
    const report = toSimulationReport(doc, result);

    expect(report).toContain("# Simulation Report: Export Demo");
    expect(report).toContain("Seed: `9`");
    expect(report).toContain("Completed:");
    expect(report).toContain("| Postgres |");
    expect(report).toContain("**Bottleneck:** Postgres");
  });

  it("lists injected failures when present", () => {
    const doc = {
      ...demoDoc(),
      interventions: [
        { id: "k", atLogicalTime: 3000, kind: "kill", target: "p" },
      ],
    };
    const result = new MainThreadHost().run(compileScenario(doc), {
      horizonMs: 6000,
    });
    const report = toSimulationReport(doc, result);
    expect(report).toContain("## Injected failures");
    expect(report).toContain("t=3.00s: kill Postgres");
  });

  it("includes the cost estimate with period totals and per-node lines", () => {
    const doc = demoDoc();
    const result = new MainThreadHost().run(compileScenario(doc), {
      horizonMs: 8000,
    });
    const report = toSimulationReport(doc, result);

    const costSection = report.slice(report.indexOf("## Estimated cost"));
    expect(costSection).toContain(
      "| Per hour | Per day | Per month | Per year |",
    );
    expect(costSection).toContain(
      "| Postgres | RDS db.m5.large per 100 connections + storage |",
    );
    expect(costSection).toContain("| API | EC2 m5.large per 200 threads |");
    // The client is a traffic source: free, so never a billed line.
    expect(costSection).not.toContain("| Client |");
    expect(costSection).toContain("extrapolated as steady state");
  });
});
