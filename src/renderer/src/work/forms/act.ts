import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the forms pillar's held acts are shown (`form.publish`;
 * docs/agents/work-forms.md): how many questions, then the form in words.
 */
export const formsActs = {
  "form.publish": { kind: "form.publish", chunk: defineChunk("work-forms-act", () => import("./PublishActView")) },
} satisfies ActViews;
