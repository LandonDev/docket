import type { ActViews } from "../acts/registry";

/**
 * How the browser pillar's held acts are shown (`teams.post` and `portal.submit`;
 * docs/agents/work-browser.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const browserActs = {
  "teams.post": { kind: "teams.post", chunk: null },
  "portal.submit": { kind: "portal.submit", chunk: null },
} satisfies ActViews;
