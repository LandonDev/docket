import type { ActViews } from "../acts/registry";

/**
 * How the Microsoft Forms pillar's held acts are shown (`msform.make`,
 * `msform.publish`; docs/agents/work-msforms.md). Both draw the Outbox's
 * generic view: the summary, then the form in words as the payload's
 * `content` holds it, which is what his press makes or collects.
 */
export const msformsActs = {
  "msform.make": { kind: "msform.make", chunk: null },
  "msform.publish": { kind: "msform.publish", chunk: null },
} satisfies ActViews;
