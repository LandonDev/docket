import { createElement } from "react";
import { defineChunk } from "../../lib/lazyChunk";
import { Mail } from "../icons";
import type { WorkViewDef } from "../views/registry";
import { useUnreadCount } from "./facts";
import { MailBones } from "./bones";

/**
 * The Mail row of a linked Work workspace and its view
 * (docs/agents/work-mail.md): LifeOS's mail client, filtered to the sector.
 * The row's fact is the sector's unread count (facts.ts). The list's head is
 * the view's head, so the frame draws no header of its own over it.
 */
export const mailView: WorkViewDef = {
  id: "mail",
  label: "Mail",
  icon: Mail,
  order: 0,
  readsLifeos: true,
  ownHead: true,
  fact: () => null,
  useFact: useUnreadCount,
  // Its list beside the reading pane, at the kept width: never the generic rows before Mail.
  bones: () => createElement(MailBones),
  chunk: defineChunk("work-mail-view", () => import("./MailView")),
};
