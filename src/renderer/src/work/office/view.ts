import { Folder } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The Files row of a Work workspace and its view (docs/agents/work-teams-files.md "The Files view"): the
 * Teams and SharePoint libraries OneDrive syncs on the hosts the workspace may use. The row has no
 * fact: a count of files is not worth a glance. It reads the host, never LifeOS, so LifeOS's sign-in
 * and its "did not answer" line never stand over it.
 */
export const filesView: WorkViewDef = {
  id: "files",
  label: "Files",
  icon: Folder,
  order: 3.5,
  readsLifeos: false,
  fact: () => null,
  chunk: defineChunk("work-files-view", () => import("./FilesView")),
};
