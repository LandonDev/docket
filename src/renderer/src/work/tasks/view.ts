import { defineChunk } from "../../lib/lazyChunk";
import { Task } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Tasks row of a linked Work workspace and its view (docs/agents/work-tasks.md).
 * A stub: its view says "Not built yet" and its row has no fact until the
 * tasks pillar's milestone (25) points `chunk` at its own module and fills `fact`.
 */
export const tasksView: WorkViewDef = {
  id: "tasks",
  label: "Tasks",
  icon: Task,
  order: 1,
  fact: () => null,
  chunk: defineChunk("work-tasks-view", () => import("../views/NotBuilt")),
};
