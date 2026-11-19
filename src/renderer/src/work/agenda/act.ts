import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the agenda pillar's held acts are shown (`calendar.op`;
 * docs/agents/work-agenda.md): what the act does in his words, then that
 * day's calendar with the act's slot set apart.
 */
export const agendaActs = {
  "calendar.op": { kind: "calendar.op", chunk: defineChunk("work-calendar-act", () => import("./CalendarActView")) },
} satisfies ActViews;
