import { useCallback, useEffect, useMemo, useState } from "react";
import type { OfficeApp, TeamsLibrariesAnswer, VmOfficeStatus } from "@shared/contract-work-office";
import { LIVE_RESIZE_WORDS, WINVM_EVALUATION_ENDS, type WinvmDetail, type WinvmPoint, type WinvmScreen, type WinvmSettings, type WinvmSleepAfter, type WinvmState } from "@shared/contract-work-winvm";
import { ModalBody, ModalPanel } from "../../chrome/Modal";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { SettingSwitch } from "../../components/setting-switch";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import { registry } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";
import { hostName } from "../../lib/threadResources";
import { dayTime } from "../../lib/duration";
import { useLinkMay } from "../../lib/linkMay";
import { signInOnVm } from "./signIn";

/**
 * Settings → Work, Windows VM (docs/DESIGN.md "Settings → Work"; the keeper,
 * docs/agents/work-winvm.md): the box's standing Windows machine on each Work
 * host that can have one. One row says what it is doing with the one press
 * that fits (Set up, Wake, Sleep), then when it sleeps by itself, its
 * screen (Live resize with Turn on… and Turn off…, Screen size, Detail), its
 * restore points (a dialog), the edition, and Office and OneDrive as last read
 * in it (`work.office.vmStatus`, which never wakes it), with OneDrive's
 * sign-in where it needs his. A host that cannot have it (a Mac, a box with
 * no base image) shows nothing. Set up, the settings and going back to or
 * deleting a point are the host's admin rule; Wake, Sleep, Save a point and
 * the sign-in need operate: a press this window's key may not make is not
 * drawn, and the setting it would change stands as plain words.
 */

const RESIZE_STEPS = new Set<string>(Object.values(LIVE_RESIZE_WORDS));
/** Live resize is being turned on or off: its own row says the step, the Windows row says only that it is busy. */
export const resizing = (state: WinvmState): boolean => state.state === "setting-up" && !!state.step && RESIZE_STEPS.has(state.step);

/** The machine's row: its state in a few words, and the one press that fits it. */
export function winvmRow(state: WinvmState): { words: string; press: "setup" | "wake" | "sleep" | null; busy: boolean } {
  const doing = state.step;
  switch (state.state) {
    case "none":
      return { words: "Not set up", press: "setup", busy: false };
    case "setting-up":
      if (resizing(state)) return { words: "Changing its display", press: null, busy: false };
      return { words: doing ?? "Setting up", press: null, busy: true };
    case "asleep":
      return { words: "Asleep", press: "wake", busy: false };
    case "waking":
      return { words: doing ?? "Waking", press: null, busy: true };
    case "awake":
      return { words: "Awake", press: "sleep", busy: false };
    case "going-to-sleep":
      return { words: "Going to sleep", press: null, busy: true };
    default:
      // a state this window does not know (a newer host, or an answer that is no state): its step, and no press
      return { words: doing ?? "Not known", press: null, busy: false };
  }
}

/** An answer that is no state or no list of points is a failed read, never drawn: its fields would be missing. */
export function stateOf(answer: unknown): WinvmState {
  if (typeof (answer as WinvmState | null)?.state !== "string") throw new Error("its answer was not the Windows VM's state");
  return answer as WinvmState;
}
export function pointsOf(answer: unknown): WinvmPoint[] {
  const points = (answer as { points?: unknown } | null)?.points;
  if (!Array.isArray(points)) throw new Error("its answer was not a list of restore points");
  return points as WinvmPoint[];
}

const PRESS_WORDS = { setup: "Set up", wake: "Wake", sleep: "Sleep" } as const;
/** A refused or lost press, after the host's name: "The box did not wake the Windows VM." */
const PRESS_FAILED = { setup: "did not start setting up the Windows VM", wake: "did not wake the Windows VM", sleep: "did not put the Windows VM to sleep" } as const;
const SLEEP_AFTER: { value: WinvmSleepAfter; label: string }[] = [
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "2h", label: "2 hours" },
  { value: "never", label: "Never" },
];
/** The guest's screen: his window's size while he drives (live resize), or one fixed size (docs/agents/live-video.md "The Windows VM"). */
const SCREENS: { value: WinvmScreen; label: string }[] = [
  { value: "fit", label: "Fit to window" },
  { value: "1280x800", label: "1280 × 800" },
  { value: "1920x1200", label: "1920 × 1200" },
  { value: "2560x1600", label: "2560 × 1600" },
];
const DETAILS: { value: WinvmDetail; label: string }[] = [
  { value: "sharp", label: "Sharp" },
  { value: "faster", label: "Faster" },
];
/** The confirms of Live resize: Turn on's words are the plan's ("The standing VM"). */
export const TURN_ON = {
  title: "Turn on live resize?",
  body: "Windows restarts once. Save your work in it first. Sign-ins stay. A restore point is saved first, in place of your oldest if you have three.",
  action: "Turn on",
} as const;
export const TURN_OFF = {
  title: "Turn off live resize?",
  body: "Windows restarts once, at 1280 × 800. Save your work in it first. Sign-ins stay.",
  action: "Turn off",
} as const;

const APP_NAME: Record<OfficeApp, string> = { excel: "Excel", word: "Word", powerpoint: "PowerPoint", outlook: "Outlook" };
const listed = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** A line of the VM's Office or OneDrive row, and whether its sign-in is the press. */
export interface VmLine {
  words: string;
  signIn?: true;
  failed?: true;
}

/** Office in the VM as last read: not read yet, not installed, which apps and who it is signed in as, or the sign-in. */
export function officeLine(status: VmOfficeStatus): VmLine {
  const office = status.office;
  if (!office) return { words: "Not read yet" };
  if (!office.installed) return { words: "Not installed" };
  const apps = listed(office.apps.filter((a) => a !== "outlook").map((a) => APP_NAME[a])) || "Installed";
  if (!office.account) return { words: `${apps}. Sign in to finish`, signIn: true };
  return { words: `${apps}, signed in as ${office.account}${office.licensed === false ? ", with no licence" : ""}` };
}

/** OneDrive in the VM: who it is signed in as and how many Teams libraries it syncs, or the sign-in. */
export function onedriveLine(status: VmOfficeStatus, libraries: number | null): VmLine | null {
  const place = status.onedrive;
  const count = libraries === null ? "" : libraries ? `, ${libraries} Teams ${libraries === 1 ? "library" : "libraries"}` : ", no Teams library synced yet";
  switch (place.state) {
    case "ok":
    case "no-libraries":
      return { words: `Signed in as ${place.account ?? "you"}${place.state === "no-libraries" ? ", no Teams library synced yet" : count}` };
    case "signed-out":
      return { words: "Signed out", signIn: true };
    case "no-onedrive":
      return { words: "Not installed" };
    case "error":
      return { words: place.detail ?? "Could not be read", failed: true };
    case "reading":
      return { words: "Reading…" };
    case "not-set-up":
      return null;
  }
}

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
  /** A failed read of the points: its own line with Retry, never "None yet". */
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [screen, setScreen] = useState<WinvmScreen | null>(null);
  const [detail, setDetail] = useState<WinvmDetail | null>(null);
  const [turning, setTurning] = useState(false);
  const [resizeError, setResizeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const [office, setOffice] = useState<{ status: VmOfficeStatus; libraries: number | null } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  /** his Retry of the machine's read is out */
  const [retrying, setRetrying] = useState(false);
  const link = useMemo(() => registry.linkOf(env), [env]);
  const admin = useLinkMay(env, "work.winvm.settings");
  const operate = useLinkMay(env, "work.winvm.wake");
  // A failed read keeps its line until the answer replaces it: his Retry spins on it meanwhile, never a bone.
  const loadPoints = useCallback((): Promise<void> => {
    return link.request<{ points: WinvmPoint[] }>("work.winvm.points", {}).then(pointsOf).then(
      (p) => {
        setPoints(p);
        setPointsError(null);
      },
      (err: unknown) => {
        setPoints(null);
        setPointsError(hostFailure(env, err, "could not read the restore points"));
      },
    );
  }, [link, env]);
  const load = useCallback((): Promise<void> => {
    const read = link.request<WinvmState>("work.winvm.state", {}).then(stateOf).then(
      (s) => {
        setState(s);
        setError(null);
      },
      (err: unknown) => setError(hostFailure(env, err, "could not read the Windows VM")),
    );
    void loadPoints();
    // The screen size is read with the settings, the admin rule: a key that may not change it never asks.
    if (admin)
      void link.request<WinvmSettings>("work.winvm.settings", {}).then(
        (v) => {
          setScreen(v.screen);
          setDetail(v.detail ?? null);
        },
        () => {
          setScreen(null);
          setDetail(null);
        },
      );
    // A host on an older build has no status to give: then the rows are not drawn.
    void Promise.all([
      link.request<VmOfficeStatus>("work.office.vmStatus", {}),
      link.request<TeamsLibrariesAnswer>("work.office.filesLibraries", {}).then(
        (a) => a.libraries.filter((l) => l.vm && l.kind !== "mine").length,
        () => null,
      ),
    ]).then(
      ([status, libraries]) => setOffice({ status, libraries }),
      () => setOffice(null),
    );
    return read;
  }, [link, env, admin, loadPoints]);
  useEffect(() => {
    void load();
    const offPush = link.onPush((push) => {
      if (push.push === "work.winvm") setState(push.state as WinvmState);
      if (push.push === "work.winvm.points") {
        setPoints(push.points as WinvmPoint[]);
        setPointsError(null);
      }
    });
    const offOpen = link.onOpen(() => void load());
    return () => {
      offPush();
      offOpen();
    };
  }, [link, load]);

  // a host that cannot have it shows nothing; one whose read failed says so with Retry, which spins until the answer
  if (state?.cannot) return null;
  const title = named ? `Windows VM on ${hostName(env)}` : "Windows VM";
  if (!state)
    return (
      <PageSection title={title}>
        {error ? (
          <PageError
            action={
              <Button
                variant="ghost"
                size="sm"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  void load().finally(() => setRetrying(false));
                }}
              >
                <BusyLabel busy={retrying} label="Retry" />
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
      setError(hostFailure(env, err, PRESS_FAILED[verb], true));
    } finally {
      setPressing(false);
    }
  };
  const setSleepAfter = async (sleepAfter: WinvmSleepAfter): Promise<void> => {
    try {
      setState({ ...state, sleepAfter });
      await link.request("work.winvm.settings", { sleepAfter });
    } catch (err) {
      setError(hostFailure(env, err, "did not save the change", true));
      void load();
    }
  };
  const signIn = async (): Promise<void> => {
    setSigningIn(true);
    setSignInError(null);
    try {
      await signInOnVm(env);
    } catch (err) {
      setSignInError(hostFailure(env, err, "did not open the sign-in"));
    } finally {
      setSigningIn(false);
    }
  };
  const pickScreen = async (next: { screen: WinvmScreen } | { detail: WinvmDetail }): Promise<void> => {
    try {
      if ("screen" in next) setScreen(next.screen);
      else setDetail(next.detail);
      await link.request("work.winvm.settings", next);
    } catch (err) {
      setError(hostFailure(env, err, "did not save the change", true));
      void load();
    }
  };
  const turn = async (on: boolean): Promise<void> => {
    if (!(await confirmAction(on ? TURN_ON : TURN_OFF))) return;
    setTurning(true);
    setResizeError(null);
    try {
      // answered at once: the steps come as the state's pushes
      await link.request(on ? "work.winvm.display.upgrade" : "work.winvm.display.downgrade", {});
    } catch (err) {
      setResizeError(hostFailure(env, err, on ? "did not turn on live resize" : "did not turn off live resize", true));
    } finally {
      setTurning(false);
    }
  };
  return (
    <>
      <WinvmView
        title={title}
        state={state}
        points={points}
        pointsError={pointsError}
        onRetryPoints={loadPoints}
        screen={screen}
        detail={detail}
        error={error}
        pressing={pressing}
        onPress={() => void press()}
        onSleepAfter={(v) => void setSleepAfter(v)}
        onScreen={(v) => void pickScreen({ screen: v })}
        onDetail={(v) => void pickScreen({ detail: v })}
        resize={{ busy: turning, error: resizeError, onTurn: (on) => void turn(on) }}
        onPoints={() => setShowPoints(true)}
        office={office}
        signIn={operate ? { busy: signingIn, error: signInError, onPress: () => void signIn() } : undefined}
        may={{ admin, operate }}
      />
      {showPoints ? <PointsDialog env={env} state={state} points={points ?? []} admin={admin} onClose={() => setShowPoints(false)} /> : null}
    </>
  );
}

export interface WinvmViewProps {
  title: string;
  state: WinvmState;
  points: readonly WinvmPoint[] | null;
  /** the points' read failed, in his words: the row says so with Retry */
  pointsError?: string | null;
  /** his Retry: it spins until what it returns settles */
  onRetryPoints?: () => void | Promise<void>;
  /** the guest's screen size; null until the host has said */
  screen: WinvmScreen | null;
  /** Sharp or Faster; null until the host has said */
  detail?: WinvmDetail | null;
  onDetail?: (v: WinvmDetail) => void;
  /** his Turn on… and Turn off…: the press in flight and its refusal */
  resize?: { busy: boolean; error: string | null; onTurn: (on: boolean) => void };
  error: string | null;
  pressing: boolean;
  onPress: () => void;
  onSleepAfter: (v: WinvmSleepAfter) => void;
  onScreen: (v: WinvmScreen) => void;
  onPoints: () => void;
  /** Office and OneDrive in it as last read, and his Teams libraries there; null: not known */
  office?: { status: VmOfficeStatus; libraries: number | null } | null;
  signIn?: { busy: boolean; error: string | null; onPress: () => void };
  /** What this window's key may do on the host (`linkMay`): `admin` sets it up and changes its settings, `operate` wakes and sleeps it. */
  may?: { admin: boolean; operate: boolean };
}

/** The section, pure: the machine's row and, once it is set up, when it sleeps, its points, the edition and Office. */
export function WinvmView({ title, state, points, pointsError, onRetryPoints, screen, detail = null, onDetail, resize, error, pressing, onPress, onSleepAfter, onScreen, onPoints, office, signIn, may = { admin: true, operate: true } }: WinvmViewProps) {
  const row = winvmRow(state);
  const [retryingPoints, setRetryingPoints] = useState(false);
  // a host before live resize says no display: its rows are as they were
  const display = state.display;
  const live = display?.device === "virtio";
  const turning = resizing(state);
  const press = row.press && (row.press === "setup" ? may.admin : may.operate) ? row.press : null;
  const officeRow = office ? officeLine(office.status) : null;
  const onedriveRow = office ? onedriveLine(office.status, office.libraries) : null;
  // One sign-in serves both rows: OneDrive's account is Office's. Its press sits on the first row that needs it.
  const pressOn = onedriveRow?.signIn ? "onedrive" : officeRow?.signIn ? "office" : null;
  const signInPress = signIn ? (
    <Button variant="secondary" size="sm" disabled={signIn.busy} onClick={signIn.onPress}>
      <BusyLabel busy={signIn.busy} label="Sign in" />
    </Button>
  ) : null;
  return (
    <PageSection title={title}>
      <PageRow title="Windows" description={row.words} error={state.blocked ?? state.error ?? error ?? undefined}>
        {press ? (
          <Button variant="secondary" size="sm" disabled={pressing} onClick={onPress}>
            <BusyLabel busy={pressing} label={PRESS_WORDS[press]} />
          </Button>
        ) : row.press || !row.busy ? null : (
          <Button variant="secondary" size="sm" disabled>
            <BusyLabel busy label={state.state === "setting-up" ? "Set up" : state.state === "waking" ? "Wake" : "Sleep"} />
          </Button>
        )}
      </PageRow>
      {state.state !== "none" ? (
        <>
          {may.admin ? (
            <PageRow title="Sleeps after">
              <ChoiceSelect size="sm" label="Sleeps after" value={state.sleepAfter} options={SLEEP_AFTER} onChange={(v) => onSleepAfter(v as WinvmSleepAfter)} />
            </PageRow>
          ) : (
            <PageRow title="Sleeps after" description={SLEEP_AFTER.find((o) => o.value === state.sleepAfter)?.label} />
          )}
          {display ? (
            may.admin && resize ? (
              <PageRow title="Live resize" description={turning ? (state.step ?? undefined) : live ? "On" : "Off"} error={resize.error ?? undefined}>
                <Button variant="secondary" size="sm" disabled={resize.busy || turning || state.state === "setting-up"} onClick={() => resize.onTurn(!live)}>
                  <BusyLabel busy={resize.busy || turning} label={live ? "Turn off…" : "Turn on…"} />
                </Button>
              </PageRow>
            ) : (
              <PageRow title="Live resize" description={live ? "On" : "Off"} />
            )
          ) : null}
          {screen && may.admin ? (
            // on std VGA Windows keeps the size it was set up at through every sleep (guestScreen.ts): the choice is a new Set up's
            <PageRow title="Screen size" {...(live ? {} : { description: "Used when the VM is set up again" })}>
              <ChoiceSelect size="sm" label="Screen size" value={screen} options={SCREENS} onChange={(v) => onScreen(v as WinvmScreen)} />
            </PageRow>
          ) : null}
          {live && detail && may.admin && onDetail ? (
            <PageRow title="Detail">
              <ChoiceSelect size="sm" label="Detail" value={detail} options={DETAILS} onChange={(v) => onDetail(v as WinvmDetail)} />
            </PageRow>
          ) : null}
          {pointsError ? (
            <PageRow title="Restore points" error={pointsError}>
              {onRetryPoints ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={retryingPoints}
                  onClick={() => {
                    setRetryingPoints(true);
                    void Promise.resolve(onRetryPoints()).finally(() => setRetryingPoints(false));
                  }}
                >
                  <BusyLabel busy={retryingPoints} label="Retry" />
                </Button>
              ) : null}
            </PageRow>
          ) : (
            <PageRow
              title="Restore points"
              description={
                points === null ? (
                  // The count's own 16px line, a bone in its place while the read is out: nothing moves when it lands.
                  <span role="status" aria-label="Reading restore points" data-points-bone className="flex h-4 items-center">
                    <Skeleton className="h-3 w-36" />
                  </span>
                ) : points.length === 0 ? (
                  "None yet"
                ) : (
                  `${points.length} kept, the last ${dayTime(Math.max(...points.map((p) => p.at)))}`
                )
              }
              {...(may.admin || may.operate ? { onOpen: onPoints, openLabel: "Restore points", openDisabled: points === null } : {})}
            />
          )}
          <PageRow title="Edition" description={evaluationLine(WINVM_EVALUATION_ENDS)} />
          {officeRow ? (
            <PageRow title="Office" description={officeRow.words} error={pressOn === "office" ? (signIn?.error ?? undefined) : undefined}>
              {pressOn === "office" ? signInPress : null}
            </PageRow>
          ) : null}
          {onedriveRow ? (
            <PageRow
              title="OneDrive"
              description={onedriveRow.failed ? undefined : onedriveRow.words}
              error={onedriveRow.failed ? onedriveRow.words : pressOn === "onedrive" ? (signIn?.error ?? undefined) : undefined}
            >
              {pressOn === "onedrive" ? signInPress : null}
            </PageRow>
          ) : null}
        </>
      ) : null}
    </PageSection>
  );
}

/** Restore points: saved while it sleeps, three kept; going back after a confirm that says what is lost. */
export function PointsDialog({ env, state, points, admin, onClose }: { env: string; state: WinvmState; points: readonly WinvmPoint[]; admin: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asleep = state.state === "asleep";
  const link = registry.linkOf(env);
  const run = async (which: string, method: string, params: object, act: string): Promise<void> => {
    setBusy(which);
    try {
      await link.request(method, params);
      setError(null);
    } catch (err) {
      setError(hostFailure(env, err, act, true));
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
    if (ok) await run(`back:${point.id}`, "work.winvm.point.restore", { id: point.id }, "did not go back to the point");
  };
  const sorted = [...points].sort((a, b) => b.at - a.at);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <ModalPanel onClose={onClose} busy={busy !== null} title="Restore points" description={asleep ? "Up to three are kept." : "Points are saved and used while Windows sleeps."} size="sm">
        <ModalBody>
          {sorted.length === 0 ? <PageEmpty>None yet</PageEmpty> : null}
          {sorted.map((point) => (
            <PageRow key={point.id} title={point.name} description={dayTime(point.at)}>
              {/* Going back and deleting are the host's admin rule: a key that may only save points is not offered them. */}
              {admin ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" disabled={!asleep || busy !== null} onClick={() => void goBack(point)}>
                    <BusyLabel busy={busy === `back:${point.id}`} label="Go back…" />
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(`delete:${point.id}`, "work.winvm.point.delete", { id: point.id }, "did not delete the point")}>
                    <BusyLabel busy={busy === `delete:${point.id}`} label="Delete" />
                  </Button>
                </div>
              ) : null}
            </PageRow>
          ))}
          {error ? <PageError>{error}</PageError> : null}
          <div className="flex justify-end pt-3">
            <Button variant="secondary" size="sm" disabled={!asleep || busy !== null} onClick={() => void run("save", "work.winvm.point.save", {}, "did not save a point")}>
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
    void link.request<WinvmState>("work.winvm.state", {}).then(stateOf).then(setState, () => setState(null));
    return link.onPush((push) => push.push === "work.winvm" && setState(push.state as WinvmState));
  }, [env]);
  if (!state || state.cannot || state.state === "none") return null;
  return (
    <PageRow title="Computer use on the Windows VM">
      <SettingSwitch label="Computer use on the Windows VM" on={on} onChange={onChange} />
    </PageRow>
  );
}
