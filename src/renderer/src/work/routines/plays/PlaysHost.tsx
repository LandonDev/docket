import { useEffect, useState } from "react";
import type { ContextChip } from "@shared/work";
import { defineChunk } from "../../../lib/lazyChunk";
import { workPlayPort } from "../../../lib/workSwitch";

const dialogs = defineChunk("work-plays", () => import("./PlaysDialogs"));
const RunAsk = dialogs.surface("RunAsk");
const SaveAsk = dialogs.surface("SaveAsk");

type Ask = { kind: "run"; environmentId: string; workspaceId: string; chip: ContextChip } | { kind: "save"; environmentId: string; sessionId: string };

/**
 * Fills `workPlayPort` while Work's shell is up (docs/agents/work-plays.md):
 * Run a play… on a mail, task, event or file, and Save as a play… on a
 * thread, each opening its dialog from the `work-plays` chunk. One at a time;
 * a second ask takes the first one's place.
 */
export function PlaysHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    workPlayPort.set({
      run: (a) => setAsk({ kind: "run", environmentId: a.environmentId, workspaceId: a.workspaceId, chip: a.chip as ContextChip }),
      save: (a) => setAsk({ kind: "save", ...a }),
    });
    return () => workPlayPort.set(null);
  }, []);
  if (!ask) return null;
  const close = () => setAsk(null);
  return ask.kind === "run" ? (
    <RunAsk key={`${ask.workspaceId} ${JSON.stringify(ask.chip.ref)}`} environmentId={ask.environmentId} workspaceId={ask.workspaceId} chip={ask.chip} onClose={close} />
  ) : (
    <SaveAsk key={ask.sessionId} environmentId={ask.environmentId} sessionId={ask.sessionId} onClose={close} />
  );
}
