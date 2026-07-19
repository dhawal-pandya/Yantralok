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
export type Panel = "palette" | "inspector" | "charts" | "requests";
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
  showRequests: boolean; // request inspector; off by default so the inspector stays roomy
  glow: boolean; // ambient health lens; off by default (cosmetic, scales with size)
  glowSignal: GlowSignal;
  tourSeen: boolean; // the guided tour shows exactly once, ever
  guideSeen: boolean; // the ? guide pulses until it's opened once
  activationDone: boolean; // the first-run coach (run/break/measure) is done or skipped
}

export interface LayoutState extends Persisted {
  enteredApp: boolean; // session-only: hero shows on every load
  tourOpen: boolean; // session-only: the guided tour is currently showing
  resize(dim: Dim, deltaPx: number): void;
  togglePanel(panel: Panel): void;
  toggleGlow(): void;
  setGlowSignal(signal: GlowSignal): void;
  markTourSeen(): void;
  markGuideSeen(): void;
  openTour(): void;
  closeTour(): void;
  completeActivation(): void;
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
  showRequests: false,
  glow: false,
  glowSignal: "load",
  tourSeen: false,
  guideSeen: false,
  activationDone: false,
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
      showRequests: s.showRequests ?? DEFAULTS.showRequests,
      glow: s.glow ?? (mode !== undefined ? mode !== "off" : DEFAULTS.glow),
      glowSignal: GLOW_SIGNALS.includes(s.glowSignal as GlowSignal)
        ? (s.glowSignal as GlowSignal)
        : GLOW_SIGNALS.includes(mode as GlowSignal)
          ? (mode as GlowSignal)
          : DEFAULTS.glowSignal,
      tourSeen: s.tourSeen ?? DEFAULTS.tourSeen,
      guideSeen: s.guideSeen ?? DEFAULTS.guideSeen,
      activationDone: s.activationDone ?? DEFAULTS.activationDone,
    };
  } catch {
    return DEFAULTS;
  }
}

export const useLayoutStore = create<LayoutState>()((set, get) => {
  const initial = load();
  const persist = () => {
    const {
      paletteWidth,
      inspectorWidth,
      chartsHeight,
      requestsHeight,
      showPalette,
      showInspector,
      showCharts,
      showRequests,
      glow,
      glowSignal,
      tourSeen,
      guideSeen,
      activationDone,
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
          showRequests,
          glow,
          glowSignal,
          tourSeen,
          guideSeen,
          activationDone,
        }),
      );
    } catch {
      // storage unavailable (private mode); still works in-session.
    }
  };

  return {
    ...initial,
    enteredApp: false,
    // The first-run coach is the activation path now; the tour is opt-in (Guide).
    tourOpen: false,
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
            : panel === "requests"
              ? {
                  showRequests: !s.showRequests,
                  // Requests live in the inspector column; opening them opens the inspector too.
                  showInspector: s.showRequests ? s.showInspector : true,
                }
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
    openTour() {
      set({ tourOpen: true });
    },
    closeTour() {
      set({ tourOpen: false });
      get().markTourSeen();
    },
    completeActivation() {
      if (get().activationDone) return;
      set({ activationDone: true });
      persist();
    },
    enterApp() {
      set({ enteredApp: true });
    },
  };
});
