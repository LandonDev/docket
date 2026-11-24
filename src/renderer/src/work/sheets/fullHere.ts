import type { SheetReach } from "@shared/contract-work-sheets";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../lib/connection";
import { isWebMode } from "../../lib/nativeWeb";

/** Whether this window's app can carry the box's full editor (src/main/fullEditorCarry.ts): the desktop app, not a browser. */
export const canCarryFullEditor = (): boolean => !isWebMode() && typeof globalThis.window?.api?.app?.openFullEditor === "function";

/**
 * The switch's reach as this window may use it (docs/agents/work-sheets.md "The full editor"): the full editor is
 * offered only where it opens from here, in the desktop app, and from another computer only where the box's page
 * reaches beyond it (`carried`) and the key is an admin key. Anywhere else the switch and its line are not drawn.
 */
export function reachHere(
  reach: SheetReach | undefined,
  env: string,
  can = { carry: canCarryFullEditor(), caps: (id: string) => registry.statusOf(id).lastHello?.caps ?? [] },
): SheetReach | undefined {
  if (!reach || reach.to !== "full") return reach;
  if (!can.carry) return undefined;
  if (env === LOCAL_ENVIRONMENT_ID) return reach;
  return reach.carried && can.caps(env).includes("admin") ? reach : undefined;
}
