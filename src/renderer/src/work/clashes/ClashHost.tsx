import { defineChunk } from "../../lib/lazyChunk";
import { useShared } from "../tasks/store";
import { clashAsk } from "./open";

const dialog = defineChunk("work-clash", () => import("./ClashDialog"));
const ClashDialog = dialog.surface("ClashDialog");

/** The Clash dialog, wherever Work is on screen (`openClash`, open.ts). One at a time; a second ask takes the first one's place. */
export function ClashHost() {
  const ask = useShared(clashAsk);
  if (!ask) return null;
  return <ClashDialog key={ask.id} ask={ask} onClose={() => clashAsk.set(null)} />;
}
