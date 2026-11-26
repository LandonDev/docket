import { useCallback, useEffect, useState } from "react";
import type { ComputerRow, ComputersAnswer } from "@server/shared/contract-devices";
import { BusyLabel, Button } from "../../../components/ui/button";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { actOnComputer, onDevicesPush, readComputers } from "../../../lib/devicesClient";
import { thisDesktopInLine } from "../../../lib/native";
import { refusalWords } from "../../../lib/settingsHome";
import { computerParts } from "../hosts/computersText";
import { SettingRow, SettingSection } from "../parts/SettingRow";

export type ComputerAction = "stop" | "start" | "remove";

/** The computers set up from a link, read on mount and again on each push about one (docs/agents/pc-setup.md). */
export function useComputers(): { answer: ComputersAnswer | null; refresh: () => Promise<void> } {
  const [answer, setAnswer] = useState<ComputersAnswer | null>(null);
  const refresh = useCallback(async () => {
    try {
      setAnswer(await readComputers());
    } catch {
      // A box out of reach leaves the section away: the page's line already says the computer is offline.
    }
  }, []);
  useEffect(() => {
    void refresh();
    return onDevicesPush({ computers: () => void refresh() });
  }, [refresh]);
  return { answer, refresh };
}

/** Runs one act on the box and reads the list again; `ok: false` is the box out of reach. */
export async function runComputerAction(envId: string, action: ComputerAction, refresh: () => Promise<void>): Promise<void> {
  const { ok } = await actOnComputer(envId, action);
  await refresh();
  if (!ok) throw new Error("The box is not connected");
}

const CONFIRM: Record<"stop" | "remove", (name: string) => { title: string; body: string; action: string }> = {
  stop: (name) => ({ title: `Stop ${name}?`, body: "It is signed out of every account it was given until you start it again.", action: "Stop" }),
  remove: (name) => ({ title: `Remove ${name}?`, body: "Its accounts, LifeOS sign-in and setup folders go the next time it is in touch.", action: "Remove" }),
};

/**
 * Set up from this Mac: on the page of a computer he set up with a link, what it was given and when it last synced,
 * with Stop… or Start and Remove…. Absent for any other computer.
 */
export function SetUpHere({ environmentId }: { environmentId: string }) {
  const { answer, refresh } = useComputers();
  const row = answer?.computers.find((c) => c.envId === environmentId);
  return row ? <SetUpView row={row} onAct={(action) => runComputerAction(row.envId, action, refresh)} /> : null;
}

/** The section with its row passed in (the dom test and the preview draw this). */
export function SetUpView({ row, onAct, now = Date.now() }: { row: ComputerRow; onAct: (action: ComputerAction) => Promise<void>; now?: number }) {
  const [busy, setBusy] = useState<ComputerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: ComputerAction): Promise<void> => {
    if (action !== "start" && !(await confirmAction({ ...CONFIRM[action](row.name), danger: true }))) return;
    setBusy(action);
    setError(null);
    try {
      await onAct(action);
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setBusy(null);
    }
  };
  const stopped = row.state === "stopped";
  return (
    <SettingSection of="pc.setup" vars={{ mac: thisDesktopInLine() }}>
      <SettingRow id="pc.setup" description={computerParts(row, now).join(", ")} error={error ?? row.lastError ?? undefined}>
        {row.waitingForContact ? null : (
          <>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(stopped ? "start" : "stop")}>
              <BusyLabel busy={busy === "start" || busy === "stop"} label={stopped ? "Start" : "Stop…"} />
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy !== null} onClick={() => void run("remove")}>
              <BusyLabel busy={busy === "remove"} label="Remove…" />
            </Button>
          </>
        )}
      </SettingRow>
    </SettingSection>
  );
}
