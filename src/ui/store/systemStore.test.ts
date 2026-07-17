import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DexieSystemRepository } from "@/document";
import type { KeyValueStore } from "./repository";
import { makeSystemStore } from "./systemStore";

const memStorage = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

let repo: DexieSystemRepository;
let storage: KeyValueStore;

beforeEach(() => {
  repo = new DexieSystemRepository(`store-${Math.random()}`);
  storage = memStorage();
});
afterEach(async () => {
  await repo.destroy();
});

const freshStore = () => makeSystemStore({ repository: repo, storage });

describe("systemStore", () => {
  it("init creates a starter system when storage is empty", async () => {
    const store = freshStore();
    await store.getState().init();
    expect(store.getState().ready).toBe(true);
    expect(store.getState().doc?.name).toBe("Untitled System");
    expect(store.getState().systems).toHaveLength(1);
  });

  it("edits survive an app reload (new store over the same repo+storage)", async () => {
    const a = freshStore();
    await a.getState().init();
    a.getState().placeNode("api", { x: 0, y: 0 });
    a.getState().placeNode("redis", { x: 200, y: 0 });
    const [apiId, redisId] = a.getState().doc!.graph.nodes.map((n) => n.id);
    a.getState().connect(apiId, redisId);
    a.getState().setNodeConfig(apiId, { concurrency: 16 });
    await a.getState().flush();

    // "Reload the app": a brand-new store reading the same persisted state.
    const b = freshStore();
    await b.getState().init();
    const doc = b.getState().doc!;
    expect(doc.graph.nodes).toHaveLength(2);
    expect(doc.graph.edges).toHaveLength(1);
    expect(doc.graph.nodes.find((n) => n.id === apiId)!.config.concurrency).toBe(16);
  });

  it("manages multiple systems and deletes them", async () => {
    const store = freshStore();
    await store.getState().init(); // starter #1
    await store.getState().newSystem("Second");
    await store.getState().newSystem("Third");
    expect(store.getState().systems).toHaveLength(3);

    const thirdId = store.getState().doc!.id;
    await store.getState().deleteSystem(thirdId);
    expect(store.getState().systems).toHaveLength(2);
    // current switched to a remaining system
    expect(store.getState().doc!.id).not.toBe(thirdId);
  });

  it("removeSelected deletes the selected node and its edges", async () => {
    const store = freshStore();
    await store.getState().init();
    store.getState().placeNode("client", { x: 0, y: 0 });
    store.getState().placeNode("api", { x: 200, y: 0 });
    const [c, api] = store.getState().doc!.graph.nodes.map((n) => n.id);
    store.getState().connect(c, api);
    store.getState().select({ kind: "node", id: api });
    store.getState().removeSelected();
    const doc = store.getState().doc!;
    expect(doc.graph.nodes).toHaveLength(1);
    expect(doc.graph.edges).toHaveLength(0);
    expect(store.getState().selection).toBeNull();
  });

  it("export → import round trips through the store", async () => {
    const a = freshStore();
    await a.getState().init();
    a.getState().placeNode("postgres", { x: 0, y: 0 });
    await a.getState().flush();
    const text = a.getState().exportText()!;

    const b = freshStore();
    await b.getState().init();
    await b.getState().importText(text);
    expect(b.getState().doc!.graph.nodes[0].type).toBe("postgres");
  });
});
