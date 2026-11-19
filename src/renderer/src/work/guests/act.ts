import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the guests pillar's held act is shown (`share.guestLink`;
 * docs/agents/work-guests.md): the link an agent asked for, its item, who,
 * what they can do and the day it ends.
 */
export const guestsActs = {
  "share.guestLink": { kind: "share.guestLink", chunk: defineChunk("work-guests-act", () => import("./ShareActView")) },
} satisfies ActViews;
