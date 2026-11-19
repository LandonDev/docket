import type { ActViews } from "../acts/registry";

/**
 * How the guests pillar's held acts are shown (`share.guestLink`;
 * docs/agents/work-guests.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const guestsActs = {
  "share.guestLink": { kind: "share.guestLink", chunk: null },
} satisfies ActViews;
