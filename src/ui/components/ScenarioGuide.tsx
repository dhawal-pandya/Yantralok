// The "?" guide next to the Pre-built picker (a referable write-up). Explains the
// two shelves (Lessons that break on purpose, Companies that always ship green)
// and, per scenario, what to watch, how to probe it, and where it breaks. Loading
// a system from here goes through the same importer the picker uses.
import { useEffect, useState } from "react";
import {
  COMPANIES,
  COMPANIES_GUIDE,
  GUIDE_INTRO,
  LESSONS,
  LESSONS_GUIDE,
  SCENARIO_NOTES,
  SHOWCASES,
  SHOWCASES_GUIDE,
  type ScenarioEntry,
} from "@/scenarios";
import { useLayoutStore } from "@/ui/store/layoutStore";
import { Tip } from "./Tooltip";

export function ScenarioGuide({ onLoad }: { onLoad: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  // null = the overview (shelf logic); otherwise the selected scenario's id.
  const [selected, setSelected] = useState<string | null>(null);
  const guideSeen = useLayoutStore((s) => s.guideSeen);
  const markGuideSeen = useLayoutStore((s) => s.markGuideSeen);
  const openTour = useLayoutStore((s) => s.openTour);
  const openGuide = () => {
    setOpen(true);
    markGuideSeen();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const entry =
    selected != null
      ? [...SHOWCASES, ...LESSONS, ...COMPANIES].find((s) => s.id === selected) ?? null
      : null;

  return (
    <>
      <Tip label="Open the guide: pre-built systems and a walkthrough tour of the platform">
        <button
          aria-label="Open the guide"
          onClick={openGuide}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            guideSeen
              ? "bg-signal/15 text-signal ring-1 ring-inset ring-signal/40 hover:bg-signal/25"
              : "guide-pulse"
          }`}
        >
          <GuideGlyph />
          Guide
        </button>
      </Tip>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-neutral-100">Guide</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setOpen(false);
                    openTour();
                  }}
                  className="rounded border border-signal/50 bg-signal/10 px-2.5 py-1 text-xs font-semibold text-signal transition-colors hover:bg-signal/20"
                >
                  ▶ Show tour
                </button>
                <button
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                  className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-100"
                >
                  ✕
                </button>
              </div>
            </header>

            <div className="flex min-h-0 flex-1">
              {/* Index: overview + the two shelves */}
              <nav className="w-56 shrink-0 overflow-y-auto border-r border-neutral-800 py-2">
                <IndexButton
                  label="Overview"
                  active={selected === null}
                  onClick={() => setSelected(null)}
                />
                <Group label="Lessons: break on purpose">
                  {LESSONS.map((s) => (
                    <IndexButton
                      key={s.id}
                      label={s.title}
                      active={selected === s.id}
                      onClick={() => setSelected(s.id)}
                    />
                  ))}
                </Group>
                <Group label="Companies: always green">
                  {COMPANIES.map((s) => (
                    <IndexButton
                      key={s.id}
                      label={s.title}
                      active={selected === s.id}
                      onClick={() => setSelected(s.id)}
                    />
                  ))}
                </Group>
                <Group label="Showcases: many laws at once">
                  {SHOWCASES.map((s) => (
                    <IndexButton
                      key={s.id}
                      label={s.title}
                      active={selected === s.id}
                      onClick={() => setSelected(s.id)}
                    />
                  ))}
                </Group>
              </nav>

              {/* Detail: the overview write-up, or one scenario's notes */}
              <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
                {entry ? (
                  <ScenarioDetail
                    entry={entry}
                    onLoad={() => {
                      onLoad(entry.id);
                      setOpen(false);
                    }}
                  />
                ) : (
                  <Overview />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Open-book mark, so the Guide button reads as "learn / walkthrough".
function GuideGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3.6C6.7 2.8 5 2.6 2.8 2.9v9c2.2-.3 3.9-.1 5.2.7 1.3-.8 3-1 5.2-.7v-9C11 2.6 9.3 2.8 8 3.6Z" strokeLinejoin="round" />
      <path d="M8 3.6v9" />
    </svg>
  );
}

function Overview() {
  return (
    <div className="space-y-5 text-sm leading-relaxed text-neutral-300">
      <p className="text-neutral-400">{GUIDE_INTRO}</p>
      {[LESSONS_GUIDE, COMPANIES_GUIDE, SHOWCASES_GUIDE].map((sec) => (
        <section key={sec.title}>
          <h3 className="mb-1.5 text-sm font-semibold text-neutral-100">{sec.title}</h3>
          {sec.body.map((p, i) => (
            <p key={i} className="mb-2 text-neutral-400">
              {p}
            </p>
          ))}
        </section>
      ))}
      <p className="border-t border-neutral-800 pt-3 text-xs text-neutral-600">
        Pick any system on the left to read what to look for, how to test it further, and where it breaks.
      </p>
    </div>
  );
}

function ScenarioDetail({ entry, onLoad }: { entry: ScenarioEntry; onLoad: () => void }) {
  const notes = SCENARIO_NOTES[entry.id];
  const badge =
    entry.kind === "showcase"
      ? { text: "Showcase · stress & recover", cls: "border-amber-500/50 text-amber-400" }
      : entry.kind === "lesson"
        ? { text: "Lesson", cls: "border-signal/50 text-signal" }
        : { text: "Company · always green", cls: "border-emerald-500/50 text-emerald-400" };

  return (
    <div className="space-y-4 text-sm leading-relaxed">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className={`mb-1 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge.cls}`}>
            {badge.text}
          </span>
          <h3 className="text-base font-semibold text-neutral-100">{entry.title}</h3>
        </div>
        <button
          onClick={onLoad}
          className="shrink-0 rounded bg-signal px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-signal-bright"
        >
          Load this system
        </button>
      </div>

      <p className="text-neutral-300">{entry.blurb}</p>
      <NoteBlock label="Teaches" body={entry.teaches} />
      {notes && (
        <>
          <NoteBlock label="What to look for" body={notes.watch} />
          <NoteBlock label="How to test it further" body={notes.test} />
          <NoteBlock label="Where it breaks" body={notes.stress} />
        </>
      )}
    </div>
  );
}

function NoteBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      <p className="text-neutral-300">{body}</p>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-neutral-600">
        {label}
      </div>
      {children}
    </div>
  );
}

function IndexButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-850 hover:text-neutral-200"
      }`}
    >
      {label}
    </button>
  );
}
