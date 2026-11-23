import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the messages pillar's held reply is shown in the Outbox (`chat.reply`;
 * docs/agents/work-messages.md): where it goes, the message it answers as one
 * quoted line, then its words exactly as they go.
 */
export const messagesActs = {
  "chat.reply": { kind: "chat.reply", chunk: defineChunk("work-messages-act", () => import("./ChatReplyAct")) },
} satisfies ActViews;
