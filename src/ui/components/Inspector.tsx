// Inspector: the selected object's config, always visible (inputs are first-class,
// like layer properties). Editing here flows straight to the document store and
// persists. Every property explains itself.
import { useEffect, useRef, useState } from "react";
import { CHANNEL, defaultConfig, getComponent, type PropertyDef } from "@/components";
import type { Intervention, SystemNode } from "@/schema";
import { useSystemStore } from "@/ui/store/systemStore";
import { useSimStore } from "@/ui/store/simStore";
import { SemanticTooltip } from "./Tooltip";

type ConfigValue = number | string | boolean;

// Independently-killable cells for a partitioned store: shard fan-out or quorum
// peers. Mirrors compile's gating, so the picker shows exactly the cells that exist.
// 0 = not partitioned (no per-cell picker).
function cellCount(node: SystemNode): number {
  const cfg = { ...defaultConfig(node.type), ...node.config };
  const shards = Math.floor(Number(cfg.shards) || 1);
  if (shards > 1) return shards;
  if (cfg.quorumReplication === true) return Math.max(1, Math.floor(Number(cfg.nodes) || 6));
  return 0;
}

export function Inspector() {
  const doc = useSystemStore((s) => s.doc);
  const selection = useSystemStore((s) => s.selection);
  const setNodeConfig = useSystemStore((s) => s.setNodeConfig);
  const setEdgeConfig = useSystemStore((s) => s.setEdgeConfig);
  const removeSelected = useSystemStore((s) => s.removeSelected);

  let body: React.ReactNode;

  if (!doc || !selection) {
    body = (
      <p className="px-3 py-4 text-xs text-neutral-600">
        Select a node or connection to inspect and edit its behavior.
      </p>
    );
  } else if (selection.kind === "node") {
    const node = doc.graph.nodes.find((n) => n.id === selection.id);
    const def = node && getComponent(node.type);
    body = node ? (
      <>
        <Header
          title={def?.label ?? node.type}
          subtitle={node.id}
          tooltip={def ? { what: def.what, effect: def.effect, law: def.law } : undefined}
          onDelete={removeSelected}
        />
        <Fields
          properties={def?.properties ?? []}
          config={node.config}
          onChange={(key, value) => setNodeConfig(node.id, { [key]: value })}
        />
        <FailureInjection nodeId={node.id} cells={cellCount(node)} />
      </>
    ) : null;
  } else {
    const edge = doc.graph.edges.find((e) => e.id === selection.id);
    body = edge ? (
      <>
        <Header
          title="Connection"
          subtitle={`${edge.source.slice(0, 6)} → ${edge.target.slice(0, 6)}`}
          onDelete={removeSelected}
        />
        <Fields
          properties={CHANNEL.properties}
          config={edge.config}
          onChange={(key, value) => setEdgeConfig(edge.id, { [key]: value })}
        />
      </>
    ) : null;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-neutral-900">
      <h2 className="px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
        Inspector
      </h2>
      {body}
    </section>
  );
}

// Inject a failure on this node at the current clock (or t=2s if not running),
// then re-simulate so the consequence is immediately visible. Interventions are
// part of the reproducible run definition. Each is editable.
function FailureInjection({ nodeId, cells }: { nodeId: string; cells: number }) {
  const interventions = useSystemStore((s) => s.doc?.interventions ?? []);
  const add = useSystemStore((s) => s.addIntervention);
  const update = useSystemStore((s) => s.updateIntervention);
  const remove = useSystemStore((s) => s.removeIntervention);
  const mine = interventions.filter((i) => i.target === nodeId);
  const [shard, setShard] = useState(0);
  // Keep the picked cell in range when the shard/node count changes.
  useEffect(() => {
    if (cells > 0 && shard > cells - 1) setShard(cells - 1);
  }, [cells, shard]);

  // Re-run so the change shows up now; keep compare mode if it was on.
  const rerun = () => {
    const sim = useSimStore.getState();
    if (sim.result) (sim.compare ? sim.runCompare : sim.run)();
  };
  const inject = (kind: Intervention["kind"], param?: number, shardIdx?: number) => {
    const clock = useSimStore.getState().clockMs;
    const atLogicalTime = Math.round(clock > 0 ? clock : 2000);
    add({ atLogicalTime, kind, target: nodeId, param, shard: shardIdx });
    rerun();
  };
  const commitTime = (id: string, v: string) => {
    const s = Number(v);
    if (!Number.isFinite(s)) return;
    update(id, { atLogicalTime: Math.round(Math.max(0, s) * 1000) });
    rerun();
  };
  const commitParam = (id: string, v: string) => {
    const ms = Number(v);
    if (!Number.isFinite(ms)) return;
    update(id, { param: Math.round(Math.max(0, ms)) });
    rerun();
  };

  const chip = "rounded border px-2 py-1 text-xs font-medium";
  const num =
    "w-12 rounded border border-neutral-700 bg-neutral-850 px-1 py-0.5 text-neutral-200 focus:border-signal focus:outline-none";
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  return (
    <div className="border-t-2 border-red-500/30 bg-neutral-850 px-3 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-neutral-200">
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Failure injection
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button className={`${chip} border-red-500/60 text-red-400 hover:bg-red-500/10`} onClick={() => inject("kill")}>
          Kill
        </button>
        <button className={`${chip} border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10`} onClick={() => inject("restart")}>
          Restart
        </button>
        <button className={`${chip} border-amber-400/50 text-amber-400 hover:bg-amber-400/10`} onClick={() => inject("delay", 300)}>
          Delay
        </button>
        <button className={`${chip} border-violet-400/50 text-violet-300 hover:bg-violet-400/10`} onClick={() => inject("partition")} title="Network-isolate this node: it stays alive but calls to it fail">
          Partition
        </button>
      </div>
      {cells > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" title="Down a single cell (shard / quorum peer); only its key slice fails, the rest keep serving">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Per-cell</span>
          <select
            aria-label="Cell index"
            value={Math.min(shard, cells - 1)}
            onChange={(e) => setShard(Number(e.target.value))}
            className="rounded border border-neutral-700 bg-neutral-850 px-1 py-0.5 font-mono text-[10px] text-neutral-200 focus:border-signal focus:outline-none"
          >
            {Array.from({ length: cells }, (_, i) => (
              <option key={i} value={i}>#{i}</option>
            ))}
          </select>
          <button className={`${chip} border-red-500/60 text-red-400 hover:bg-red-500/10`} onClick={() => inject("kill", undefined, Math.min(shard, cells - 1))}>
            Kill cell
          </button>
          <button className={`${chip} border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10`} onClick={() => inject("restart", undefined, Math.min(shard, cells - 1))}>
            Restart cell
          </button>
        </div>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">Added at the current time. Edit when (and how much) below.</p>
      {mine.length > 0 && (
        <ul className="mt-2 space-y-1">
          {mine.map((iv) => (
            <li key={iv.id} className="flex items-center gap-1.5 font-mono text-[10px] text-neutral-400">
              <span className="w-16 shrink-0 text-neutral-300">
                {iv.kind}
                {iv.shard !== undefined && <span className="text-signal"> #{iv.shard}</span>}
              </span>
              <label className="flex items-center gap-0.5 text-neutral-600" title="When it fires (seconds)">
                @
                <input
                  key={`t-${iv.id}-${iv.atLogicalTime}`}
                  type="number"
                  min={0}
                  step={0.5}
                  defaultValue={+(iv.atLogicalTime / 1000).toFixed(2)}
                  onBlur={(e) => commitTime(iv.id, e.target.value)}
                  onKeyDown={commitOnEnter}
                  className={num}
                />
                s
              </label>
              {iv.kind === "delay" && (
                <label className="flex items-center gap-0.5 text-neutral-600" title="Extra latency added (ms)">
                  +
                  <input
                    key={`p-${iv.id}-${iv.param}`}
                    type="number"
                    min={0}
                    step={50}
                    defaultValue={iv.param ?? 0}
                    onBlur={(e) => commitParam(iv.id, e.target.value)}
                    onKeyDown={commitOnEnter}
                    className={num}
                  />
                  ms
                </label>
              )}
              <button
                className="ml-auto rounded border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-xs font-bold text-red-400 hover:bg-red-500/20 hover:text-red-300"
                title="Remove this failure"
                onClick={() => {
                  remove(iv.id);
                  rerun();
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Header({
  title,
  subtitle,
  tooltip,
  onDelete,
}: {
  title: string;
  subtitle: string;
  tooltip?: { what: string; effect: string; law?: string };
  onDelete: () => void;
}) {
  const titleEl = <span className="text-sm font-medium text-neutral-100">{title}</span>;
  return (
    <div className="flex items-start justify-between gap-2 border-b border-neutral-800 px-3 py-2">
      <div>
        {tooltip ? <SemanticTooltip semantics={tooltip}>{titleEl}</SemanticTooltip> : titleEl}
        <div className="font-mono text-[10px] text-neutral-600">{subtitle}</div>
      </div>
      <button
        onClick={onDelete}
        className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-red-500 hover:text-red-400"
      >
        Delete
      </button>
    </div>
  );
}

function Fields({
  properties,
  config,
  onChange,
}: {
  properties: readonly PropertyDef[];
  config: Record<string, unknown>;
  onChange: (key: string, value: ConfigValue) => void;
}) {
  // Mode-gated knobs (showIf) only appear when their switch is set: hidden, not
  // inert. Transitive: a knob gated on a hidden knob is hidden too.
  const valueOf = (key: string) =>
    config[key] ?? properties.find((p) => p.key === key)?.default;
  const isVisible = (p: PropertyDef): boolean => {
    if (!p.showIf) return true;
    const gate = properties.find((q) => q.key === p.showIf!.key);
    if (gate?.showIf && !isVisible(gate)) return false;
    const v = valueOf(p.showIf.key);
    if (p.showIf.min !== undefined) return typeof v === "number" && v >= p.showIf.min;
    return v === p.showIf.equals;
  };
  const visible = properties.filter(isVisible);
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {visible.map((p) => (
        <Field
          key={p.key}
          def={p}
          value={(config[p.key] ?? p.default) as ConfigValue}
          onChange={(v) => onChange(p.key, v)}
        />
      ))}
    </div>
  );
}

function Field({
  def,
  value,
  onChange,
}: {
  def: PropertyDef;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
}) {
  const inputCls =
    "w-full rounded border border-neutral-700 bg-neutral-850 px-2 py-1 font-mono text-xs text-neutral-100 focus:border-signal focus:outline-none";

  return (
    <label className="block">
      <SemanticTooltip semantics={def}>
        <span className="mb-1 flex items-center justify-between gap-2 text-xs text-neutral-400">
          <span className="flex items-center gap-1.5">
            {def.label}
            {def.pending && (
              <span className="rounded bg-neutral-800 px-1 py-px text-[9px] uppercase tracking-wide text-neutral-500">
                not simulated
              </span>
            )}
          </span>
          {def.unit && <span className="font-mono text-[10px] text-neutral-600">{def.unit}</span>}
        </span>
      </SemanticTooltip>

      {def.kind === "select" ? (
        <select
          className={inputCls}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {def.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : def.kind === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-signal"
        />
      ) : def.kind === "number" ? (
        <NumberField def={def} value={Number(value)} className={inputCls} onChange={onChange} />
      ) : (
        <input
          type="text"
          className={inputCls}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

// A number input backed by a local draft string, so the field can be freely
// edited: cleared to empty, retyped from any digit. A purely value-controlled
// <input type="number"> blocks the empty intermediate state, which stranded a
// leftover digit (e.g. editing 20 → 1000 became "21000"). We commit a real
// number on every parseable keystroke and restore the last good value on blur.
function NumberField({
  def,
  value,
  className,
  onChange,
}: {
  def: PropertyDef;
  value: number;
  className: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(() => String(value));
  const committed = useRef(value);

  // Reflect changes from outside (selecting another node, a clamp) without
  // clobbering what the user is mid-typing: only resync when the value differs
  // from what we last committed ourselves.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setText(String(value));
    }
  }, [value]);

  return (
    <input
      type="number"
      className={className}
      value={text}
      min={def.min}
      max={def.max}
      step={def.step}
      onChange={(e) => {
        const t = e.target.value;
        setText(t); // allow "", "-", "0", etc. so the field can be cleared/retyped
        if (t === "" || t === "-" || t === "." || t === "-.") return;
        const n = Number(t);
        if (!Number.isNaN(n)) {
          committed.current = n;
          onChange(n);
        }
      }}
      onBlur={() => {
        if (text === "" || Number.isNaN(Number(text))) setText(String(committed.current));
      }}
    />
  );
}
