import { useCallback, useEffect, useState } from "react";
import { WINVM_EVALUATION_ENDS, type WinvmPoint, type WinvmSleepAfter, type WinvmState } from "@shared/contract-work-winvm";
import { ModalBody, ModalPanel } from "../../chrome/Modal";
import { confirmAction, errorText } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { SettingSwitch } from "../../components/setting-switch";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { registry } from "../../lib/connection";
import { dayTime } from "../../lib/duration";

/**
 * Settings → Work, Windows VM (docs/DESIGN.md "Settings → Work"; the keeper,
 * docs/agents/work-winvm.md): the box's standing Windows machine on each Work
 * host that can have one. One row says what it is doing with the one press
 * that fits (Set up, Wake, Sleep), then when it sleeps by itself, its
 * restore points (a dialog), the edition and Office. A host that cannot have
 * it (a Mac, a box with no base image) shows nothing.
 */

/** The machine's row: its state in a few words, and the one press that fits it. */
export function winvmRow(state: WinvmState): { words: string; press: "setup" | "wake" | "sleep" | null; busy: boolean } {
  const doing = state.step;
  switch (state.state) {
    case "none":
      return { words: "Not set up", press: "setup", busy: false };
    case "setting-up":
      return { words: doing ?? "Setting up", press: null, busy: true };
    case "asleep":
      return { words: "Asleep", press: "wake", busy: false };
    case "waking":
      return { words: doing ?? "Waking", press: null, busy: true };
    case "awake":
      return { words: "Awake", press: "sleep", busy: false };
    case "going-to-sleep":
      return { words: "Going to sleep", press: null, busy: true };
  }
}

const PRESS_WORDS = { setup: "Set up", wake: "Wake", sleep: "Sleep" } as const;
const SLEEP_AFTER: { value: WinvmSleepAfter; label: string }[] = [
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "2h", label: "2 hours" },
  { value: "never", label: "Never" },
];

/** The edition's line: what it is and when it ends. */
export const evaluationLine = (ends: string): string =>
  `Windows 11 Enterprise evaluation, ends about ${new Date(`${ends}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

export function WinvmSection({ hosts }: { hosts: readonly string[] }) {
  return (
    <>
      {hosts.map((env) => (
        <WinvmHost key={env} env={env} named={hosts.length > 1} />
      ))}
    </>
  );
}

function WinvmHost({ env, named }: { env: string; named: boolean }) {
  const [state, setState] = useState<WinvmState | null>(null);
  const [points, setPoints] = useState<WinvmPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const link = registry.linkOf(env);
  const load = useCallback((): void => {
    void link.request<WinvmState>("work.winvm.state", {}).then(
      (s) => {
        setState(s);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
    void link.request<{ points: WinvmPoint[] }>("work.winvm.points", {}).then(
      (p) => setPoints(p.points),
      () => setPoints([]),
    );
  }, [link]);
  useEffect(() => {
    load();
    const offPush = link.onPush((push) => {
      if (push.push === "work.winvm") setState(push.state as WinvmState);
      if (push.push === "work.winvm.points") setPoints(push.points as WinvmPoint[]);
    });
    const offOpen = link.onOpen(load);
    return () => {
      offPush();
      offOpen();
    };
  }, [link, load]);

  // a host that cannot have it shows nothing; one whose read failed says so with Retry
  if (state?.cannot) return null;
  const title = named ? `Windows VM on ${env}` : "Windows VM";
  if (!state)
    return (
      <PageSection title={title}>
        {error ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" onClick={load}>
                Retry
              </Button>
            }
          >
            {error}
          </PageError>
        ) : (
          <PageRowsSkeleton rows={3} description control="button" />
        )}
      </PageSection>
    );
  const press = async (): Promise<void> => {
    const verb = winvmRow(state).press;
    if (!verb || pressing) return;
    setPressing(true);
    try {
      await link.request(`work.winvm.${verb}`, {});
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPressing(false);
    }
  };
  const setSleepAfter = async (sleepAfter: WinvmSleepAfter): Promise<void> => {
    try {
      setState({ ...state, sleepAfter });
      await link.request("work.winvm.settings", { sleepAfter });
    } catch (err) {
      setError(errorText(err));
      load();
    }
  };
  return (
    <>
      <WinvmView title={title} state={state} points={points} error={error} pressing={pressing} onPress={() => void press()} onSleepAfter={(v) => void setSleepAfter(v)} onPoints={() => setShowPoints(true)} />
      {showPoints ? <PointsDialog env={env} state={state} points={points ?? []} onClose={() => setShowPoints(false)} /> : null}
    </>
  );
}

export interface WinvmViewProps {
  title: string;
  state: WinvmState;
  points: readonly WinvmPoint[] | null;
  error: string | null;
  pressing: boolean;
  onPress: () => void;
  onSleepAfter: (v: WinvmSleepAfter) => void;
  onPoints: () => void;
}

/** The section, pure: the machine's row and, once it is set up, when it sleeps, its points, the edition and Office. */
export function WinvmView({ title, state, points, error, pressing, onPress, onSleepAfter, onPoints }: WinvmViewProps) {
  const row = winvmRow(state);
  return (
    <PageSection title={title}>
      <PageRow title="Windows" description={row.words} error={state.error ?? error ?? undefined}>
        {row.press ? (
          <Button variant="secondary" size="sm" disabled={pressing} onClick={onPress}>
            <BusyLabel busy={pressing} label={PRESS_WORDS[row.press]} />
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled>
            <BusyLabel busy label={state.state === "setting-up" ? "Set up" : state.state === "waking" ? "Wake" : "Sleep"} />
          </Button>
        )}
      </PageRow>
      {state.state !== "none" ? (
        <>
          <PageRow title="Sleeps after">
            <ChoiceSelect size="sm" label="Sleeps after" value={state.sleepAfter} options={SLEEP_AFTER} onChange={(v) => onSleepAfter(v as WinvmSleepAfter)} />
          </PageRow>
          <PageRow
            title="Restore points"
            description={points === null ? undefined : points.length === 0 ? "None yet" : `${points.length} kept, the last ${dayTime(Math.max(...points.map((p) => p.at)))}`}
            onOpen={onPoints}
            openLabel="Restore points"
          />
          <PageRow title="Edition" description={evaluationLine(WINVM_EVALUATION_ENDS)} />
          <PageRow title="Office" description="Not installed" />
        </>
      ) : null}
    </PageSection>
  );
}

/** Restore points: saved while it sleeps, three kept; going back after a confirm that says what is lost. */
function PointsDialog({ env, state, points, onClose }: { env: string; state: WinvmState; points: readonly WinvmPoint[]; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asleep = state.state === "asleep";
  const link = registry.linkOf(env);
  const run = async (which: string, method: string, params: object): Promise<void> => {
    setBusy(which);
    try {
      await link.request(method, params);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const goBack = async (point: WinvmPoint): Promise<void> => {
    const ok = await confirmAction({
      title: `Go back to ${point.name}?`,
      body: `What changed in Windows since ${dayTime(point.at)} is lost: files, apps and sign-ins.`,
      action: "Go back",
      danger: true,
    });
    if (ok) await run(`back:${point.id}`, "work.winvm.point.restore", { id: point.id });
  };
  const sorted = [...points].sort((a, b) => b.at - a.at);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <ModalPanel onClose={onClose} busy={busy !== null} title="Restore points" description={asleep ? "Up to three are kept." : "Points are saved and used while Windows sleeps."} size="sm">
        <ModalBody>
          {sorted.length === 0 ? <PageEmpty>None yet</PageEmpty> : null}
          {sorted.map((point) => (
            <PageRow key={point.id} title={point.name} description={dayTime(point.at)}>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" disabled={!asleep || busy !== null} onClick={() => void goBack(point)}>
                  <BusyLabel busy={busy === `back:${point.id}`} label="Go back…" />
                </Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(`delete:${point.id}`, "work.winvm.point.delete", { id: point.id })}>
                  <BusyLabel busy={busy === `delete:${point.id}`} label="Delete" />
                </Button>
              </div>
            </PageRow>
          ))}
          {error ? <PageError>{error}</PageError> : null}
          <div className="flex justify-end pt-3">
            <Button variant="secondary" size="sm" disabled={!asleep || busy !== null} onClick={() => void run("save", "work.winvm.point.save", {})}>
              <BusyLabel busy={busy === "save"} label="Save a point" />
            </Button>
          </div>
        </ModalBody>
      </ModalPanel>
    </Dialog>
  );
}

/**
 * A Work workspace's switch for the VM, on its own page under Where it runs: its threads get the `windows_*` tools.
 * Shown only where its host has a VM set up.
 */
export function WinvmWorkspaceRow({ env, on, onChange }: { env: string; on: boolean; onChange: (next: boolean) => Promise<boolean> }) {
  const [state, setState] = useState<WinvmState | null>(null);
  useEffect(() => {
    const link = registry.linkOf(env);
    void link.request<WinvmState>("work.winvm.state", {}).then(setState, () => setState(null));
    return link.onPush((push) => push.push === "work.winvm" && setState(push.state as WinvmState));
  }, [env]);
  if (!state || state.cannot || state.state === "none") return null;
  return (
    <PageRow title="Computer use on the Windows VM">
      <SettingSwitch label="Computer use on the Windows VM" on={on} onChange={onChange} />
    </PageRow>
  );
}
