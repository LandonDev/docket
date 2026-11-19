import type { ActViews } from "../acts/registry";

/**
 * How the office pillar's held acts are shown (`office.mail.send` and `office.calendar.op`;
 * docs/agents/work-office.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const officeActs = {
  "office.mail.send": { kind: "office.mail.send", chunk: null },
  "office.calendar.op": { kind: "office.calendar.op", chunk: null },
} satisfies ActViews;
