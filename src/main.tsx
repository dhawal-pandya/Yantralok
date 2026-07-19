import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/ui/App";
import { MobileGate, useIsPhone } from "@/ui/components/MobileGate";
import "@/index.css";

// Gate phones out entirely: the canvas instrument doesn't mount on one.
function Root() {
  return useIsPhone() ? <MobileGate /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
