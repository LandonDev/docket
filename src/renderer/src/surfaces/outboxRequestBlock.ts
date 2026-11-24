import type { Block } from "../lib/session";

/**
 * A finished `outbox_request` call (a Work thread asking for his press) stands as its own row, drawn by the Outbox's
 * lazy chunk (work/outbox/RequestCard.tsx): the card when the host stored the request, one muted line when it refused
 * the ask. This check stays small: the parse and the card load with that chunk.
 */
export function isOutboxRequestBlock(block: Block): boolean {
  if (block.role !== "tool" || !block.tool?.detail) return false;
  const status = block.tool.status;
  if (status !== "completed" && status !== "failed") return false;
  const name = (block.tool.name ?? "").replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");
  return name === "outbox_request";
}
