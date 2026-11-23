import { Folder } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The Files row of a Work workspace and its view (docs/agents/work-files.md): the Files place, a finder with tabs
 * over every place a file can live in. It draws its own head (the tab row), reads the hosts and never LifeOS, so
 * LifeOS's sign-in and its "did not answer" line never stand over it; a place that is down greys its own row.
 * The row has no fact: a count of files is not worth a glance.
 */
export const filesView: WorkViewDef = {
  id: "files",
  label: "Files",
  icon: Folder,
  order: 3.5,
  readsLifeos: false,
  ownHead: true,
  fact: () => null,
  chunk: defineChunk("work-files-view", () => import("./FilesView")),
};
