import { useCallback, useEffect, useState } from "react";
import type { ComputerRow, ComputersAnswer } from "@server/shared/contract-devices";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { PageEmpty, PageError, PageRowsSkeleton } from "../../../components/page";
import { BusyLabel, Button } from "../../../components/ui/button";
import { ConfirmDialog, errorText } from "../../../chrome/ConfirmDialog";
import { computerParts, holdsParts, isGiverHere, syncedText } from "./computersText";
import { actOnComputer, onDevicesPush, readComputers } from "../../../lib/devicesClient";
import { Facts } from "./Facts";
import { Group, Row } from "./Group";

/**
 * Settings → Hosts → Computers (docs/agents/pc-setup.md "The screens"): the
 * giver, the box and each computer set up from a link, with what it holds and
 * when it last synced. Stop and Start and Remove on a given computer; the
 * box's row has neither (what it holds changes on the Accounts page). Read
 * once and again on every `device-acked`, `device-joined` or `device-gone`.
 */

/** The answer, read on mount and on each push about a computer. */
export function useComputers(): { answer: ComputersAnswer | null; error: string | null; refresh: () => Promise<void> } {
  const [answer, setAnswer] = useState<ComputersAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setAnswer(await readComputers());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
    return onDevicesPush({ computers: () => void refresh() });
  }, [refresh]);
  return { answer, error, refresh };
}

export type ComputerAction = "stop" | "start" | "remove";

export interface ComputersBlockProps {
  answer: ComputersAnswer | null;
  error: string | null;
  /** This desktop is the giver: it sets computers up; any other uses a link. */
  giverHere: boolean;
  onRetry: () => void;
  onSetUp: () => void;
  onUseLink: () => void;
  /** Resolves once the box took it; a refusal rejects with its reason. */
  onAct: (envId: string, action: ComputerAction) => Promise<void>;
  now?: number;
}

/** Runs one action on the box and reads the list again; `ok: false` is the box out of reach. */
export async function runComputerAction(envId: string, action: ComputerAction, refresh: () => Promise<void>): Promise<void> {
  const { ok } = await actOnComputer(envId, action);
  await refresh();
  if (!ok) throw new Error("The box is not connected");
}

export function ComputersGroup({ saved, onSetUp, onUseLink }: Pick<ComputersBlockProps, "onSetUp" | "onUseLink"> & { saved: readonly SavedEnvironment[] }) {
  const { answer, error, refresh } = useComputers();
  return (
    <ComputersBlock
      answer={answer}
      error={error}
      giverHere={isGiverHere(answer?.giver ?? null, saved)}
      onRetry={() => void refresh()}
      onSetUp={onSetUp}
      onUseLink={onUseLink}
      onAct={(envId, action) => runComputerAction(envId, action, refresh)}
    />
  );
}

/** The group with everything it shows passed in (the dom test and ui:preview render this). */
export function ComputersBlock({ answer, error, giverHere, onRetry, onSetUp, onUseLink, onAct, now = Date.now() }: ComputersBlockProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<ComputerRow | null>(null);
  const run = async (envId: string, action: ComputerAction): Promise<void> => {
    setBusy(envId);
    setErrors(({ [envId]: _gone, ...rest }) => rest);
    try {
      await onAct(envId, action);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [envId]: errorText(err) }));
    } finally {
      setBusy(null);
    }
  };
  const giver = answer?.giver ?? null;
  const box = answer?.box ?? null;
  const computers = answer?.computers ?? [];
  const empty = answer !== null && !giver && !box && computers.length === 0;

  return (
    <Group
      title="Computers"
      data-computers
      action={
        <Button variant="ghost" size="sm" onClick={giverHere ? onSetUp : onUseLink}>
          {giverHere ? "Set up a computer…" : "Use a setup link…"}
        </Button>
      }
    >
      {!answer && !error ? <PageRowsSkeleton rows={2} description control="none" /> : null}
      {error && !answer ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          {error}
        </PageError>
      ) : null}
      {empty ? <PageEmpty>No computers</PageEmpty> : null}
      {giver ? <Row data-computer-giver title={giver.name} description="Giver" /> : null}
      {box ? (
        <Row data-computer-box={box.envId} title={box.name} description={<Facts parts={[...holdsParts(box.holds), syncedText(box.syncedAt, now)]} />} />
      ) : null}
      {computers.map((c) => {
        const pending = busy === c.envId;
        return (
          <Row
            key={c.envId}
            data-computer={c.envId}
            title={c.name}
            description={<Facts parts={computerParts(c, now)} />}
            error={errors[c.envId] ?? c.lastError ?? undefined}
          >
            {c.waitingForContact ? null : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void run(c.envId, c.state === "stopped" ? "start" : "stop")}
                >
                  <BusyLabel busy={pending} label={c.state === "stopped" ? "Start" : "Stop"} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy !== null}
                  onClick={() => setRemoving(c)}
                >
                  Remove
                </Button>
              </>
            )}
          </Row>
        );
      })}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}`}
          body="Its accounts, LifeOS sign-in and setup folders go the next time it is in touch."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => onAct(removing.envId, "remove")}
          onDone={() => setRemoving(null)}
        />
      ) : null}
    </Group>
  );
}
