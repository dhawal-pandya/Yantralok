// Semantic tooltip (tooltips are core, not chrome). Surfaces a component/property's
// what / effect / law on hover.
import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import type { Semantics } from "@/components";

/** A plain-text tooltip for UI controls, so every control is self-explaining. */
export function Tip({
  label,
  side = "bottom",
  children,
}: {
  label: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  if (!label) return <>{children}</>;
  return (
    <RT.Root delayDuration={150}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] leading-snug text-neutral-200 shadow-xl"
        >
          {label}
          <RT.Arrow className="fill-neutral-700" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}

export function SemanticTooltip({
  semantics,
  children,
}: {
  semantics: Semantics;
  children: ReactNode;
}) {
  return (
    <RT.Root delayDuration={250}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side="right"
          sideOffset={8}
          className="z-50 max-w-xs rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300 shadow-xl"
        >
          <p className="text-neutral-100">{semantics.what}</p>
          <p className="mt-1 text-neutral-400">{semantics.effect}</p>
          {semantics.law && (
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-signal/80">
              {semantics.law}
            </p>
          )}
          <RT.Arrow className="fill-neutral-700" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
