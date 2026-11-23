import type { ActViews } from "../acts/registry";

/**
 * How the messages pillar's held reply is shown (`chat.reply`;
 * docs/agents/work-messages.md). `chunk: null` draws the Outbox's generic
 * view (the act's summary and its payload as text) until the pillar's
 * screens give the kind a view of its own (`ChatReplyAct.tsx`).
 */
export const messagesActs = {
  "chat.reply": { kind: "chat.reply", chunk: null },
} satisfies ActViews;
