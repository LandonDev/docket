import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the frameio pillar's held acts are shown (`frameio.post`;
 * docs/agents/work-frameio.md): a comment's file, time, marks and words, or a
 * version's stack, file and size.
 */
export const frameioActs = {
  "frameio.post": { kind: "frameio.post", chunk: defineChunk("work-frameio-act", () => import("./PostActView")) },
} satisfies ActViews;
