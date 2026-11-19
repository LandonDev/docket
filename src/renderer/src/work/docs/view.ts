import { defineChunk } from "../../lib/lazyChunk";
import { Doc } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Docs row of a linked Work workspace and its view (docs/agents/work-docs.md).
 * A stub: its view says "Not built yet" and its row has no fact until the
 * docs pillar's milestone (20) points `chunk` at its own module and fills `fact`.
 */
export const docsView: WorkViewDef = {
  id: "docs",
  label: "Docs",
  icon: Doc,
  order: 3,
  fact: () => null,
  chunk: defineChunk("work-docs-view", () => import("../views/NotBuilt")),
};
