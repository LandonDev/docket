import type { ActViews } from "../acts/registry";

/**
 * How the outbox pillar's held acts are shown (`computer.act` and `addon.call`;
 * docs/agents/work-outbox.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const outboxActs = {
  "computer.act": { kind: "computer.act", chunk: null },
  "addon.call": { kind: "addon.call", chunk: null },
} satisfies ActViews;
