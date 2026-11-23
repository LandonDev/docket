import type { SheetReach, SheetStoreKind } from "@shared/contract-work-sheets";
import { TruncateTip } from "../../components/tip";

/**
 * What waits in Excel, on the kind's bar (docs/agents/work-sheets.md "The switch"): one 12px muted line beside
 * the switch that says why it is there, in the host's own counted phrases (`SheetReach.parts`, counted from
 * the importer's report by excelWaits.ts on the host): "2 pivot tables and macros open in Excel".
 *
 * Said only for an opened Excel file: there the parts are things the file holds. A workbook Excel or Google
 * holds has the switch for another reason (what our grid does not do there), and its bar says nothing.
 */

const listed = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The line, or null where there is nothing to say. One thing opens; many open. */
export function waitsWords(reach: SheetReach | undefined, store: SheetStoreKind | undefined): string | null {
  if (!reach || store !== "package" || reach.to === "google" || reach.parts.length === 0) return null;
  const list = listed(reach.parts);
  // Every phrase for one thing has no plural ending ("a pivot table", "Power Query"); "macros" is always many.
  const one = reach.parts.length === 1 && !reach.parts[0]!.endsWith("s");
  return `${list[0]!.toUpperCase()}${list.slice(1)} ${one ? "opens" : "open"} in ${reach.to === "excel" ? "Excel" : "the full editor"}`;
}

/**
 * The bar's line, at the end of the kind's tools: under the switch it explains, and apart from the mode's word at
 * the bar's start, which is the same muted text. It gives way through its words: cut at the bar's room, whole in
 * the tip while it is cut.
 */
export function ExcelWaits({ reach, store }: { reach: SheetReach | undefined; store: SheetStoreKind | undefined }) {
  const words = waitsWords(reach, store);
  if (!words) return null;
  return (
    <TruncateTip text={words}>
      <span data-sheet-waits className="ms-auto min-w-0 truncate">
        {words}
      </span>
    </TruncateTip>
  );
}
