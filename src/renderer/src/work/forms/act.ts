import type { ActViews } from "../acts/registry";

/**
 * How the forms pillar's held acts are shown (`form.publish`;
 * docs/agents/work-forms.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const formsActs = {
  "form.publish": { kind: "form.publish", chunk: null },
} satisfies ActViews;
