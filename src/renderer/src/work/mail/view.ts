import { defineChunk } from "../../lib/lazyChunk";
import { Mail } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Mail row of a linked Work workspace and its view
 * (docs/agents/work-mail.md): LifeOS's mail client, filtered to the sector.
 * The row has no fact yet: an unread count would read LifeOS from the
 * column, before the view is opened.
 */
export const mailView: WorkViewDef = {
  id: "mail",
  label: "Mail",
  icon: Mail,
  order: 0,
  fact: () => null,
  chunk: defineChunk("work-mail-view", () => import("./MailView")),
};
