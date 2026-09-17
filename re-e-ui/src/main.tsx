import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./index.css";
import App from "./App";

// Material Symbols ligatures pop in only after the font resolves (upstream pattern).
// fonts.ready can fire before lazily-requested fonts (e.g. the 3.5MB symbol font),
// so also listen for subsequent loadingdone events.
const markFontsLoaded = () => document.documentElement.classList.add("fonts-loaded");
if (document.fonts?.status === "loaded") markFontsLoaded();
document.fonts?.ready.then(markFontsLoaded);
document.fonts?.addEventListener?.("loadingdone", markFontsLoaded);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
