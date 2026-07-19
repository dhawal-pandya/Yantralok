// The editor store: document state, kept separate from view state.
// Thin glue over the tested document ops + the SystemRepository seam. Built as a
// factory so it can be driven headlessly in tests with an injected repo/storage.
import type { EdgeChange, NodeChange } from "@xyflow/react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  type NodeConfig,
} from "@/components";
import {
  addEdge,
  addIntervention,
  addNode,
  createDocument,
  moveNode,
  removeEdge,
  removeIntervention,
  removeNode,
  renameSystem,
  serializeDocument,
  touch,
  updateIntervention,
  updateEdgeConfig,
  updateNodeConfig,
  type EdgeHandles,
  type Point,
  type SystemDoc,
  type SystemMeta,
  type SystemRepository,
} from "@/document";
import type { Intervention } from "@/schema";
import {
  browserStorage,
  repository as defaultRepository,
  type KeyValueStore,
} from "./repository";

const LAST_OPENED_KEY = "yantralok:lastOpenedId";
const PERSIST_DEBOUNCE_MS = 400;

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

export type SaveStatus = "saving" | "saved" | "error";

export interface SystemState {
  doc: SystemDoc | null;
  systems: SystemMeta[];
  selection: Selection;
  status: SaveStatus;
  ready: boolean;

  // lifecycle / system management
  init(): Promise<void>;
  newSystem(name?: string): Promise<void>;
  openSystem(id: string): Promise<void>;
  deleteSystem(id: string): Promise<void>;
  rename(name: string): void;
  flush(): Promise<void>;

  // graph editing (canvas)
  placeNode(type: string, position: Point): void;
  onNodesChange(changes: NodeChange[]): void;
  onEdgesChange(changes: EdgeChange[]): void;
  connect(source: string, target: string, handles?: EdgeHandles): void;
  setNodeConfig(id: string, patch: NodeConfig): void;
  setEdgeConfig(id: string, patch: NodeConfig): void;
  addIntervention(intervention: Omit<Intervention, "id">): void;
  updateIntervention(id: string, patch: Partial<Omit<Intervention, "id">>): void;
  removeIntervention(id: string): void;
  removeSelected(): void;

  // selection (view state)
  select(selection: Selection): void;

  // import / export
  exportText(): string | null;
  importText(text: string): Promise<void>;
}

export function makeSystemStore(deps?: {
  repository?: SystemRepository;
  storage?: KeyValueStore;
}): UseBoundStore<StoreApi<SystemState>> {
  const repo = deps?.repository ?? defaultRepository;
  const storage = deps?.storage ?? browserStorage;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return create<SystemState>()((set, get) => {
    const refreshList = async () => set({ systems: await repo.list() });

    const schedulePersist = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void get().flush(), PERSIST_DEBOUNCE_MS);
    };

    // Apply a pure doc transform, reflect it, and schedule a save.
    const apply = (fn: (doc: SystemDoc) => SystemDoc, selection?: Selection) => {
      const { doc } = get();
      if (!doc) return;
      const next = fn(doc);
      set(selection !== undefined ? { doc: next, selection } : { doc: next });
      schedulePersist();
    };

    return {
      doc: null,
      systems: [],
      selection: null,
      status: "saved", // never shown before init() runs; the app renders "Loading…" until ready
      ready: false,

      async init() {
        const systems = await repo.list();
        const lastId = storage.get(LAST_OPENED_KEY);
        let doc: SystemDoc | null = null;
        if (lastId && systems.some((s) => s.id === lastId)) {
          doc = await repo.load(lastId);
        } else if (systems.length > 0) {
          doc = await repo.load(systems[0].id);
        }
        if (!doc) {
          doc = createDocument({ name: "Untitled System" });
          await repo.save(doc);
        }
        storage.set(LAST_OPENED_KEY, doc.id);
        set({
          doc,
          systems: await repo.list(),
          selection: null,
          status: "saved",
          ready: true,
        });
      },

      async newSystem(name = "Untitled System") {
        const doc = createDocument({ name });
        await repo.save(doc);
        storage.set(LAST_OPENED_KEY, doc.id);
        set({ doc, selection: null, status: "saved" });
        await refreshList();
      },

      async openSystem(id) {
        const doc = await repo.load(id);
        storage.set(LAST_OPENED_KEY, id);
        set({ doc, selection: null, status: "saved" });
      },

      async deleteSystem(id) {
        await repo.delete(id);
        await refreshList();
        if (get().doc?.id === id) {
          const remaining = get().systems;
          if (remaining.length > 0) await get().openSystem(remaining[0].id);
          else await get().newSystem();
        }
      },

      rename(name) {
        apply((d) => renameSystem(d, name));
      },

      async flush() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const { doc } = get();
        if (!doc) return;
        set({ status: "saving" });
        try {
          const stamped = touch(doc);
          await repo.save(stamped);
          set({ doc: stamped, status: "saved" });
          await refreshList();
        } catch {
          set({ status: "error" });
        }
      },

      placeNode(type, position) {
        const { doc } = get();
        if (!doc) return;
        const next = addNode(doc, type, position);
        const created = next.graph.nodes[next.graph.nodes.length - 1];
        set({ doc: next, selection: { kind: "node", id: created.id } });
        schedulePersist();
      },

      onNodesChange(changes) {
        const { doc } = get();
        if (!doc) return;
        let next = doc;
        let selection = get().selection;
        for (const c of changes) {
          if (c.type === "position" && c.position) {
            next = moveNode(next, c.id, c.position);
          } else if (c.type === "remove") {
            next = removeNode(next, c.id);
            if (selection?.kind === "node" && selection.id === c.id) selection = null;
          }
        }
        if (next !== doc) {
          set({ doc: next, selection });
          schedulePersist();
        }
      },

      onEdgesChange(changes) {
        const { doc } = get();
        if (!doc) return;
        let next = doc;
        let selection = get().selection;
        for (const c of changes) {
          if (c.type === "remove") {
            next = removeEdge(next, c.id);
            if (selection?.kind === "edge" && selection.id === c.id) selection = null;
          }
        }
        if (next !== doc) {
          set({ doc: next, selection });
          schedulePersist();
        }
      },

      connect(source, target, handles) {
        apply((d) => addEdge(d, source, target, undefined, handles));
      },

      setNodeConfig(id, patch) {
        apply((d) => updateNodeConfig(d, id, patch));
      },

      setEdgeConfig(id, patch) {
        apply((d) => updateEdgeConfig(d, id, patch));
      },

      addIntervention(intervention) {
        apply((d) => addIntervention(d, intervention));
      },

      updateIntervention(id, patch) {
        apply((d) => updateIntervention(d, id, patch));
      },

      removeIntervention(id) {
        apply((d) => removeIntervention(d, id));
      },

      removeSelected() {
        const sel = get().selection;
        if (!sel) return;
        apply(
          (d) => (sel.kind === "node" ? removeNode(d, sel.id) : removeEdge(d, sel.id)),
          null,
        );
      },

      select(selection) {
        set({ selection });
      },

      exportText() {
        const { doc } = get();
        return doc ? serializeDocument(doc) : null;
      },

      async importText(text) {
        const doc = await repo.importFile(text);
        storage.set(LAST_OPENED_KEY, doc.id);
        set({ doc, selection: null, status: "saved" });
        await refreshList();
      },
    };
  });
}

/** The app-wide store instance (browser repo + localStorage). */
export const useSystemStore = makeSystemStore();
