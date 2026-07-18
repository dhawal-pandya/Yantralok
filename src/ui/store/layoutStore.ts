// Editable panel sizes + visibility (persisted) plus a session-only "entered the
// app" flag. The welcome/hero shows on every load (enteredApp is NOT persisted);
// sizes + which panels are shown survive reloads.
import { create } from "zustand";

const KEY = "yantralok:layout";

export const LAYOUT_BOUNDS = {
  paletteWidth: { min: 160, max: 480 },
  inspectorWidth: { min: 240, max: 620 },
  chartsHeight: { min: 120, max: 520 },
  requestsHeight: { min: 120, max: 560 },
} as const;

type Dim = keyof typeof LAYOUT_BOUNDS;
export type Panel = "palette" | "inspector" | "charts";
/** Which signal drives the ambient glow when it's on: utilization ρ, latency share, or cost share. */
export type GlowSignal = "load" | "latency" | "cost";
export const GLOW_SIGNALS: readonly GlowSignal[] = ["load", "latency", "cost"];

interface Persisted {
  paletteWidth: number;
  inspectorWidth: number;
  chartsHeight: number;
  requestsHeight: number;
  showPalette: boolean;
  showInspector: boolean;
  showCharts: boolean;
  glow: boolean; // ambient health lens; off by default (cosmetic, scales with size)
  glowSignal: GlowSignal;
  tourSeen: boolean; // the guided tour shows exactly once, ever
  guideSeen: boolean; // the ? guide pulses until it's opened once
}

export interface LayoutState extends Persisted {
  enteredApp: boolean; // session-only: hero shows on every load
  resize(dim: Dim, deltaPx: number): void;
  togglePanel(panel: Panel): void;
  toggleGlow(): void;
  setGlowSignal(signal: GlowSignal): void;
  markTourSeen(): void;
  markGuideSeen(): void;
  enterApp(): void;
}

const DEFAULTS: Persisted = {
  paletteWidth: 224,
  inspectorWidth: 288,
  chartsHeight: 168,
  requestsHeight: 240,
  showPalette: true,
  showInspector: true,
  showCharts: true,
  glow: false,
  glowSignal: "load",
  tourSeen: false,
  guideSeen: false,
};

const clamp = (dim: Dim, v: number): number =>
  Math.max(LAYOUT_BOUNDS[dim].min, Math.min(LAYOUT_BOUNDS[dim].max, v));

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const s = JSON.parse(raw) as Partial<Persisted> & { glowMode?: string };
    // Migrate the interim single-mode shape back into glow + signal.
    const mode = s.glowMode;
    return {
      paletteWidth: clamp(
        "paletteWidth",
        s.paletteWidth ?? DEFAULTS.paletteWidth,
      ),
      inspectorWidth: clamp(
        "inspectorWidth",
        s.inspectorWidth ?? DEFAULTS.inspectorWidth,
      ),
      chartsHeight: clamp(
        "chartsHeight",
        s.chartsHeight ?? DEFAULTS.chartsHeight,
      ),
      requestsHeight: clamp(
        "requestsHeight",
        s.requestsHeight ?? DEFAULTS.requestsHeight,
      ),
      showPalette: s.showPalette ?? DEFAULTS.showPalette,
      showInspector: s.showInspector ?? DEFAULTS.showInspector,
      showCharts: s.showCharts ?? DEFAULTS.showCharts,
      glow: s.glow ?? (mode !== undefined ? mode !== "off" : DEFAULTS.glow),
      glowSignal: GLOW_SIGNALS.includes(s.glowSignal as GlowSignal)
        ? (s.glowSignal as GlowSignal)
        : GLOW_SIGNALS.includes(mode as GlowSignal)
          ? (mode as GlowSignal)
          : DEFAULTS.glowSignal,
      tourSeen: s.tourSeen ?? DEFAULTS.tourSeen,
      guideSeen: s.guideSeen ?? DEFAULTS.guideSeen,
    };
  } catch {
    return DEFAULTS;
  }
}

export const useLayoutStore = create<LayoutState>()((set, get) => {
  const persist = () => {
    const {
      paletteWidth,
      inspectorWidth,
      chartsHeight,
      requestsHeight,
      showPalette,
      showInspector,
      showCharts,
      glow,
      glowSignal,
      tourSeen,
      guideSeen,
    } = get();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          paletteWidth,
          inspectorWidth,
          chartsHeight,
          requestsHeight,
          showPalette,
          showInspector,
          showCharts,
          glow,
          glowSignal,
          tourSeen,
          guideSeen,
        }),
      );
    } catch {
      // storage unavailable (private mode); still works in-session.
    }
  };

  return {
    ...load(),
    enteredApp: false,
    resize(dim, deltaPx) {
      const next = clamp(dim, get()[dim] + deltaPx);
      if (next === get()[dim]) return;
      set({ [dim]: next } as Pick<LayoutState, Dim>);
      persist();
    },
    togglePanel(panel) {
      set((s) =>
        panel === "palette"
          ? { showPalette: !s.showPalette }
          : panel === "charts"
            ? { showCharts: !s.showCharts }
            : { showInspector: !s.showInspector },
      );
      persist();
    },
    toggleGlow() {
      set((s) => ({ glow: !s.glow }));
      persist();
    },
    setGlowSignal(signal) {
      if (get().glowSignal === signal) return;
      set({ glowSignal: signal });
      persist();
    },
    markTourSeen() {
      if (get().tourSeen) return;
      set({ tourSeen: true });
      persist();
    },
    markGuideSeen() {
      if (get().guideSeen) return;
      set({ guideSeen: true });
      persist();
    },
    enterApp() {
      set({ enteredApp: true });
    },
  };
});
