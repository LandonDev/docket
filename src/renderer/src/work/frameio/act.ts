import type { ActViews } from "../acts/registry";

/**
 * How the frameio pillar's held acts are shown (`frameio.post`;
 * docs/agents/work-frameio.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const frameioActs = {
  "frameio.post": { kind: "frameio.post", chunk: null },
} satisfies ActViews;
