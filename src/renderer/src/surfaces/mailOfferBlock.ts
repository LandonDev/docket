import type { Block } from "../lib/session";

/**
 * A completed `mail_offer` call (a mail chat's card: a draft, a rewrite, rows to act on, a task or an event) stands as
 * its own row, drawn by the mail pillar's lazy chunk (work/mail/chat/OfferCard.tsx). This check stays small: the
 * parse and the card load with that chunk.
 */
export function isMailOfferBlock(block: Block): boolean {
  if (block.role !== "tool" || block.tool?.status !== "completed") return false;
  const name = (block.tool.name ?? "").replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");
  return name === "mail_offer" && !!block.tool.detail?.includes("mailOffer");
}
