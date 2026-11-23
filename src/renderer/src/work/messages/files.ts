import type { CanvasKind, CanvasSource } from "@shared/work";
import type { ChatFile } from "@shared/work/messages";
import { FETCHED_KINDS } from "../canvas/fetched";
import { kindForFile } from "../canvas/registry";
import type { FileVerb } from "./data";

/**
 * A chat's file, opened where TempCode shows such a file (docs/agents/work-messages.md
 * "Pictures and files"): the canvas kind `kindForFile` names, as an item of the
 * Messages view's own pane, its bytes fetched by the host from LifeOS's store as
 * for a mail's attachment. A file no canvas shows is saved to Downloads.
 */

/** The canvas kind that shows a chat's file beside the conversation; null for one only saved. */
export function viewKind(file: Pick<ChatFile, "name" | "contentType">): CanvasKind | null {
  const kind = kindForFile(file.name, file.contentType);
  return kind && FETCHED_KINDS.includes(kind) ? kind : null;
}

export const fileVerb = (file: Pick<ChatFile, "name" | "contentType">): FileVerb => (viewKind(file) ? "view" : "save");

/** A chat's file as a canvas source: the mail arm, from a chat, which the host fetches as the owner inside the pane's sector. */
export const chatFileSource = (chatId: string, messageId: string, file: Pick<ChatFile, "_id" | "name" | "contentType" | "size">): CanvasSource => ({
  at: "mail",
  from: "chat",
  threadId: chatId,
  messageId,
  partId: file._id,
  name: file.name,
  ...(file.contentType ? { contentType: file.contentType } : {}),
  ...(file.size !== undefined ? { size: file.size } : {}),
});

export { isPicture, pictureBox } from "./model";
