// Footer strip: honest run stats, panel show/hide toggles, and the credit.
// Real values only, no decorative metrics.
import { ENGINE_VERSION } from "@/engine";
import { useLayoutStore, type Panel } from "@/ui/store/layoutStore";
import { useSimStore } from "@/ui/store/simStore";
import { useSystemStore } from "@/ui/store/systemStore";
import { Credit } from "./Brand";
import { Tip } from "./Tooltip";

export function Readouts() {
  const doc = useSystemStore((s) => s.doc);
  const nodes = doc?.graph.nodes.length ?? 0;
  const edges = doc?.graph.edges.length ?? 0;
  // The requests panel only exists after a run, so its toggle appears with it.
  const hasResult = useSimStore((s) => s.result !== null);

  return (
    <footer className="flex items-center gap-4 border-t border-neutral-800 bg-neutral-900 px-3 py-1 font-mono text-[10px] text-neutral-500">
      <Readout label="nodes" value={nodes} />
      <Readout label="edges" value={edges} />
      <Readout label="seed" value={doc?.seed ?? "-"} />
      <Readout label="schema" value={`v${doc?.schemaVersion ?? "-"}`} />

      <div className="flex items-center gap-1">
        <span className="text-neutral-600">panels</span>
        <PanelToggle panel="palette" label="Palette" />
        <PanelToggle panel="charts" label="Charts" />
        <PanelToggle panel="inspector" label="Inspector" />
        {hasResult && <PanelToggle panel="requests" label="Requests" />}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-neutral-700">engine {ENGINE_VERSION}</span>
        <Credit className="font-sans" />
      </div>
    </footer>
  );
}

const SHOW_KEY = {
  palette: "showPalette",
  charts: "showCharts",
  inspector: "showInspector",
  requests: "showRequests",
} as const;

function PanelToggle({ panel, label }: { panel: Panel; label: string }) {
  const show = useLayoutStore((s) => s[SHOW_KEY[panel]]);
  const toggle = useLayoutStore((s) => s.togglePanel);
  return (
    <Tip label={`${show ? "Hide" : "Show"} the ${label.toLowerCase()} panel`} side="top">
      <button
        onClick={() => toggle(panel)}
        className={`rounded px-1.5 py-0.5 transition-colors ${
          show ? "bg-neutral-700 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
        }`}
      >
        {label}
      </button>
    </Tip>
  );
}

function Readout({ label, value }: { label: string; value: string | number }) {
  return (
    <span>
      <span className="text-neutral-600">{label} </span>
      <span className="text-neutral-300">{value}</span>
    </span>
  );
}
