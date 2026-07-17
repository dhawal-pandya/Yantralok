// Minimal uPlot wrapper. Created once; data is pushed on each clock
// tick via setData (streaming). Fills its container (height is user-resizable) and
// shows a hover readout of every series' value + meaning at the cursor.
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useEffect, useRef } from "react";
import { Tip } from "./Tooltip";

export interface ChartSeries {
  label: string;
  stroke: string;
  data: (number | null)[];
  unit?: string;
}

const axis = {
  stroke: "#71717a",
  grid: { stroke: "#27272a", width: 1 },
  ticks: { stroke: "#3f3f46", width: 1 },
  font: "10px ui-monospace, monospace",
  size: 34,
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function Chart({
  title,
  hint,
  x,
  series,
  xRange,
  height = 120,
}: {
  title: string;
  hint?: string;
  x: number[];
  series: ChartSeries[];
  xRange?: [number, number];
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const latest = useRef({ x, series });
  latest.current = { x, series };

  useEffect(() => {
    if (!el.current) return;

    const showTip = (u: uPlot) => {
      const t = tip.current;
      if (!t) return;
      const idx = u.cursor.idx;
      const left = u.cursor.left ?? -1;
      if (idx == null || left < 0) {
        t.style.display = "none";
        return;
      }
      const cur = latest.current;
      let html = `<div class="mb-0.5 text-neutral-500">t = ${cur.x[idx] ?? "-"}s</div>`;
      for (const s of cur.series) {
        const v = s.data[idx];
        const val = v == null ? "-" : `${v}${s.unit ?? ""}`;
        html +=
          `<div class="flex items-center gap-1.5">` +
          `<span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${s.stroke}"></span>` +
          `<span class="text-neutral-400">${esc(s.label)}</span>` +
          `<span class="ml-auto pl-3 text-neutral-100">${esc(val)}</span></div>`;
      }
      t.innerHTML = html;
      t.style.display = "block";
      // Place the readout beside the cursor, flipping to whichever side has room
      // rather than clamping it back over the crosshair. These charts are narrow,
      // so a naive clamp slides the box under the cursor and hides the value; the
      // flip keeps it clear. Prefer right-of / above the cursor.
      const top = u.cursor.top ?? 0;
      const pad = 14;
      const tw = t.offsetWidth;
      const th = t.offsetHeight;
      let x = left + pad;
      if (x + tw > u.width - 4) x = left - pad - tw; // no room to the right → flip left
      x = Math.max(4, Math.min(x, u.width - tw - 4));
      let y = top - pad - th;
      if (y < 2) y = top + pad; // no room above → flip below
      y = Math.max(2, Math.min(y, u.height - th - 2));
      t.style.left = `${x}px`;
      t.style.top = `${y}px`;
    };

    const opts: uPlot.Options = {
      width: el.current.clientWidth || 300,
      height: el.current.clientHeight || height,
      legend: { show: false },
      cursor: { show: true, y: false },
      scales: { x: { time: false, ...(xRange ? { range: xRange } : {}) } },
      axes: [
        { ...axis, values: (_u, vals) => vals.map((v) => `${v}s`) },
        { ...axis },
      ],
      series: [
        {},
        ...latest.current.series.map((s) => ({
          label: s.label,
          stroke: s.stroke,
          width: 1.5,
          points: { show: false },
        })),
      ],
      hooks: { setCursor: [showTip] },
    };
    const data = [latest.current.x, ...latest.current.series.map((s) => s.data)];
    plot.current = new uPlot(opts, data as uPlot.AlignedData, el.current);

    const ro = new ResizeObserver(() => {
      if (el.current) {
        plot.current?.setSize({
          width: el.current.clientWidth || 300,
          height: el.current.clientHeight || height,
        });
      }
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [height]); // created once; data flows via the effect below

  useEffect(() => {
    plot.current?.setData([x, ...series.map((s) => s.data)] as uPlot.AlignedData);
  }, [x, series]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="px-1 pb-0.5 text-[10px] text-neutral-400">
        <Tip label={hint} side="top">
          <span className={hint ? "cursor-help border-b border-dotted border-neutral-700" : undefined}>{title}</span>
        </Tip>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={el} className="h-full w-full" />
        <div
          ref={tip}
          style={{ display: "none" }}
          className="pointer-events-none absolute z-10 rounded border border-neutral-700 bg-neutral-900/95 px-2 py-1 font-mono text-[10px] shadow-xl"
        />
      </div>
    </div>
  );
}
