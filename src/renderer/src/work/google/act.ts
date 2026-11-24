import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the google pillar's held acts are shown (`share.google`, `google.edit`;
 * docs/agents/work-google.md): a share as its person, access and account; a
 * change as the words before and after, one block per change.
 */
export const googleActs = {
  "share.google": { kind: "share.google", chunk: defineChunk("work-google-act", () => import("./ShareActView")) },
  "google.edit": { kind: "google.edit", chunk: defineChunk("work-google-act-edit", () => import("./EditActView")) },
} satisfies ActViews;
