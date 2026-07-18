// TCO-style cost readout in the run bar: usage measured over the run window,
// priced against representative AWS on-demand rates, extrapolated as steady
// state. The chip shows $/month; clicking it opens the per-node breakdown.
import { useMemo, useState } from "react";
import { getComponent } from "@/components";
import {
  estimateCost,
  fmtUSD,
  HOURS_PER_DAY,
  HOURS_PER_MONTH,
  HOURS_PER_YEAR,
  type NodeCost,
} from "@/components";
import { useSimStore } from "@/ui/store/simStore";
import { Tip } from "./Tooltip";

const PERIODS = [
  { label: "hour", hours: 1 },
  { label: "day", hours: HOURS_PER_DAY },
  { label: "month", hours: HOURS_PER_MONTH },
  { label: "year", hours: HOURS_PER_YEAR },
] as const;

const labelOf = (n: NodeCost) => getComponent(n.type)?.label ?? n.type;

export function CostReadout() {
  const result = useSimStore((s) => s.result);
  const doc = useSimStore((s) => s.lastRunDoc);
  const [open, setOpen] = useState(false);

  // Estimated off the document the run was compiled from, so the price always
  // matches the usage that was actually measured.
  const est = useMemo(
    () => (result && doc ? estimateCost(doc, result) : null),
    [result, doc],
  );
  if (!est) return null;

  const seconds = Math.round(est.measuredMs / 1000);

  return (
    <span className="relative">
      <Tip
        label={`Estimated infrastructure cost: usage measured over this ${seconds}s run, priced at representative AWS on-demand rates and extrapolated as steady state. Click for the per-node breakdown.`}
        side="bottom"
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className={`rounded px-1 transition-colors ${open ? "bg-neutral-700 text-neutral-100" : "hover:text-neutral-100"}`}
        >
          <span className="text-neutral-600">cost </span>
          <span className="text-emerald-400">
            ≈{fmtUSD(est.hourly * HOURS_PER_MONTH)}/mo
          </span>
        </button>
      </Tip>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-md border border-neutral-700 bg-neutral-900 p-3 font-mono shadow-2xl">
            <div className="mb-2 font-sans text-xs font-semibold text-neutral-200">
              Estimated run cost
            </div>

            <div className="grid grid-cols-4 gap-px overflow-hidden rounded bg-neutral-800">
              {PERIODS.map((p) => (
                <div
                  key={p.label}
                  className="bg-neutral-850 px-2 py-1.5 text-center"
                >
                  <div className="text-[9px] text-neutral-500">/{p.label}</div>
                  <div className="text-[11px] text-emerald-400">
                    {fmtUSD(est.hourly * p.hours)}
                  </div>
                </div>
              ))}
            </div>

            {est.nonSteady.length > 0 && (
              <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1.5 font-sans text-[10px] leading-relaxed text-amber-400">
                Non-steady traffic: {est.nonSteady.join(", ")}. The month bills
                this exact window on repeat, so this prices the stress you
                designed. For a billing-grade estimate, run a typical steady
                window instead.
              </p>
            )}

            <div className="mt-2 max-h-56 overflow-y-auto">
              {est.nodes.map((n) => (
                <Tip
                  key={n.id}
                  label={`${n.basis}${n.reqPerSec > 0 ? ` · ${n.reqPerSec.toFixed(0)} req/s measured` : ""}`}
                  side="left"
                >
                  <div className="flex cursor-help items-baseline justify-between gap-2 py-0.5 text-[10px]">
                    <span className="truncate text-neutral-300">
                      {labelOf(n)}
                      {n.instances > 1 && (
                        <span className="text-neutral-500">
                          {" "}
                          ×
                          {n.instances % 1 === 0
                            ? n.instances
                            : n.instances.toFixed(1)}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-neutral-400">
                      {fmtUSD(n.hourly * HOURS_PER_MONTH)}/mo
                    </span>
                  </div>
                </Tip>
              ))}
              {est.nodes.length === 0 && (
                <div className="py-1 text-[10px] text-neutral-500">
                  Nothing billable: traffic sources are free.
                </div>
              )}
            </div>

            <p className="mt-2 border-t border-neutral-800 pt-2 font-sans text-[10px] leading-relaxed text-neutral-500">
              Usage from this {seconds}s run, extrapolated as steady state.
              Representative AWS on-demand rates; capacity knobs size the billed
              fleet. Traffic sources are free; NAT and cross-AZ transfer are not
              modeled.
            </p>
          </div>
        </>
      )}
    </span>
  );
}
