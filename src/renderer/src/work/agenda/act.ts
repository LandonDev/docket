import type { ActViews } from "../acts/registry";

/**
 * How the agenda pillar's held acts are shown (`calendar.op`;
 * docs/agents/work-agenda.md). A stub: `chunk: null` draws the Outbox's
 * generic view (the act's summary and its payload as text) until the pillar's
 * milestone gives the kind a view of its own.
 */
export const agendaActs = {
  "calendar.op": { kind: "calendar.op", chunk: null },
} satisfies ActViews;
