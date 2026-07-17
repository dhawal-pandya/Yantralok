// Top bar: system identity + management (new / switch / delete), the shipped
// scenario loader, and import/export (.yantra, Mermaid, simulation report).
import { useRef } from "react";
import {
  toMermaid,
  toSimulationReport,
  YANTRA_EXTENSION,
} from "@/document";
import { SCENARIOS } from "@/scenarios";
import { useSimStore } from "@/ui/store/simStore";
import { useSystemStore } from "@/ui/store/systemStore";
import { Brand } from "./Brand";
import { ScenarioGuide } from "./ScenarioGuide";
import { Tip } from "./Tooltip";

const STATUS_LABEL = {
  idle: "-",
  saving: "saving…",
  saved: "saved",
  error: "save failed",
} as const;

const slug = (name: string) => name.replace(/\s+/g, "-").toLowerCase() || "system";

function download(filename: string, text: string, mime = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Custom caret so the selects / switch match the app's buttons instead of the
// OS-native dropdown chrome. Positioned by the caller.
function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-2.5 w-2.5 text-neutral-500 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Toolbar() {
  const doc = useSystemStore((s) => s.doc);
  const systems = useSystemStore((s) => s.systems);
  const status = useSystemStore((s) => s.status);
  const rename = useSystemStore((s) => s.rename);
  const newSystem = useSystemStore((s) => s.newSystem);
  const openSystem = useSystemStore((s) => s.openSystem);
  const deleteSystem = useSystemStore((s) => s.deleteSystem);
  const exportText = useSystemStore((s) => s.exportText);
  const importText = useSystemStore((s) => s.importText);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const switchMenu = useRef<HTMLDetailsElement>(null);

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await importText(await file.text());
      useSimStore.getState().clear();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed.");
    }
  };

  const onLoadScenario = async (id: string) => {
    const entry = SCENARIOS.find((s) => s.id === id);
    if (!entry) return;
    try {
      await importText(entry.raw); // the same importer users use
      useSimStore.getState().clear();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not load scenario.");
    }
  };

  const closeExport = () => exportMenu.current?.removeAttribute("open");
  const closeSwitch = () => switchMenu.current?.removeAttribute("open");

  const onExportYantra = () => {
    const text = exportText();
    if (text && doc) download(`${slug(doc.name)}${YANTRA_EXTENSION}`, text);
    closeExport();
  };

  const onExportMermaid = () => {
    if (doc) download(`${slug(doc.name)}.mmd`, toMermaid(doc), "text/vnd.mermaid");
    closeExport();
  };

  const onExportReport = () => {
    const { result } = useSimStore.getState();
    if (doc && result) {
      download(`${slug(doc.name)}-report.md`, toSimulationReport(doc, result), "text/markdown");
    }
    closeExport();
  };

  const hasResult = useSimStore((s) => s.result !== null);

  const btn =
    "rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100";
  const item =
    "px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40";

  return (
    <header className="flex items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-3 py-1.5">
      <Brand size={22} />

      <div className="mx-1 h-5 w-px bg-neutral-800" />

      {/* Identity: the editable title and the system switcher, as one control */}
      <div className="flex items-center rounded border border-neutral-700 bg-neutral-900 transition-colors focus-within:border-signal">
        <Tip label="Click to rename this design">
          <input
            aria-label="System name"
            className="w-52 bg-transparent px-2 py-1 text-sm font-medium text-neutral-100 focus:outline-none"
            value={doc?.name ?? ""}
            onChange={(e) => rename(e.target.value)}
            placeholder="Untitled System"
          />
        </Tip>
        {systems.length > 1 && (
          <details ref={switchMenu} className="relative">
            <Tip label="Switch to another saved system">
              <summary className="flex cursor-pointer list-none items-center border-l border-neutral-700 px-1.5 py-1.5 text-neutral-400 hover:text-neutral-200">
                <Chevron />
              </summary>
            </Tip>
            <div className="absolute left-0 z-20 mt-1 flex w-56 flex-col rounded border border-neutral-700 bg-neutral-850 py-1 shadow-xl">
              {systems
                .filter((m) => m.id !== doc?.id)
                .map((m) => (
                  <button
                    key={m.id}
                    className={item}
                    onClick={() => {
                      openSystem(m.id);
                      closeSwitch();
                    }}
                  >
                    {m.name}
                  </button>
                ))}
            </div>
          </details>
        )}
      </div>

      <Tip label="Create a new empty system">
        <button className={btn} onClick={() => newSystem()}>
          New
        </button>
      </Tip>
      <Tip label="Delete the current system (cannot be undone)">
        <button
          className={btn}
          onClick={() => doc && systems.length > 0 && deleteSystem(doc.id)}
        >
          Delete
        </button>
      </Tip>

      {/* File actions live on the right, away from the identity controls */}
      <div className="ml-auto flex items-center gap-2">
        <ScenarioGuide onLoad={onLoadScenario} />

        <Tip label="Import a .yantra file from disk">
          <button className={btn} onClick={() => fileInput.current?.click()}>
            Import
          </button>
        </Tip>

        <details ref={exportMenu} className="relative">
          <Tip label="Export as .yantra, a Mermaid diagram, or a simulation report">
            <summary className={`${btn} cursor-pointer list-none`}>Export ▾</summary>
          </Tip>
          <div className="absolute right-0 z-20 mt-1 flex w-40 flex-col rounded border border-neutral-700 bg-neutral-850 py-1 shadow-xl">
            <button className={item} onClick={onExportYantra}>
              .yantra (document)
            </button>
            <button className={item} onClick={onExportMermaid}>
              Mermaid (.mmd)
            </button>
            <button
              className={item}
              onClick={onExportReport}
              disabled={!hasResult}
              title={hasResult ? undefined : "Run a simulation first"}
            >
              Report (.md)
            </button>
          </div>
        </details>

        <div className="mx-1 h-5 w-px bg-neutral-800" />

        <Tip label="Save status: every system persists locally in your browser (IndexedDB)" side="left">
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-neutral-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status === "saved"
                  ? "bg-emerald-500"
                  : status === "saving"
                    ? "bg-amber-400"
                    : status === "error"
                      ? "bg-red-500"
                      : "bg-neutral-600"
              }`}
            />
            {STATUS_LABEL[status]}
          </div>
        </Tip>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".yantra,.json,application/json"
        className="hidden"
        onChange={onImport}
      />
    </header>
  );
}
