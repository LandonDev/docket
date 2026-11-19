import { defineChunk } from "../../lib/lazyChunk";
import { Globe } from "../../chrome/icons";
import { defineCanvasKind } from "../canvas/kind";

/**
 * The browser kind of canvas item (docs/agents/work-browser.md): computer
 * use on the Mac beside a Work thread, at full size, with who drives it and
 * a submit waiting on its final screen. It claims a browser session, which
 * `browser_open` opens in the thread's pane.
 */
export const browserCanvas = defineCanvasKind({
  kind: "browser",
  label: "Browser",
  icon: Globe,
  opens: { sources: [{ at: "browser" }] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-browser-canvas", () => import("./BrowserCanvas")),
});
