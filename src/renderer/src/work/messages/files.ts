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

/** A picture, drawn in place in the conversation. */
export const isPicture = (file: Pick<ChatFile, "contentType" | "name">): boolean =>
  file.contentType ? file.contentType.startsWith("image/") : /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(file.name);

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

/** A picture's drawn box: its own shape inside 360 by 270, never larger than it is; a square when its size is unknown. */
export function pictureBox(file: Pick<ChatFile, "width" | "height">): { width: number; height: number } {
  const w = file.width ?? 0;
  const h = file.height ?? 0;
  if (w <= 0 || h <= 0) return { width: 270, height: 270 };
  const scale = Math.min(1, 360 / w, 270 / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
