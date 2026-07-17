// A draggable splitter between two panels. Reports the raw pointer delta; the
// caller applies the sign for its side. Uses pointer capture so a drag keeps
// tracking even when the cursor leaves the thin handle.
import { useRef } from "react";

export function ResizeHandle({
  axis,
  onResize,
  title,
}: {
  axis: "x" | "y";
  onResize: (deltaPx: number) => void;
  title?: string;
}) {
  const last = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = axis === "x" ? e.clientX : e.clientY;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (last.current === null) return;
    const cur = axis === "x" ? e.clientX : e.clientY;
    const d = cur - last.current;
    if (d !== 0) {
      onResize(d);
      last.current = cur;
    }
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    last.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const shape =
    axis === "x"
      ? "w-1.5 cursor-col-resize"
      : "h-1.5 cursor-row-resize";

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      className={`${shape} shrink-0 bg-neutral-800/60 transition-colors hover:bg-signal/40 active:bg-signal/60`}
    />
  );
}
