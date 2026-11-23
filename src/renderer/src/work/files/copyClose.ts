import type { FileTab } from "@shared/contract-work-files";
import type { confirmChoice } from "../../chrome/ConfirmDialog";

/**
 * Closing a copy's tab whose changes have not reached its file (docs/DESIGN.md "The Files place"): asked once, so
 * nothing is lost without his word. Waiting for its computer, Keep trying closes the tab and the host sends the
 * changes when it answers; over a file that changed there, Keep Both saves his beside it first; refused, only
 * Discard is offered. Discard drops them with the tab. Answers whether the tab closed.
 */
export async function closeCopyTab(
  tab: Pick<FileTab, "name" | "back">,
  host: string,
  deps: { choose: typeof confirmChoice; confirm(request: { title: string; action: string; danger?: boolean }): Promise<boolean>; close(discard: boolean): Promise<void>; keepBoth(): Promise<void> },
): Promise<boolean> {
  const back = tab.back;
  if (!back || back.is === "ok") {
    await deps.close(false);
    return true;
  }
  const title = `Changes to ${tab.name} have not reached ${host}.`;
  if (back.is === "refused") {
    if (!(await deps.confirm({ title, action: "Discard", danger: true }))) return false;
    await deps.close(true);
    return true;
  }
  const over = back.is === "changed" || back.is === "gone";
  const choice = await deps.choose({ title, action: over ? "Keep Both" : "Keep trying", other: "Discard" });
  if (choice === null) return false;
  if (choice === "action" && over) await deps.keepBoth();
  await deps.close(choice === "other");
  return true;
}
