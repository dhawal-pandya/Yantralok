// The app's persistence wiring. Nothing else knows which SystemRepository impl is
// behind this seam. v1: local IndexedDB.
import { DexieSystemRepository, type SystemRepository } from "@/document";

export const repository: SystemRepository = new DexieSystemRepository();

/** Tiny key/value seam for "which system was open last". No-ops outside a
 * browser so the store module is importable in Node tests. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStorage: KeyValueStore = {
  get: (k) => (typeof localStorage === "undefined" ? null : localStorage.getItem(k)),
  set: (k, v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  },
};
