import type { Clash } from "@shared/work/clashes";
import { LOCAL_ENVIRONMENT_ID } from "../../lib/connection";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { workViewNow } from "../../lib/workSwitch";
import { shared } from "../tasks/store";

/**
 * Opening the Clash dialog from anywhere Work is on screen: an Agenda row, a
 * Today row. A small file: the dialog itself is the `work-clash` chunk, which
 * `ClashHost` (mounted by the Work shell) loads on the first ask.
 */
export type ClashAsk = {
  id: string;
  /** the host whose LifeOS session reads the clash and whose wire answers it */
  environmentId: string;
  /** the clash as the opener holds it, shown at once while the live read catches up */
  clash?: Clash;
};

export const clashAsk = shared<ClashAsk | null>(null);

/** With no host named, the one whose Work view is open, else this computer's. */
export function openClash(ask: { id: string; environmentId?: string; clash?: Clash }): void {
  const view = workViewNow();
  const environmentId = ask.environmentId ?? (view ? workspaceStore.workspace(view.workspaceId)?.environmentId : undefined) ?? LOCAL_ENVIRONMENT_ID;
  clashAsk.set({ id: ask.id, environmentId, ...(ask.clash ? { clash: ask.clash } : {}) });
}
