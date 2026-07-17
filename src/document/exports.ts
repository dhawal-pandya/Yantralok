// Human-readable exports: a Mermaid diagram of the topology and a Markdown
// simulation report. Both are pure text formatters over data the rest of the app
// already holds, no new engine work.
import {
  estimateCost,
  fmtUSD,
  getComponent,
  HOURS_PER_DAY,
  HOURS_PER_MONTH,
  HOURS_PER_YEAR,
} from "@/components";
import type { RunResult } from "@/engine";
import type { SystemDoc } from "@/schema";

const labelOf = (type: string): string => getComponent(type)?.label ?? type;

/** Render the graph as a Mermaid `flowchart LR`. Node ids are aliased to keep the
 * output valid regardless of the (uuid) ids in the document. */
export function toMermaid(doc: SystemDoc): string {
  const alias = new Map<string, string>();
  doc.graph.nodes.forEach((node, i) => alias.set(node.id, `N${i}`));

  const escape = (s: string): string => s.replace(/"/g, "'");
  const lines = ["flowchart LR"];

  for (const node of doc.graph.nodes) {
    lines.push(`  ${alias.get(node.id)}["${escape(labelOf(node.type))}"]`);
  }
  for (const edge of doc.graph.edges) {
    const s = alias.get(edge.source);
    const t = alias.get(edge.target);
    if (!s || !t) continue;
    const lat = edge.config.latency;
    const arrow = typeof lat === "number" ? `-->|${lat}ms|` : "-->";
    lines.push(`  ${s} ${arrow} ${t}`);
  }
  return lines.join("\n") + "\n";
}

/** Summarize a completed run as a Markdown report: outcome totals, per-station
 * peak utilization, and the injected failures. */
export function toSimulationReport(doc: SystemDoc, result: RunResult): string {
  const labelById = new Map(
    doc.graph.nodes.map((n) => [n.id, labelOf(n.type)]),
  );

  const peak = result.stationIds.map((_, i) => {
    let rho = 0;
    let queue = 0;
    for (const w of result.windows) {
      const st = w.stations[i];
      if (st && Number.isFinite(st.utilization))
        rho = Math.max(rho, st.utilization);
      if (st && Number.isFinite(st.queue)) queue = Math.max(queue, st.queue);
    }
    return { id: result.stationIds[i], rho, queue };
  });

  const bottleneck = peak.reduce<(typeof peak)[number] | null>(
    (max, s) => (max === null || s.rho > max.rho ? s : max),
    null,
  );

  const { completions, failures, meanLatency } = result.totals;
  const total = completions + failures;
  const failPct = total > 0 ? (failures / total) * 100 : 0;
  const num = (x: number, digits = 1): string =>
    Number.isFinite(x) ? x.toFixed(digits) : "-";

  const out: string[] = [];
  out.push(`# Simulation Report: ${doc.name}`, "");
  out.push(`- Seed: \`${doc.seed}\``);
  out.push(`- Horizon: ${num(result.horizonMs / 1000)} s`, "");

  out.push("## Outcome", "");
  out.push(`- Completed: ${completions}`);
  out.push(`- Failed: ${failures} (${num(failPct)}%)`);
  out.push(`- Mean latency: ${num(meanLatency)} ms`, "");

  out.push("## Stations: peak load", "");
  out.push("| Station | Peak ρ | Peak queue |");
  out.push("| --- | --- | --- |");
  for (const s of peak) {
    const label = labelById.get(s.id) ?? s.id;
    out.push(`| ${label} | ${num(s.rho * 100, 0)}% | ${num(s.queue)} |`);
  }
  out.push("");
  if (bottleneck) {
    out.push(
      `**Bottleneck:** ${labelById.get(bottleneck.id) ?? bottleneck.id} (peak ρ ${num(bottleneck.rho * 100, 0)}%)`,
      "",
    );
  }

  if (doc.interventions.length > 0) {
    out.push("## Injected failures", "");
    for (const iv of [...doc.interventions].sort(
      (a, b) => a.atLogicalTime - b.atLogicalTime,
    )) {
      const label = labelById.get(iv.target) ?? iv.target;
      out.push(`- t=${num(iv.atLogicalTime / 1000, 2)}s: ${iv.kind} ${label}`);
    }
    out.push("");
  }

  const est = estimateCost(doc, result);
  if (est.nodes.length > 0) {
    out.push("## Estimated cost", "");
    out.push(`| Per hour | Per day | Per month | Per year |`);
    out.push(`| --- | --- | --- | --- |`);
    out.push(
      `| ${fmtUSD(est.hourly)} | ${fmtUSD(est.hourly * HOURS_PER_DAY)} | ${fmtUSD(est.hourly * HOURS_PER_MONTH)} | ${fmtUSD(est.hourly * HOURS_PER_YEAR)} |`,
      "",
    );
    out.push("| Node | Billed as | Instances | Measured req/s | Per month |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const n of est.nodes) {
      const label = labelById.get(n.id) ?? n.id;
      const inst =
        n.instances % 1 === 0 ? String(n.instances) : n.instances.toFixed(1);
      out.push(
        `| ${label} | ${n.basis} | ${inst} | ${num(n.reqPerSec, 0)} | ${fmtUSD(n.hourly * HOURS_PER_MONTH)} |`,
      );
    }
    out.push("");
    if (est.nonSteady.length > 0) {
      out.push(
        `**Non-steady traffic:** ${est.nonSteady.join(", ")}. The extrapolation bills this exact window on repeat, so these figures price the stress that was designed, not a typical month.`,
        "",
      );
    }
    out.push(
      `Usage measured over this ${num(result.horizonMs / 1000, 0)} s run and extrapolated as steady state, at representative AWS on-demand rates. Capacity knobs size the billed fleet; traffic sources are free; NAT and cross-AZ transfer are not modeled.`,
      "",
    );
  }

  return out.join("\n");
}
