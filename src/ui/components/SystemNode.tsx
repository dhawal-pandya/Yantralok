// A node on the canvas. Multiple joints (a target + source handle on every side)
// so wiring reads like a real diagram. When a simulation is playing it shows live
// utilization ρ with a status color (emerald to amber to red); status color is the
// engine's to assign, identity accent stays on the left rail.
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ComponentDef } from "@/components";
import type { SystemNode as DocNode } from "@/schema";
import { healthColor, rgba } from "@/ui/glow";

export interface LiveMetric {
  utilization: number;
  queue: number;
  bottleneck: boolean;
  dead: boolean;
  hitRate: number; // NaN unless this is a cache serving reads
  calls: number; // calls/s received (per-dependency load)
  instances: number; // NaN unless autoscaled: live fleet size
  staleRate: number; // NaN unless a replicated store serving reads
  backlog: number; // NaN unless a broker: mean consumer lag (buffered messages)
  newConns: number; // NaN unless connections are modeled: new (cold) conns per second
}

// Ambient legibility glow (opt-in). `t` in [0,1] on the green->red health ramp;
// `onCritical` brightens a node sitting on the highlighted request's path.
export interface NodeGlow {
  t: number;
  onCritical: boolean;
}

export type SystemFlowNode = Node<
  { def?: ComponentDef; node: DocNode; metric?: LiveMetric; glow?: NodeGlow },
  "system"
>;

// A subtle drop-glow: healthy green stays faint, saturation warms and strengthens.
function glowShadow(g: NodeGlow): string {
  const c = healthColor(g.t);
  const a = 0.22 + 0.5 * g.t; // slight when green, stronger when red
  const spread = g.onCritical ? "0 0 24px 2px" : "0 0 18px";
  return `${spread} ${rgba(c, a)}`;
}

const statusColor = (rho: number) =>
  rho >= 0.9 ? "#f87171" : rho >= 0.7 ? "#f5b301" : "#34d399";

const SIDES = [
  { pos: Position.Left, key: "l" },
  { pos: Position.Right, key: "r" },
  { pos: Position.Top, key: "t" },
  { pos: Position.Bottom, key: "b" },
];

export function SystemNode({ data, selected }: NodeProps<SystemFlowNode>) {
  const { def, node, metric, glow } = data;
  const readouts = (def?.properties ?? []).filter((p) => p.kind === "number").slice(0, 2);
  const live = metric && Number.isFinite(metric.utilization);
  const rho = Math.max(0, Math.min(1, metric?.utilization ?? 0));

  const dead = metric?.dead;

  return (
    <div
      className={`relative min-w-[140px] rounded-md border bg-neutral-900 shadow-md transition-shadow ${
        dead
          ? "border-red-500 opacity-60"
          : metric?.bottleneck
            ? "border-red-500 ring-1 ring-red-500/50"
            : selected
              ? "border-signal"
              : "border-neutral-700"
      }`}
      style={{
        borderLeft: `3px solid ${def?.accent ?? "#52525b"}`,
        ...(glow && !dead ? { boxShadow: glowShadow(glow) } : {}),
      }}
    >
      {SIDES.map((s) => (
        <Handle key={`t-${s.key}`} type="target" position={s.pos} id={`t-${s.key}`} />
      ))}
      {SIDES.map((s) => (
        <Handle key={`s-${s.key}`} type="source" position={s.pos} id={`s-${s.key}`} />
      ))}

      <div className="px-2.5 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-neutral-100">{def?.label ?? node.type}</span>
          {dead ? (
            <span className="font-mono text-[10px] font-semibold text-red-400">✕ DOWN</span>
          ) : (
            live && (
              <span className="flex items-center gap-1.5 font-mono text-[10px]">
                {Number.isFinite(metric?.instances) && (
                  <span className="rounded bg-neutral-800 px-1 text-neutral-300" title="Autoscaled instances online">
                    ×{metric?.instances}
                  </span>
                )}
                <span style={{ color: statusColor(rho) }}>ρ {(rho * 100).toFixed(0)}%</span>
              </span>
            )
          )}
        </div>
        <div className="font-mono text-[10px] text-neutral-600">{node.id.slice(0, 8)}</div>

        {live ? (
          <div className="mt-1.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full rounded-full" style={{ width: `${rho * 100}%`, backgroundColor: statusColor(rho) }} />
            </div>
            <div className="mt-0.5 flex justify-between gap-2 font-mono text-[10px] text-neutral-500">
              {Number.isFinite(metric?.backlog) ? (
                <span className={(metric?.backlog ?? 0) > 100 ? "text-amber-300" : undefined} title="Consumer lag: messages buffered but not yet consumed">
                  lag {(metric?.backlog ?? 0).toFixed(0)}
                </span>
              ) : (
                <span>queue {(metric?.queue ?? 0).toFixed(1)}</span>
              )}
              {Number.isFinite(metric?.hitRate) ? (
                <span className="text-neutral-300">hit {((metric?.hitRate ?? 0) * 100).toFixed(0)}%</span>
              ) : Number.isFinite(metric?.staleRate) ? (
                <span className="text-amber-300" title="Replica reads within the replication-lag window of a write">
                  stale {((metric?.staleRate ?? 0) * 100).toFixed(0)}%
                </span>
              ) : Number.isFinite(metric?.newConns) && (metric?.newConns ?? 0) > 0 ? (
                <span className="text-neutral-300" title="New (cold) connections opened per second, each paying a handshake">
                  {(metric?.newConns ?? 0).toFixed(0)} conn/s
                </span>
              ) : (
                Number.isFinite(metric?.calls) && <span>{(metric?.calls ?? 0).toFixed(0)}/s</span>
              )}
            </div>
          </div>
        ) : (
          readouts.length > 0 && (
            <dl className="mt-1 space-y-0.5">
              {readouts.map((p) => (
                <div key={p.key} className="flex justify-between gap-3 font-mono text-[10px]">
                  <dt className="text-neutral-500">{p.label}</dt>
                  <dd className="text-neutral-300">
                    {String(node.config[p.key] ?? p.default)}
                    {p.unit ? ` ${p.unit}` : ""}
                  </dd>
                </div>
              ))}
            </dl>
          )
        )}
      </div>
    </div>
  );
}
