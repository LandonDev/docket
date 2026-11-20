import type { MailFile, MailKit } from "work-kit/mail";
import type { CanvasKind, CanvasSource } from "@shared/work";
import { FETCHED_KINDS } from "../canvas/fetched";
import { kindForFile } from "../canvas/registry";
import { openItem } from "../canvas/store";

/**
 * A mail's file, opened where TempCode shows such a file (docs/agents/work-mail.md "Attachments"): the canvas kind
 * `kindForFile` names, as an item of the pane beside the mail (a thread's, or the Mail view's own), its bytes fetched
 * by the host from LifeOS's store. A file no canvas shows here is saved to Downloads, as before.
 */

/** Where a reader's files open: the pane's host and owner. */
export interface FilePlace {
  env: string;
  pane: string;
}

/** The canvas kind that shows this file beside the mail, or null when it is only saved. A file names its mail thread, message and part, or the host cannot find it. */
export function viewKind(file: MailFile): CanvasKind | null {
  if (!file.threadId || !file.messageId || !file.partId) return null;
  const kind = kindForFile(file.name, file.contentType);
  return kind && FETCHED_KINDS.includes(kind) ? kind : null;
}

/** The attachment as a canvas source. */
export const attachmentSource = (file: MailFile): CanvasSource => ({
  at: "mail",
  threadId: file.threadId!,
  messageId: file.messageId!,
  partId: file.partId!,
  name: file.name,
  ...(file.contentType ? { contentType: file.contentType } : {}),
  ...(file.size !== undefined ? { size: file.size } : {}),
});

/** The kit's file members for one place: view what a canvas shows, save the rest. */
export function placeFiles(place: FilePlace, save: MailKit["saveFile"]): Pick<MailKit, "openFile" | "saveFile" | "viewsPictures" | "fileVerb"> {
  return {
    viewsPictures: true,
    fileVerb: (file) => (viewKind(file) ? "view" : "save"),
    saveFile: save,
    openFile: async (file) => {
      const kind = viewKind(file);
      if (!kind) return save(file);
      await openItem(place.env, place.pane, { kind, source: attachmentSource(file), title: file.name.slice(0, 200) });
      return "opened";
    },
  };
}

/** A kit whose files open beside the mail in this place; the rest of it is the window's one kit. */
export const placedKit = (kit: MailKit, place: FilePlace): MailKit => ({ ...kit, ...placeFiles(place, kit.saveFile) });
