import { useEffect, useState } from "react";
import type { MsFormView, MsMakeStage } from "@shared/contract-work-msforms";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { FolderRef } from "@shared/work/files";
import { registry, TimeoutError } from "../../lib/connection";
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

/** What the state line says while a make runs: before the host's first word, then each stage as it starts. */
export const MAKE_STAGE_WORDS: Record<MsMakeStage | "asked", string> = {
  asked: "Opening Forms…",
  opening: "Opening the folder in Forms…",
  making: "Making the form…",
  setting: "Turning off Accept responses…",
  naming: "Naming the form…",
  asking: "Adding the questions…",
};

/** His press's key: the host answers the same key with the make it started, never a second form. */
const pressKey = (): string => crypto.randomUUID().replace(/-/g, "");
const isTimeout = (err: unknown): boolean => err instanceof TimeoutError;

export function useFormMaking(workspace: Pick<WorkspaceMeta, "id" | "environmentId">): { offered: boolean; making: boolean; stage: string | null; make(kind: FormKind, at: FolderRef | null): Promise<void> } {
  const env = workspace.environmentId;
  const offered = useMsformsOffered(env, workspace.id);
  const [making, setMaking] = useState<{ op: string; stage: MsMakeStage | "asked" } | null>(null);
  const op = making?.op ?? null;
  useEffect(() => {
    if (!op) return;
    return registry.linkOf(env).onPush((push) => {
      if (push.push === "work.msforms.making" && push.workspaceId === workspace.id && push.op === op) setMaking((m) => (m?.op === op ? { op, stage: push.stage } : m));
    });
  }, [env, workspace.id, op]);
  const make = async (kind: FormKind, at: FolderRef | null): Promise<void> => {
    if (kind === "tempcode") {
      await openMadeTab(env, workspace.id, "work.forms.make", {}).then(
        () => undefined,
        (err: unknown) => sayError(err, "Couldn't make the form"),
      );
      return;
    }
    if (!at || at.at !== "file") return sayError(null, "Microsoft forms are made in a Teams or OneDrive folder.");
    const key = pressKey();
    setMaking({ op: key, stage: "asked" });
    try {
      const ask = { workspaceId: workspace.id, folder: { at: "file", host: at.host, path: at.path }, title: "Untitled form", op: key };
      const link = registry.linkOf(env);
      // A wait that ran out asks once more with the same key: the host answers the make it already started.
      const view = await link.request<MsFormView>("work.msforms.make", ask, { timeoutMs: MAKE_MS }).catch((err: unknown) => (isTimeout(err) ? link.request<MsFormView>("work.msforms.make", ask, { timeoutMs: MAKE_MS }) : Promise.reject(err)));
      await openFileTab(env, workspace.id, { ref: { at: "msform", host: env, workspaceId: workspace.id, formId: view.formId, tenant: view.tenant }, name: view.title });
    } catch (err) {
      sayError(err, "Couldn't make the form in Forms");
    } finally {
      setMaking(null);
    }
  };
  return { offered, making: !!making, stage: making ? MAKE_STAGE_WORDS[making.stage] : null, make };
}
