import type { SheetReach, SheetStoreKind } from "@shared/contract-work-sheets";
import { TruncateTip } from "../../components/tip";
import { registry } from "../../lib/connection";
import { reachHere } from "./fullHere";

/**
 * What waits in Excel, on the kind's bar (docs/agents/work-sheets.md "The switch"): one 12px muted line beside
 * the switch that says why it is there, in the host's own counted phrases (`SheetReach.parts`, counted from
 * the importer's report by excelWaits.ts on the host): "2 pivot tables and macros open in Excel".
 *
 * Said only for an opened Excel file: there the parts are things the file holds. A workbook Excel or Google
 * holds has the switch for another reason (what our grid does not do there), and its bar says nothing.
 *
 * The line and the switch come from one check (fullHere.ts `reachHere`): where the full editor opens from this
 * window the switch names it; where it does not, no switch is drawn and the line says the computer it opens on.
 */

const listed = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The line, or null where there is nothing to say. One thing opens; many open. `on`: the computer the full editor opens on, where it does not open from here. */
export function waitsWords(reach: SheetReach | undefined, store: SheetStoreKind | undefined, on: string | null = null): string | null {
  if (!reach || store !== "package" || reach.to === "google" || reach.parts.length === 0) return null;
  const list = listed(reach.parts);
  // Every phrase for one thing has no plural ending ("a pivot table", "Power Query"); "macros" is always many.
  const one = reach.parts.length === 1 && !reach.parts[0]!.endsWith("s");
  const where = reach.to === "excel" ? "Excel" : on ? `the full editor on ${on}` : "the full editor";
  return `${list[0]!.toUpperCase()}${list.slice(1)} ${one ? "opens" : "open"} in ${where}`;
}

/**
 * The bar's line, at the end of the kind's tools: under the switch it explains, and apart from the mode's word at
 * the bar's start, which is the same muted text. It gives way through its words: cut at the bar's room, whole in
 * the tip while it is cut.
 */
export function ExcelWaits({ reach, store, env }: { reach: SheetReach | undefined; store: SheetStoreKind | undefined; env: string }) {
  const words = waitsWords(reach, store, reachHere(reach, env) ? null : (registry.environment(env)?.name ?? "its host"));
  if (!words) return null;
  // 16px at least from the mode's word (the bar's 8px gap and 8 more), so the two never read as one phrase.
  return (
    <TruncateTip text={words}>
      <span data-sheet-waits className="ms-auto min-w-0 truncate ps-2">
        {words}
      </span>
    </TruncateTip>
  );
}
