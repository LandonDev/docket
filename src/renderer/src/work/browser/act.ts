import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the browser pillar's held acts are shown (`teams.post` and `portal.submit`;
 * docs/agents/work-browser.md). A Teams post is drawn as he will see it posted,
 * under the chat it lands in; a portal's submit takes the generic view (the
 * act's summary and its payload as text).
 */
export const browserActs = {
  "teams.post": { kind: "teams.post", chunk: defineChunk("work-browser-act", () => import("./TeamsPostActView")) },
  "portal.submit": { kind: "portal.submit", chunk: null },
} satisfies ActViews;
