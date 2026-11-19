import type { ActViews } from "../acts/registry";

/**
 * How the mail pillar's held acts are shown (`mail.send`;
 * docs/agents/work-mail.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const mailActs = {
  "mail.send": { kind: "mail.send", chunk: null },
} satisfies ActViews;
