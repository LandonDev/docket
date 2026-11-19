import { defineChunk } from "../../lib/lazyChunk";
import { Task } from "../icons";
import type { WorkViewDef } from "../views/registry";
import { useOpenCount } from "./facts";

/**
 * The Tasks row of a linked Work workspace and its view (docs/agents/work-tasks.md):
 * the sector's open tasks from LifeOS, through the shared task client.
 */
export const tasksView: WorkViewDef = {
  id: "tasks",
  label: "Tasks",
  icon: Task,
  order: 1,
  fact: () => null,
  useFact: useOpenCount,
  chunk: defineChunk("work-tasks-view", () => import("./TasksView")),
};
