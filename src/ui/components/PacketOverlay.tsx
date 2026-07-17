// Packet animation overlay: aliveness is data, not animation. Every dot is a real
// edge traversal the engine emitted: amber = request (forward), green = response
// (return), red = failed. Position is interpolated from the segment's [start,end]
// against the playback clock; nothing moves unless a simulated packet is in flight.
// With the ambient glow on, packets grow a short trail + soft bloom (congestion
// reads where they cluster) and the critical path's packets are emphasized.
import { useViewport } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import { criticalPath, legKey, slowestRequest } from "@/ui/analysis";
import { useSystemStore } from "@/ui/store/systemStore";
import { useSimStore } from "@/ui/store/simStore";
import { useLayoutStore } from "@/ui/store/layoutStore";

const NODE_W = 150;
const NODE_H = 64;

export function PacketOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const vp = useViewport();
  const result = useSimStore((s) => s.result);
  const clockMs = useSimStore((s) => s.clockMs);
  const selectedReq = useSimStore((s) => s.selectedReq);
  const nodes = useSystemStore((s) => s.doc?.graph.nodes);
  const glow = useLayoutStore((s) => s.glow);

  // Legs on the highlighted request's critical path (either direction), for
  // packet emphasis. Only computed when the glow layer is on.
  const criticalLegs = useMemo(() => {
    if (!glow || !result) return null;
    const req = selectedReq ?? slowestRequest(result.spans);
    return req === null
      ? new Set<string>()
      : criticalPath(result.spans, req).legs;
  }, [glow, result, selectedReq]);

  useEffect(() => {
    const cv = canvas.current;
    const el = box.current;
    if (!cv || !el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!result || !nodes) return;

    const pos = new Map(nodes.map((n) => [n.id, n.position]));
    const center = (id: string) => {
      const p = pos.get(id);
      if (!p) return null;
      return {
        x: (p.x + NODE_W / 2) * vp.zoom + vp.x,
        y: (p.y + NODE_H / 2) * vp.zoom + vp.y,
      };
    };
    const onCritical = (from: string, to: string) =>
      !!criticalLegs &&
      (criticalLegs.has(legKey(from, to)) ||
        criticalLegs.has(legKey(to, from)));

    for (const seg of result.segments) {
      if (clockMs < seg.start || clockMs > seg.end) continue;
      const a = center(seg.from);
      const b = center(seg.to);
      if (!a || !b) continue;
      const t =
        seg.end > seg.start ? (clockMs - seg.start) / (seg.end - seg.start) : 1;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const focused = selectedReq === null || selectedReq === seg.req;
      const color = seg.error ? "#f87171" : seg.request ? "#f5b301" : "#34d399";
      const crit = glow && onCritical(seg.from, seg.to);

      if (glow) {
        // A short trail behind the dot, along the segment.
        const t0 = Math.max(0, t - 0.14);
        ctx.globalAlpha = focused ? 0.32 : 0.05;
        ctx.strokeStyle = color;
        ctx.lineWidth = crit ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0);
        ctx.lineTo(x, y);
        ctx.stroke();
        // Soft bloom: overlapping packets brighten, reading as congestion.
        ctx.shadowColor = color;
        ctx.shadowBlur = crit ? 11 : 6;
      }

      ctx.globalAlpha = focused ? 1 : 0.12;
      ctx.beginPath();
      ctx.arc(
        x,
        y,
        (selectedReq === seg.req ? 5 : 3) + (crit ? 1 : 0),
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }, [result, clockMs, selectedReq, nodes, vp, glow, criticalLegs]);

  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-10">
      <canvas ref={canvas} className="h-full w-full" />
    </div>
  );
}
