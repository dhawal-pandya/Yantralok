// Pure editing operations on a SystemDoc graph. Each returns a NEW document (no
// mutation) so the UI store can swap state and persist. Component defaults come
// from @/components (an allowed inward dependency: document to components).
import { defaultChannelConfig, defaultConfig, type NodeConfig } from "@/components";
import type { Intervention, SystemDoc, SystemEdge, SystemNode } from "@/schema";

const newId = (): string => crypto.randomUUID();

export interface Point {
  x: number;
  y: number;
}

export function addNode(
  doc: SystemDoc,
  type: string,
  position: Point,
  id: string = newId(),
): SystemDoc {
  const node: SystemNode = { id, type, position, config: defaultConfig(type) };
  return { ...doc, graph: { ...doc.graph, nodes: [...doc.graph.nodes, node] } };
}

export function removeNode(doc: SystemDoc, id: string): SystemDoc {
  return {
    ...doc,
    graph: {
      nodes: doc.graph.nodes.filter((n) => n.id !== id),
      // drop dangling edges
      edges: doc.graph.edges.filter((e) => e.source !== id && e.target !== id),
    },
  };
}

export function moveNode(doc: SystemDoc, id: string, position: Point): SystemDoc {
  return {
    ...doc,
    graph: {
      ...doc.graph,
      nodes: doc.graph.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
    },
  };
}

export function updateNodeConfig(
  doc: SystemDoc,
  id: string,
  patch: NodeConfig,
): SystemDoc {
  return {
    ...doc,
    graph: {
      ...doc.graph,
      nodes: doc.graph.nodes.map((n) =>
        n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
      ),
    },
  };
}

/** Chosen ports for a connection; presentation only. */
export interface EdgeHandles {
  sourceHandle?: string;
  targetHandle?: string;
}

/** Add an edge unless it would be a self-loop or a duplicate of an existing one. */
export function addEdge(
  doc: SystemDoc,
  source: string,
  target: string,
  id: string = newId(),
  handles?: EdgeHandles,
): SystemDoc {
  if (source === target) return doc;
  const exists = doc.graph.edges.some((e) => e.source === source && e.target === target);
  if (exists) return doc;
  const edge: SystemEdge = {
    id,
    source,
    target,
    ...(handles?.sourceHandle ? { sourceHandle: handles.sourceHandle } : {}),
    ...(handles?.targetHandle ? { targetHandle: handles.targetHandle } : {}),
    config: defaultChannelConfig(),
  };
  return { ...doc, graph: { ...doc.graph, edges: [...doc.graph.edges, edge] } };
}

export function removeEdge(doc: SystemDoc, id: string): SystemDoc {
  return {
    ...doc,
    graph: { ...doc.graph, edges: doc.graph.edges.filter((e) => e.id !== id) },
  };
}

export function updateEdgeConfig(
  doc: SystemDoc,
  id: string,
  patch: NodeConfig,
): SystemDoc {
  return {
    ...doc,
    graph: {
      ...doc.graph,
      edges: doc.graph.edges.map((e) =>
        e.id === id ? { ...e, config: { ...e.config, ...patch } } : e,
      ),
    },
  };
}

export function renameSystem(doc: SystemDoc, name: string): SystemDoc {
  return { ...doc, name };
}

/** Add a failure injection at a logical time. Part of the reproducible run
 * definition, persisted with the document. */
export function addIntervention(
  doc: SystemDoc,
  intervention: Omit<Intervention, "id"> & { id?: string },
): SystemDoc {
  const iv: Intervention = { ...intervention, id: intervention.id ?? newId() };
  return {
    ...doc,
    interventions: [...doc.interventions, iv].sort((a, b) => a.atLogicalTime - b.atLogicalTime),
  };
}

export function removeIntervention(doc: SystemDoc, id: string): SystemDoc {
  return { ...doc, interventions: doc.interventions.filter((i) => i.id !== id) };
}

/** Edit an intervention (e.g. its time or delay param); re-sorts by time. */
export function updateIntervention(
  doc: SystemDoc,
  id: string,
  patch: Partial<Omit<Intervention, "id">>,
): SystemDoc {
  return {
    ...doc,
    interventions: doc.interventions
      .map((i) => (i.id === id ? { ...i, ...patch } : i))
      .sort((a, b) => a.atLogicalTime - b.atLogicalTime),
  };
}

/** Stamp updatedAt to now. Called by the store at persist time (UI layer). */
export function touch(doc: SystemDoc): SystemDoc {
  return { ...doc, updatedAt: new Date().toISOString() };
}
