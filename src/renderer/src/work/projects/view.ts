import { defineChunk } from "../../lib/lazyChunk";
import { Project } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Projects row of a linked Work workspace and its view (docs/agents/work-projects.md):
 * the sector's LifeOS projects on the shared project screens (work-kit/projects).
 * No trailing fact: the cards under the rows already say which projects are live.
 */
export const projectsView: WorkViewDef = {
  id: "projects",
  label: "Projects",
  icon: Project,
  order: 1.5,
  fact: () => null,
  readsLifeos: true,
  chunk: defineChunk("work-projects-view", () => import("./ProjectsView")),
};
