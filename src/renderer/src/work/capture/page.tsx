import { createRoot } from "react-dom/client";
import { loadThemePreference, resolveColorScheme } from "../../lib/appearance";
import { captureHost } from "./client";
import { CapturePage, type CaptureBridge } from "./CapturePage";
import "../../index.css";

/**
 * The capture window's entry (src/renderer/capture.html, src/main/capture.ts):
 * its own small page, so nothing of the main window loads here and nothing of
 * this is in the main window's first paint. It wears Work's theme, as boot.js
 * set it, and follows a change another window makes.
 */
/** src/preload/capture.ts, as this page sees it. */
type Preload = CaptureBridge & { port(): Promise<number | null>; scheme(scheme: "dark" | "light"): void };
const bridge = (window as unknown as { capture: Preload }).capture;

function applyScheme(): void {
  const scheme = resolveColorScheme(loadThemePreference("work"));
  document.documentElement.classList.toggle("theme-light", scheme === "light");
  bridge.scheme(scheme);
}
applyScheme();
window.addEventListener("storage", applyScheme);
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyScheme);

createRoot(document.getElementById("root")!).render(<CapturePage host={captureHost(() => bridge.port())} bridge={bridge} />);
