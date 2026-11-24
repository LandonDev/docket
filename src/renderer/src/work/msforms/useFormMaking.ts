import { useState } from "react";
import type { MsFormView } from "@shared/contract-work-msforms";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { FolderRef } from "@shared/work/files";
import { registry } from "../../lib/connection";
import { sayError } from "../canvas/frame";
import { openFileTab, openMadeTab } from "../files/store";
import type { FormKind } from "./newForm";
import { MAKE_MS, useMsformsOffered } from "./offer";

export { MAKE_MS, useLibraryPlaces, useMsformsOffered } from "./offer";

/**
 * New → Form in the Files page (docs/agents/work-msforms.md "Making a form"): whether the workspace's host makes
 * Microsoft forms (asked once a window), and the make. Ours opens its draft in a tab at once; a Microsoft form is
 * made in Forms by the box browser (about a minute, said on the page's state line), then opens in its tab.
 */

export function useFormMaking(workspace: Pick<WorkspaceMeta, "id" | "environmentId">): { offered: boolean; making: boolean; make(kind: FormKind, at: FolderRef | null): Promise<void> } {
  const env = workspace.environmentId;
  const offered = useMsformsOffered(env, workspace.id);
  const [making, setMaking] = useState(false);
  const make = async (kind: FormKind, at: FolderRef | null): Promise<void> => {
    if (kind === "tempcode") {
      await openMadeTab(env, workspace.id, "work.forms.make", {}).then(
        () => undefined,
        (err: unknown) => sayError(err, "Couldn't make the form"),
      );
      return;
    }
    if (!at || at.at !== "file") return sayError(null, "Microsoft forms are made in a Teams or OneDrive folder.");
    setMaking(true);
    try {
      const view = await registry.linkOf(env).request<MsFormView>("work.msforms.make", { workspaceId: workspace.id, folder: { at: "file", host: at.host, path: at.path }, title: "Untitled form" }, { timeoutMs: MAKE_MS });
      await openFileTab(env, workspace.id, { ref: { at: "msform", host: env, workspaceId: workspace.id, formId: view.formId, tenant: view.tenant }, name: view.title });
    } catch (err) {
      sayError(err, "Couldn't make the form in Forms");
    } finally {
      setMaking(false);
    }
  };
  return { offered, making, make };
}
