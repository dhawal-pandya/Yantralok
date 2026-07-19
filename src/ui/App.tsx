// App shell: the "engineering instrument" layout. Hero on first run, then system
// bar, run controls, palette, canvas, inspector, live charts, a timeline strip
// under the charts, and a footer. Panels are collapsible + resizable.
import * as Tooltip from "@radix-ui/react-tooltip";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import { FIRST_RUN_EXAMPLE_RAW } from "@/scenarios";
import { Canvas } from "./components/Canvas";
import { ChartsPanel } from "./components/ChartsPanel";
import { FirstRunCoach } from "./components/FirstRunCoach";
import { Hero } from "./components/Hero";
import { Inspector } from "./components/Inspector";
import { Palette } from "./components/Palette";
import { Readouts } from "./components/Readouts";
import { RequestsPanel } from "./components/RequestsPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { RunControls } from "./components/RunControls";
import { TimelineBar } from "./components/TimelineBar";
import { Toolbar } from "./components/Toolbar";
import { Tour } from "./components/Tour";
import { useLayoutStore } from "./store/layoutStore";
import { useSimStore } from "./store/simStore";
import { useSystemStore } from "./store/systemStore";

export function App() {
  const init = useSystemStore((s) => s.init);
  const ready = useSystemStore((s) => s.ready);
  const enteredApp = useLayoutStore((s) => s.enteredApp);
  const paletteWidth = useLayoutStore((s) => s.paletteWidth);
  const inspectorWidth = useLayoutStore((s) => s.inspectorWidth);
  const chartsHeight = useLayoutStore((s) => s.chartsHeight);
  const requestsHeight = useLayoutStore((s) => s.requestsHeight);
  const showPalette = useLayoutStore((s) => s.showPalette);
  const showInspector = useLayoutStore((s) => s.showInspector);
  const showCharts = useLayoutStore((s) => s.showCharts);
  const showRequests = useLayoutStore((s) => s.showRequests);
  const resize = useLayoutStore((s) => s.resize);
  // The requests panel only exists after a run; its handle appears with it.
  const hasResult = useSimStore((s) => s.result !== null);

  useEffect(() => {
    // A brand-new visitor lands in a pre-loaded fragile example, not a blank canvas.
    void init({ firstRunExample: FIRST_RUN_EXAMPLE_RAW });
  }, [init]);

  // Playback clock: a single rAF loop advances the sim clock; tick() is a no-op
  // when paused. Wall-clock time lives in the UI, never the engine.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      useSimStore.getState().tick(t - last);
      last = t;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Space toggles playback (CAD/DAW ergonomics) unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        useSimStore.getState().toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
        {!ready ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">Loading…</div>
        ) : !enteredApp ? (
          <Hero />
        ) : (
          <>
            <Toolbar />
            <RunControls />
            <div className="flex min-h-0 flex-1">
              {showPalette && (
                <>
                  <div style={{ width: paletteWidth }} className="shrink-0 overflow-hidden">
                    <Palette />
                  </div>
                  <ResizeHandle axis="x" title="Drag to resize the palette" onResize={(d) => resize("paletteWidth", d)} />
                </>
              )}
              <main className="min-w-0 flex-1">
                <ReactFlowProvider>
                  <Canvas />
                </ReactFlowProvider>
              </main>
              {showInspector && (
                <>
                  <ResizeHandle axis="x" title="Drag to resize the inspector" onResize={(d) => resize("inspectorWidth", -d)} />
                  <div style={{ width: inspectorWidth }} className="flex shrink-0 flex-col overflow-hidden border-l border-neutral-800">
                    <Inspector />
                    {hasResult && showRequests && (
                      <>
                        <ResizeHandle axis="y" title="Drag to resize the requests panel" onResize={(d) => resize("requestsHeight", -d)} />
                        <div style={{ height: requestsHeight }} className="shrink-0 overflow-hidden">
                          <RequestsPanel />
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            {showCharts && (
              <>
                <ResizeHandle axis="y" title="Drag to resize the charts" onResize={(d) => resize("chartsHeight", -d)} />
                <div style={{ height: chartsHeight }} className="shrink-0 overflow-hidden">
                  <ChartsPanel />
                </div>
              </>
            )}
            <TimelineBar />
            <Readouts />
            <FirstRunCoach />
            <Tour />
          </>
        )}
      </div>
    </Tooltip.Provider>
  );
}
