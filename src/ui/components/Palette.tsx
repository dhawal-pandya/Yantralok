// Component palette. Click to place a node with its sane defaults. Grouped by
// category; every item explains itself.
import { listComponents, type Category, type ComponentDef } from "@/components";
import { useSystemStore } from "@/ui/store/systemStore";
import { SemanticTooltip } from "./Tooltip";

const CATEGORY_ORDER: Category[] = [
  "Networking",
  "Compute",
  "Storage",
  "Messaging",
  "Infrastructure",
];

export function Palette() {
  const placeNode = useSystemStore((s) => s.placeNode);
  const count = useSystemStore((s) => s.doc?.graph.nodes.length ?? 0);

  const place = (type: string) => {
    // Cascade new nodes so they don't stack on top of each other, and pan to the
    // new node so it's visible even if the view has scrolled away from the graph.
    const i = count % 8;
    placeNode(type, { x: 80 + i * 36, y: 96 + i * 36 }, { center: true });
  };

  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: listComponents().filter((c) => c.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-r border-neutral-800 bg-neutral-900">
      <h2 className="px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
        Components
      </h2>
      {groups.map((g) => (
        <div key={g.cat} className="mb-2">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
            {g.cat}
          </div>
          {g.items.map((c) => (
            <PaletteItem key={c.type} def={c} onPlace={() => place(c.type)} />
          ))}
        </div>
      ))}
      <p className="mt-auto px-3 py-3 text-[10px] leading-relaxed text-neutral-600">
        Drag onto the canvas or click to place · drag handles to connect · hover for behavior.
      </p>
    </aside>
  );
}

function PaletteItem({ def, onPlace }: { def: ComponentDef; onPlace: () => void }) {
  return (
    <SemanticTooltip semantics={def}>
      <button
        onClick={onPlace}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/yantralok", def.type);
          e.dataTransfer.effectAllowed = "copy";
        }}
        className="flex w-full cursor-grab items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800 active:cursor-grabbing"
      >
        <span
          className="h-3 w-1 shrink-0 rounded-sm"
          style={{ backgroundColor: def.accent }}
        />
        {def.label}
      </button>
    </SemanticTooltip>
  );
}
