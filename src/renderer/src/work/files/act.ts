import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the files pillar's held act is shown (`file.act`; docs/agents/work-files.md
 * "Agents"): the act's sentence heads the detail, and the view lists the files,
 * where they are now and where they go or what they are named.
 */
export const filesActs = {
  "file.act": { kind: "file.act", chunk: defineChunk("work-files-act", () => import("./FileActView")) },
} satisfies ActViews;
