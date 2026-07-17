// Welcome / hero. Shown before the playground on first run (and reachable again).
// A calm, dark landing that launches straight into the app, no marketing gloss.
import { COMPANIES, LESSONS } from "@/scenarios";
import { useLayoutStore } from "@/ui/store/layoutStore";
import { useSimStore } from "@/ui/store/simStore";
import { useSystemStore } from "@/ui/store/systemStore";
import { Brand, Credit } from "./Brand";

export function Hero() {
  const enterApp = useLayoutStore((s) => s.enterApp);
  const importText = useSystemStore((s) => s.importText);

  // Launch an example straight into a running sim: one click and packets are
  // already flowing, so a first-time visitor sees a live system, not a still graph.
  const launchExample = async (raw: string) => {
    try {
      await importText(raw);
      useSimStore.getState().run();
    } catch {
      // fall through, still enter the app
    }
    enterApp();
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {/* amber glow + faint blueprint dots */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse 80% 55% at 50% 0%, rgba(245,179,1,0.10), transparent 60%)" }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage: "radial-gradient(#2c333f 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          maskImage: "radial-gradient(ellipse 70% 70% at 50% 40%, black, transparent 75%)",
        }}
      />

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Brand size={64} tagline={false} />

        <h1 className="mt-9 max-w-3xl font-display text-4xl leading-tight tracking-tight text-neutral-50 sm:text-5xl">
          Turn architecture diagrams into living systems.
          <br />
          <span className="text-signal">Everything else is just drawing.</span>
        </h1>

        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          Stress every assumption in every system design and be smarter. Draw your architecture, give each
          part real numbers, generate traffic, and watch where latency piles up,
          where the queue overflows, and how a failure cascades, deterministically,
          in your browser itself.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={enterApp}
            className="rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-lg shadow-signal/20 transition-colors hover:bg-signal-bright"
          >
            Launch the playground →
          </button>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-2 text-xs text-neutral-500">
          <span>start with a lesson:</span>
          {LESSONS.slice(0, 2).map((s) => (
            <button
              key={s.id}
              onClick={() => launchExample(s.raw)}
              title={s.teaches}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
            >
              {s.title}
            </button>
          ))}
          <span>or a real system:</span>
          {COMPANIES.slice(0, 1).map((s) => (
            <button
              key={s.id}
              onClick={() => launchExample(s.raw)}
              title={s.teaches}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
            >
              {s.title}
            </button>
          ))}
        </div>

        <div className="mt-14 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
          <Feature title="Design" body="19 components over one queueing kernel. Place, connect, configure, every knob explains itself." />
          <Feature title="Simulate" body="Stream live latency, throughput, and utilization. Find the bottleneck instead of guessing." />
          <Feature title="Break" body="Kill a node, crank load 20×, watch the cascade. Rewind, branch, and compare timelines." />
        </div>
      </div>

      <footer className="relative z-10 flex items-center justify-center border-t border-neutral-800/60 py-3">
        <Credit />
      </footer>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-left">
      <div className="font-display text-sm font-semibold text-signal/90">{title}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{body}</p>
    </div>
  );
}
