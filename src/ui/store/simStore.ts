// Engine RUNTIME state: derived, never persisted. A "Run" compiles the current
// document, simulates to a horizon via the SimulationHost, and the UI plays the
// result back on a logical clock. Running (compute) and playback (transport) are
// kept SEPARATE: editing the graph/load/horizon makes the current result "stale"
// until you Re-run; nothing re-simulates on its own (that was the freeze: a full
// sim on every load-slider tick).
import { create } from "zustand";
import { compileScenario } from "@/components";
import { MainThreadHost, type RunResult, type WindowMetrics } from "@/engine";
import type { SystemDoc } from "@/schema";
import { useSystemStore } from "./systemStore";

const host = new MainThreadHost();

export const SPEEDS = [0.01, 0.1, 1, 2, 4, 8] as const;
/** Selectable simulation lengths, in seconds. */
export const HORIZONS = [15, 30, 60, 120, 300] as const;
const DEFAULT_HORIZON_MS = 15_000;

// Keep the chart/window count bounded regardless of horizon so long runs stay snappy.
const sampleIntervalFor = (horizonMs: number) =>
  Math.max(100, Math.round(horizonMs / 600));

export interface SimRuntime {
  result: RunResult | null;
  baseline: RunResult | null; // the "branch without the kill" (no interventions)
  compare: boolean;
  error: string | null;
  playing: boolean;
  clockMs: number;
  speed: number;
  horizonMs: number;
  selectedReq: number | null;

  // What produced the current result, for detecting when it's out of date.
  lastRunDoc: SystemDoc | null;
  lastRunHorizon: number;

  run(): void;
  runCompare(): void;
  exitCompare(): void;
  clear(): void;
  play(): void;
  pause(): void;
  toggle(): void;
  reset(): void;
  seek(ms: number): void;
  setSpeed(x: number): void;
  setHorizon(ms: number): void;
  selectRequest(id: number | null): void;
  tick(realDtMs: number): void;
}

export const useSimStore = create<SimRuntime>()((set, get) => ({
  result: null,
  baseline: null,
  compare: false,
  error: null,
  playing: false,
  clockMs: 0,
  speed: 2,
  horizonMs: DEFAULT_HORIZON_MS,
  selectedReq: null,
  lastRunDoc: null,
  lastRunHorizon: DEFAULT_HORIZON_MS,

  run() {
    const doc = useSystemStore.getState().doc;
    if (!doc) return;
    try {
      const { horizonMs } = get();
      const scenario = compileScenario(doc);
      const result = host.run(scenario, {
        horizonMs,
        sampleIntervalMs: sampleIntervalFor(horizonMs),
      });
      set({
        result,
        baseline: null,
        compare: false,
        error: null,
        clockMs: 0,
        playing: true,
        selectedReq: null,
        lastRunDoc: doc,
        lastRunHorizon: horizonMs,
      });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Simulation failed",
        result: null,
      });
    }
  },

  // Branch the timeline: run the current scenario (with interventions) AND a
  // baseline with the interventions stripped, same seed, fully reproducible.
  runCompare() {
    const doc = useSystemStore.getState().doc;
    if (!doc) return;
    try {
      const { horizonMs } = get();
      const opts = {
        horizonMs,
        sampleIntervalMs: sampleIntervalFor(horizonMs),
      };
      const result = host.run(compileScenario(doc), opts);
      const baseline = host.run(
        compileScenario({ ...doc, interventions: [] }),
        opts,
      );
      set({
        result,
        baseline,
        compare: true,
        error: null,
        clockMs: 0,
        playing: true,
        selectedReq: null,
        lastRunDoc: doc,
        lastRunHorizon: horizonMs,
      });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Simulation failed",
        result: null,
      });
    }
  },

  // Leave compare mode without re-running: drop the baseline, keep the main run.
  exitCompare() {
    set({ compare: false, baseline: null });
  },

  clear() {
    set({
      result: null,
      baseline: null,
      compare: false,
      error: null,
      playing: false,
      clockMs: 0,
      selectedReq: null,
    });
  },

  play() {
    if (!get().result) return get().run();
    if (get().clockMs >= (get().result?.horizonMs ?? 0)) set({ clockMs: 0 });
    set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  toggle() {
    if (get().playing) get().pause();
    else get().play();
  },
  reset() {
    set({ clockMs: 0, playing: false });
  },

  seek(ms) {
    const max = get().result?.horizonMs ?? 0;
    set({ clockMs: Math.max(0, Math.min(ms, max)), playing: false });
  },
  setSpeed(x) {
    set({ speed: x });
  },
  setHorizon(ms) {
    set({ horizonMs: ms });
  },
  selectRequest(id) {
    set({ selectedReq: id });
  },

  tick(realDtMs) {
    const { playing, result, clockMs, speed } = get();
    if (!playing || !result) return;
    const next = clockMs + realDtMs * speed;
    if (next >= result.horizonMs)
      set({ clockMs: result.horizonMs, playing: false });
    else set({ clockMs: next });
  },
}));

/** True when the current result no longer matches the document / horizon. */
export function isRunStale(state: SimRuntime, doc: SystemDoc | null): boolean {
  if (!state.result) return false;
  return doc !== state.lastRunDoc || state.horizonMs !== state.lastRunHorizon;
}

/** Index of the sample window covering the current clock. */
export function currentWindowIndex(result: RunResult, clockMs: number): number {
  const i = Math.floor(clockMs / result.sampleIntervalMs);
  return Math.max(0, Math.min(i, result.windows.length - 1));
}

/** The metrics window at the current clock (or null if no run). */
export function windowAt(
  result: RunResult | null,
  clockMs: number,
): WindowMetrics | null {
  if (!result || result.windows.length === 0) return null;
  return result.windows[currentWindowIndex(result, clockMs)];
}
