import type { CanvasItem, CanvasKind } from "@shared/work";
import { isReceiptName, receiptExt } from "@shared/work/money";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { Receipt } from "../icons";
import { registerItemVerb } from "../canvas/itemVerbs";

/**
 * File as receipt in a canvas item's More (docs/agents/work-money.md "In"):
 * a PDF or a picture, a mail's attachment or a file, sent to the job's To
 * confirm. Registered when Work's shell loads the views (money/view.ts
 * imports this); the work itself loads on the press.
 */

/** The item's file name: an attachment's own, a file's last part, else its title. */
export function itemName(item: Pick<CanvasItem, "source" | "title">): string {
  if (item.source.at === "mail") return item.source.name;
  if (item.source.at === "file") return item.source.path.split(/[\\/]/).pop() || item.title;
  return item.title;
}

/** The item's pane belongs to a Work job on this window's hosts: there is a ledger to file into. */
export const inJob = (item: Pick<CanvasItem, "workspaceId">): boolean => !!item.workspaceId && workspaceStore.workspace(item.workspaceId)?.kind === "work";

/** A PDF or a picture by the one list Money files (never a video or a recording), in a job's pane. */
export function takesItem(item: CanvasItem, kind: CanvasKind): boolean {
  if ((kind !== "pdf" && kind !== "media") || !inJob(item)) return false;
  const name = itemName(item);
  if (receiptExt(name)) return isReceiptName(name);
  const mime = item.source.at === "mail" ? (item.source.contentType ?? "") : "";
  return /^image\//.test(mime) || mime === "application/pdf";
}

registerItemVerb({
  id: "money.receipt",
  label: "File as receipt",
  icon: Receipt,
  when: takesItem,
  run: (item, at) => import("./fileItem").then((m) => m.fileItem(item, at.environmentId)),
});
