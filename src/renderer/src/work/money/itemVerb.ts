import type { CanvasItem, CanvasKind } from "@shared/work";
import { kindOfEntry } from "@shared/work/files";
import { Receipt } from "../../chrome/icons";
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

/** A PDF, or a picture (never a video or a recording). */
export function takesItem(item: CanvasItem, kind: CanvasKind): boolean {
  if (kind === "pdf") return true;
  if (kind !== "media") return false;
  const mime = item.source.at === "mail" ? item.source.contentType : undefined;
  return kindOfEntry(itemName(item), mime).kind === "picture";
}

registerItemVerb({
  id: "money.receipt",
  label: "File as receipt",
  icon: Receipt,
  when: takesItem,
  run: (item, at) => import("./fileItem").then((m) => m.fileItem(item, at.environmentId)),
});
