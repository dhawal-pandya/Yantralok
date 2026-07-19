// Phones can't drive a drag-and-drop canvas instrument, so we gate them out with
// a clear "come back on a computer" screen rather than shipping a broken UI. We
// target actual phones (touch input + small physical screen), so a narrow desktop
// window is never blocked and "request desktop site" can't slip past. Reactive to
// resize and rotation.
//
// This is a standalone page: it owns its own header/footer layout instead of the
// shared Brand block, so its spacing is tuned for a full-screen phone view.
import { useSyncExternalStore } from "react";
import { BrandMark, Credit } from "./Brand";

const isPhone = (): boolean => {
  if (typeof window === "undefined") return false;
  // Touch is the reliable signal: "desktop site" mode spoofs the user agent and
  // inflates innerWidth, but it can't remove the hardware touch input.
  const touch =
    window.navigator.maxTouchPoints > 0 ||
    window.matchMedia("(pointer: coarse)").matches;
  // Measure the physical display, not the spoofable layout viewport, so desktop
  // mode can't widen its way past the gate. Phones stay small; tablets clear it.
  const shortEdge = Math.min(window.screen.width, window.screen.height);
  return touch && shortEdge < 600;
};

function subscribe(cb: () => void): () => void {
  const mql = window.matchMedia("(pointer: coarse)");
  window.addEventListener("resize", cb);
  window.addEventListener("orientationchange", cb);
  mql.addEventListener("change", cb);
  return () => {
    window.removeEventListener("resize", cb);
    window.removeEventListener("orientationchange", cb);
    mql.removeEventListener("change", cb);
  };
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}

export function MobileGate() {
  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 px-8 text-neutral-100">
      <header className="flex justify-center pt-10">
        <div className="flex select-none items-center gap-3">
          <BrandMark size={40} />
          <div className="flex flex-col leading-none">
            <span className="font-display text-[26px] font-semibold tracking-tight text-neutral-100">
              Yantralok
            </span>
            <span className="mt-2 font-mono text-[11px] uppercase tracking-[0.22em] text-neutral-500">
              systems simulator
            </span>
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-lg font-semibold">Best on a larger screen</h1>
        <p className="max-w-xs text-sm leading-relaxed text-neutral-400">
          Yantralok is a hands-on systems workbench: you drag components onto a canvas, wire them together, and watch live simulations play across several panels. That needs the room and precision of a laptop or desktop.
        </p>
        <p className="max-w-xs text-sm leading-relaxed text-neutral-500">
          Open this link on a computer to start building.
        </p>
      </main>

      <footer className="flex justify-center pb-8">
        <Credit />
      </footer>
    </div>
  );
}
