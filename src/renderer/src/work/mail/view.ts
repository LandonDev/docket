import { defineChunk } from "../../lib/lazyChunk";
import { Mail } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Mail row of a linked Work workspace and its view (docs/agents/work-mail.md).
 * A stub: its view says "Not built yet" and its row has no fact until the
 * mail pillar's milestone (23) points `chunk` at its own module and fills `fact`.
 */
export const mailView: WorkViewDef = {
  id: "mail",
  label: "Mail",
  icon: Mail,
  order: 0,
  fact: () => null,
  chunk: defineChunk("work-mail-view", () => import("../views/NotBuilt")),
};
