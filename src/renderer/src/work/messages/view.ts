import { MessageMultiple } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";
import { useUnreadChats } from "./facts";

/**
 * The Messages row of a linked Work workspace and its view
 * (docs/agents/work-messages.md): the job's chat as LifeOS holds it, beside
 * Mail. The row's fact is the count of conversations waiting on him
 * (facts.ts). The list's head is the view's head, so the frame draws no
 * header over it. In the first paint: an icon, the chunk and a cheap hook.
 */
export const messagesView: WorkViewDef = {
  id: "messages",
  label: "Messages",
  icon: MessageMultiple,
  order: 0.5,
  readsLifeos: true,
  ownHead: true,
  fact: () => null,
  useFact: useUnreadChats,
  chunk: defineChunk("work-messages-view", () => import("./MessagesView")),
};
