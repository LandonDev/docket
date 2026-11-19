import { defineChunk } from "../../lib/lazyChunk";
import { Doc } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Docs row of a linked Work workspace and its view (docs/agents/work-docs.md
 * "The Docs view"): everything the workspace holds, searched, filtered and
 * grouped, a document opening in the shared editor there. The row has no fact: a count of documents is not
 * worth a glance.
 */
export const docsView: WorkViewDef = {
  id: "docs",
  label: "Docs",
  icon: Doc,
  order: 3,
  fact: () => null,
  chunk: defineChunk("work-docs-view", () => import("./DocsView")),
};
