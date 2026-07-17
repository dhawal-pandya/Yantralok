// Request inspector: list sampled requests; click one to select it (its packets
// light up on the canvas, others dim), jump the clock to its start, and read its
// life as a distributed-tracing WATERFALL, every hop split into network /
// queue-wait / service, with retries + timeouts labeled.
import { useMemo } from "react";
import { getComponent } from "@/components";
import type { TraceSpan } from "@/engine";
import { useSystemStore } from "@/ui/store/systemStore";
import { useSimStore } from "@/ui/store/simStore";

interface Lifecycle {
  req: number;
  start: number;
  end: number;
  hops: number;
  error: boolean;
}

const NET = "#64748b"; // network legs
const WAIT = "#f5b301"; // queue wait
const SERVICE = "#34d399"; // service (own work)
const FAIL = "#ef4444";

export function RequestsPanel() {
  const result = useSimStore((s) => s.result);
  const selectedReq = useSimStore((s) => s.selectedReq);
  const selectRequest = useSimStore((s) => s.selectRequest);
  const seek = useSimStore((s) => s.seek);
  const doc = useSystemStore((s) => s.doc);

  const label = (id: string) => {
    const node = doc?.graph.nodes.find((n) => n.id === id);
    return node ? (getComponent(node.type)?.label ?? id.slice(0, 4)) : id.slice(0, 4);
  };

  // The request list, derived from the span trace (falls back to nothing if a run
  // captured no spans). One row per request: total latency + hop count + status.
  const lifecycles = useMemo<Lifecycle[]>(() => {
    if (!result) return [];
    const byReq = new Map<number, Lifecycle>();
    for (const sp of result.spans) {
      let lc = byReq.get(sp.req);
      if (!lc) {
        lc = { req: sp.req, start: sp.issue, end: sp.end + sp.net, hops: 0, error: false };
        byReq.set(sp.req, lc);
      }
      lc.start = Math.min(lc.start, sp.issue);
      lc.end = Math.max(lc.end, sp.end + sp.net);
      lc.hops += 1;
      lc.error = lc.error || sp.error;
    }
    return [...byReq.values()].sort((a, b) => a.start - b.start).slice(0, 60);
  }, [result]);

  const spans = useMemo<TraceSpan[]>(() => {
    if (!result || selectedReq == null) return [];
    return result.spans
      .filter((s) => s.req === selectedReq)
      .sort((a, b) => a.issue - b.issue || a.depth - b.depth);
  }, [result, selectedReq]);

  if (!result) return null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden border-t border-neutral-800 bg-neutral-950">
      <h2 className="flex items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
        {selectedReq !== null ? `Request ${selectedReq}` : "Requests"}
        {selectedReq !== null && (
          <button className="text-neutral-500 hover:text-neutral-300" onClick={() => selectRequest(null)}>
            clear
          </button>
        )}
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedReq !== null && spans.length > 0 ? (
          <Waterfall spans={spans} label={label} />
        ) : (
          <ul className="px-1">
            {lifecycles.map((l) => (
              <li key={l.req}>
                <button
                  onClick={() => {
                    selectRequest(l.req);
                    seek(l.start);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[10px] hover:bg-neutral-900"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${l.error ? "bg-red-500" : "bg-emerald-500"}`} />
                  <span className="text-neutral-400">req {l.req}</span>
                  <span className="ml-auto text-neutral-300">{(l.end - l.start).toFixed(0)}ms</span>
                  <span className="text-neutral-600">{l.hops} hops</span>
                </button>
              </li>
            ))}
            {lifecycles.length === 0 && (
              <li className="px-2 py-3 text-[10px] text-neutral-600">No requests captured in this run.</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

function Waterfall({ spans, label }: { spans: TraceSpan[]; label: (id: string) => string }) {
  const t0 = Math.min(...spans.map((s) => s.issue));
  const t1 = Math.max(...spans.map((s) => s.end + s.net));
  const total = Math.max(1e-6, t1 - t0);
  const pct = (t: number) => `${((t - t0) / total) * 100}%`;
  const wid = (a: number, b: number) => `${(Math.max(0, b - a) / total) * 100}%`;

  return (
    <div className="px-2 py-1.5">
      <div className="mb-1.5 flex items-center gap-3 font-mono text-[10px] text-neutral-500">
        <span>total {total.toFixed(1)}ms</span>
        <span className="flex items-center gap-2">
          <Legend color={NET} name="network" />
          <Legend color={WAIT} name="queue" />
          <Legend color={SERVICE} name="service" />
        </span>
      </div>
      <ol className="space-y-0.5">
        {spans.map((s) => {
          const served = s.service >= 0;
          const svcStart = served ? s.service : s.admit;
          const wait = served ? s.service - s.admit : 0;
          const service = s.end - svcStart;
          const title =
            `${label(s.station)}: network ${(s.net * 2).toFixed(1)}ms · ` +
            `queue ${wait.toFixed(1)}ms · service ${service.toFixed(1)}ms` +
            (s.attempt > 0 ? ` · retry #${s.attempt}` : "") +
            (s.timedOut ? " · TIMED OUT" : "") +
            (s.error ? " · FAILED" : "");
          const svcColor = s.error ? FAIL : SERVICE;
          return (
            <li key={s.call} className="flex items-center gap-1.5" title={title}>
              <span
                className="flex w-24 shrink-0 items-center gap-1 truncate font-mono text-[10px] text-neutral-400"
                style={{ paddingLeft: Math.min(s.depth, 5) * 8 }}
              >
                <span className="truncate">{label(s.station)}</span>
                {s.attempt > 0 && <span className="text-amber-400">↻{s.attempt}</span>}
                {s.timedOut && <span className="text-amber-400">⏱</span>}
                {s.error && <span className="text-red-400">✕</span>}
              </span>
              <span className="relative h-3 flex-1 rounded-sm bg-neutral-900">
                {/* network-in */}
                <Bar left={pct(s.issue)} width={wid(s.issue, s.admit)} color={NET} />
                {/* queue wait */}
                {wait > 0 && <Bar left={pct(s.admit)} width={wid(s.admit, s.service)} color={WAIT} />}
                {/* service (own work + nested children live inside this window) */}
                <Bar left={pct(svcStart)} width={wid(svcStart, s.end)} color={svcColor} dashed={s.timedOut} />
                {/* network-out */}
                <Bar left={pct(s.end)} width={wid(s.end, s.end + s.net)} color={NET} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Bar({ left, width, color, dashed }: { left: string; width: string; color: string; dashed?: boolean }) {
  return (
    <span
      className="absolute top-1/2 h-2 -translate-y-1/2 rounded-sm"
      style={{
        left,
        width,
        backgroundColor: color,
        ...(dashed ? { outline: `1px dashed ${color}`, opacity: 0.7 } : {}),
      }}
    />
  );
}

function Legend({ color, name }: { color: string; name: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
