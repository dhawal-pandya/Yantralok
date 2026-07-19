// The design surface. React Flow bound to the document store: the store is the
// source of truth; the canvas renders it and reports edits back. No simulation
// here; this is purely "design the system".
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useMemo } from "react";
import { getComponent } from "@/components";
import { useSystemStore } from "@/ui/store/systemStore";
import { currentWindowIndex, useSimStore } from "@/ui/store/simStore";
import { useLayoutStore } from "@/ui/store/layoutStore";
import {
  criticalPath,
  edgeLatency,
  latencyContribution,
  legKey,
  slowestRequest,
} from "@/ui/analysis";
import { rgb, healthColor } from "@/ui/glow";
import { estimateCost } from "@/components";
import {
  SystemNode,
  type LiveMetric,
  type NodeGlow,
  type SystemFlowNode,
} from "./SystemNode";
import { PacketOverlay } from "./PacketOverlay";

const nodeTypes = { system: SystemNode };

export function Canvas() {
  const doc = useSystemStore((s) => s.doc);
  const selection = useSystemStore((s) => s.selection);
  const onNodesChange = useSystemStore((s) => s.onNodesChange);
  const onEdgesChange = useSystemStore((s) => s.onEdgesChange);
  const connect = useSystemStore((s) => s.connect);
  const select = useSystemStore((s) => s.select);
  const placeNode = useSystemStore((s) => s.placeNode);

  // Drag a palette component onto the canvas: drop it at the cursor (converted to
  // flow coordinates), positioned so the node centers under where you let go.
  const { screenToFlowPosition } = useReactFlow();
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("application/yantralok");
      if (!type) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      placeNode(type, { x: p.x - 75, y: p.y - 32 });
    },
    [screenToFlowPosition, placeNode],
  );

  // Live metrics: subscribe to the sample INDEX (not the raw clock) so nodes
  // re-render at sample cadence, not 60fps; the overlay handles per-frame motion.
  const result = useSimStore((s) => s.result);
  const idx = useSimStore((s) =>
    s.result ? currentWindowIndex(s.result, s.clockMs) : -1,
  );

  // Ambient legibility layer (opt-in, off by default). All whole-run aggregates,
  // derived once per result; the live ρ glow still updates at sample cadence.
  const glowOn = useLayoutStore((s) => s.glow);
  const glowSignal = useLayoutStore((s) => s.glowSignal);
  const selectedReq = useSimStore((s) => s.selectedReq);
  const lastRunDoc = useSimStore((s) => s.lastRunDoc);

  const glowLayer = useMemo(() => {
    if (!glowOn || !result) return null;
    const req = selectedReq ?? slowestRequest(result.spans);
    const path =
      req === null
        ? { stations: new Set<string>(), legs: new Set<string>() }
        : criticalPath(result.spans, req);
    const edgeLat = edgeLatency(result.spans);
    const contribution = latencyContribution(result.spans);
    const latMax = Math.max(1e-6, ...contribution.values());
    const edgeMax = Math.max(1e-6, ...edgeLat.values());
    return {
      path,
      edgeLat,
      edgeMax,
      contribution,
      latMax,
      focused: selectedReq !== null,
    };
  }, [glowOn, result, selectedReq]);

  // Cost heat for the $ lens: each billed node's share of the estimated hourly
  // bill. Sources and free tiers carry no entry, so they stay untinted.
  const costLayer = useMemo(() => {
    if (!glowOn || glowSignal !== "cost" || !result || !lastRunDoc) return null;
    const byId = new Map(
      estimateCost(lastRunDoc, result).nodes.map((n) => [n.id, n.hourly]),
    );
    return { byId, max: Math.max(1e-6, ...byId.values()) };
  }, [glowOn, glowSignal, result, lastRunDoc]);

  const metricById = useMemo(() => {
    const m = new Map<string, LiveMetric>();
    if (result && idx >= 0) {
      const w = result.windows[idx];
      const now = result.times[idx];
      // A node reads as down if a kill or partition precedes `now` with no later
      // restart (a partition is unreachable, not crashed, but it's off the graph).
      const dead = new Set<string>();
      for (const iv of [...(doc?.interventions ?? [])].sort(
        (a, b) => a.atLogicalTime - b.atLogicalTime,
      )) {
        if (iv.atLogicalTime > now) break;
        if (iv.shard !== undefined) continue; // shard-scoped: one cell down, node stays up
        if (iv.kind === "kill" || iv.kind === "partition") dead.add(iv.target);
        else if (iv.kind === "restart") dead.delete(iv.target);
      }
      for (const st of w.stations) {
        m.set(st.id, {
          utilization: st.utilization,
          queue: st.queue,
          bottleneck: st.id === w.bottleneck,
          dead: dead.has(st.id),
          hitRate: st.hitRate,
          calls: st.calls,
          instances: st.instances,
          staleRate: st.staleRate,
          backlog: st.backlog,
          newConns: st.newConns,
        });
      }
    }
    return m;
  }, [result, idx, doc?.interventions]);

  const nodes = useMemo<SystemFlowNode[]>(
    () =>
      (doc?.graph.nodes ?? []).map((n) => {
        let glow: NodeGlow | undefined;
        if (glowLayer) {
          const onCritical = glowLayer.path.stations.has(n.id);
          if (glowSignal === "cost") {
            // Money, not motion: no critical-path ring on the $ lens.
            const c = costLayer?.byId.get(n.id);
            if (c !== undefined)
              glow = { t: c / costLayer!.max, onCritical: false };
          } else if (glowSignal === "latency") {
            const ms = glowLayer.contribution.get(n.id);
            if (ms !== undefined)
              glow = { t: ms / glowLayer.latMax, onCritical };
          } else {
            const m = metricById.get(n.id);
            if (m && Number.isFinite(m.utilization))
              glow = { t: Math.max(0, Math.min(1, m.utilization)), onCritical };
          }
        }
        return {
          id: n.id,
          type: "system" as const,
          position: n.position,
          data: {
            node: n,
            def: getComponent(n.type),
            metric: metricById.get(n.id),
            glow,
          },
          selected: selection?.kind === "node" && selection.id === n.id,
        };
      }),
    [doc, selection, metricById, glowLayer, glowSignal, costLayer],
  );

  const edges = useMemo<Edge[]>(
    () =>
      (doc?.graph.edges ?? []).map((e) => {
        const edge: Edge = {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          selected: selection?.kind === "edge" && selection.id === e.id,
          label:
            typeof e.config.latency === "number"
              ? `${e.config.latency}ms`
              : undefined,
        };
        if (!glowLayer || glowSignal === "cost") return edge;
        const key = legKey(e.source, e.target);
        const lat = glowLayer.edgeLat.get(key);
        const onCritical = glowLayer.path.legs.has(key);
        if (lat === undefined && !onCritical) return edge; // untraversed leg: leave default
        const frac = lat === undefined ? 0 : lat / glowLayer.edgeMax;
        edge.style = {
          stroke: rgb(healthColor(frac)),
          strokeWidth: onCritical ? 2.5 : 1.5,
          opacity: glowLayer.focused && !onCritical ? 0.25 : 1,
        };
        return edge;
      }),
    [doc, selection, glowLayer, glowSignal],
  );

  return (
    <div
      className="relative h-full w-full"
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(c: NodeChange[]) => onNodesChange(c)}
        onEdgesChange={(c: EdgeChange[]) => onEdgesChange(c)}
        onConnect={(c: Connection) =>
          c.source &&
          c.target &&
          connect(c.source, c.target, {
            sourceHandle: c.sourceHandle ?? undefined,
            targetHandle: c.targetHandle ?? undefined,
          })
        }
        onNodeClick={(_, n) => select({ kind: "node", id: n.id })}
        onEdgeClick={(_, e) => select({ kind: "edge", id: e.id })}
        onPaneClick={() => select(null)}
        deleteKeyCode={["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.35, maxZoom: 0.85 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="#313a49"
        />
        <Controls className="shadow-none!" />
        <PacketOverlay />
      </ReactFlow>
    </div>
  );
}
