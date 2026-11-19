import type { ActViews } from "../acts/registry";

/**
 * How the google pillar's held acts are shown (`share.google`;
 * docs/agents/work-google.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const googleActs = {
  "share.google": { kind: "share.google", chunk: null },
} satisfies ActViews;
