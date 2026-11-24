import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the Microsoft Forms pillar's held acts are shown (`msform.make`,
 * `msform.publish`; docs/agents/work-msforms.md). Both draw one view: the form in words as
 * the payload's `content` holds it, which is what his press makes or collects.
 */
const view = defineChunk("work-msforms-act", () => import("./FormActView"));

export const msformsActs = {
  "msform.make": { kind: "msform.make", chunk: view },
  "msform.publish": { kind: "msform.publish", chunk: view },
} satisfies ActViews;
