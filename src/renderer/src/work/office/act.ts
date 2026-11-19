import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the office pillar's held acts are shown (`office.mail.send` and
 * `office.calendar.op`; docs/agents/work-office.md). A calendar act has its
 * own view: an invitation or a reply in the LifeOS calendar act's rows (Event,
 * When, Where, Invites, From, Reply). A mail takes the generic view, which
 * reads its headers and its html body as plain words.
 */
export const officeActs = {
  "office.mail.send": { kind: "office.mail.send", chunk: null },
  "office.calendar.op": { kind: "office.calendar.op", chunk: defineChunk("work-office-calendar-act", () => import("./CalendarActView")) },
} satisfies ActViews;
