import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIVE_RESIZE_WORDS, type WinvmDetail, type WinvmPoint, type WinvmScreen, type WinvmSettings, type WinvmSleepAfter, type WinvmState } from "@shared/contract-work-winvm";
import { ModalBody, ModalPanel } from "../../../chrome/Modal";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../../components/choice-select";
import { SettingSwitch } from "../../../components/setting-switch";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../../components/page";
import { ReadFailure } from "../parts/ReadFailure";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Skeleton } from "../../../components/ui/skeleton";
import { registry, useEnvironments } from "../../../lib/connection";
import { NO_ANSWER } from "../../../lib/connection/openRead";
import { hostFailure } from "../../../lib/hostFailure";
import { useReadFailWords } from "../../../lib/settings/computerName";
import { dayTime } from "../../../lib/duration";
import { useLinkMay } from "../../../lib/linkMay";
import { useSettingsKnown, tellSettingsList } from "../../../lib/settings/useListWindow";
import { useWorkHosts } from "../../../lib/workSwitch";
import { SettingRow } from "../parts/SettingRow";
import { useSaved, type Saved } from "../parts/useSaved";

/**
 * Settings › Windows VM, "A Windows computer inside the box, for Office and Teams." (docs/agents/settings.md "The
 * pages: computers"; the keeper, docs/agents/work-winvm.md): the box's standing Windows machine on the computer the
 * list names (`vmOn`). One row says what it is doing with the one press that fits (Set up, Wake, Sleep); then when it
 * sleeps by itself, its screen size (Fits my window, or a size: moving to Fits my window turns live resize on after a
 * confirm), its picture quality and its restore points (a dialog). Its sign-ins and its edition's end are Connections'
 * rows alone. Set up, the settings and going back to or deleting a point are the computer's admin rule; Wake, Sleep and
 * Save a point need operate: a press this window's key may not make is not drawn, and the setting it would change
 * stands as plain words.
 */

/** The guest's screen and picture quality, as the computer confirmed them. */
type Display = { screen: WinvmScreen; detail: WinvmDetail | null };
/** What a change on this page writes (`work.winvm.settings`), one setting a change. */
type Changes = { sleepAfter: WinvmSleepAfter; screen: WinvmScreen; detail: WinvmDetail };

const RESIZE_STEPS = new Set<string>(Object.values(LIVE_RESIZE_WORDS));
/** Live resize is being turned on or off: the Windows row says only that its display is changing. */
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
      // a state this window does not know (a newer computer, or an answer that is no state): its step, and no press
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
/** A refused or lost press, after the computer's name: "The box did not wake the Windows VM." */
const PRESS_FAILED = { setup: "did not start setting up the Windows VM", wake: "did not wake the Windows VM", sleep: "did not put the Windows VM to sleep" } as const;
const SLEEP_AFTER: { value: WinvmSleepAfter; label: string }[] = [
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "2h", label: "2 hours" },
  { value: "never", label: "Never" },
];
/** The guest's screen: his window's size while he drives (live resize), or one fixed size (docs/agents/live-video.md "The Windows VM"). */
export const SCREENS: { value: WinvmScreen; label: string }[] = [
  { value: "fit", label: "Fits my window" },
  { value: "1280x800", label: "1280 × 800" },
  { value: "1920x1200", label: "1920 × 1200" },
  { value: "2560x1600", label: "2560 × 1600" },
];
const QUALITIES: { value: WinvmDetail; label: string }[] = [
  { value: "sharp", label: "Sharp" },
  { value: "faster", label: "Faster" },
];
/** Fits my window on a machine without live resize turns it on: Windows restarts once (the plan's words, "The standing VM"). */
export const TURN_ON = {
  title: "Fit the Windows VM to your window?",
  body: "Windows restarts once. Save your work in it first. Sign-ins stay. A restore point is saved first, in place of your oldest if you have three.",
  action: "Restart and fit",
} as const;

/**
 * The computer that holds the Windows VM, told to Settings' list (mounted by SettingsView): the first computer with
 * Work on whose keeper can have one. The list then draws the Windows VM's row under that computer, and nowhere else.
 */
export function useWinvmKnown(): void {
  const environments = useEnvironments();
  const work = useWorkHosts();
  const hosts = useMemo(() => environments.filter((e) => work.has(e.id)).map((e) => e.id), [environments, work]);
  const key = hosts.join(",");
  useEffect(() => {
    if (!key) {
      tellSettingsList({ has: { winvm: false }, vmOn: null });
      return;
    }
    let live = true;
    void Promise.all(
      key.split(",").map((env) =>
        registry
          .linkOf(env)
          .request<WinvmState>("work.winvm.state", {})
          .then(stateOf)
          .then(
            (state) => (state.cannot ? null : env),
            () => null,
          ),
      ),
    ).then((found) => {
      if (!live) return;
      const vmOn = found.find((env): env is string => env !== null) ?? null;
      tellSettingsList({ has: { winvm: vmOn !== null }, vmOn });
    });
    return () => {
      live = false;
    };
  }, [key]);
}

/** `record` without `key`, a new object (the compiler takes no computed rest pattern). */
function without<T extends object>(record: T, key: keyof T): T {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/** The page: the computer the list says holds the VM, or a line where none does. */
export function WinvmPage() {
  const { vmOn } = useSettingsKnown();
  if (!vmOn)
    return (
      <PageSection>
        <PageEmpty>No computer here holds a Windows VM</PageEmpty>
      </PageSection>
    );
  return <WinvmHost key={vmOn} env={vmOn} />;
}

/** Fits my window's upgrade, waiting for its end: `seen` once a state said its display is changing. */
type UpgradeWait = { seen: boolean; resolve: (end: WinvmState) => void };

/** A state from the computer, against a waiting upgrade: it ends once the machine leaves its display steps (live resize
 *  on or not), or says a failure before any step; a state from before the first step is not its end. */
function settleUpgrade(wait: { current: UpgradeWait | null }, state: WinvmState): void {
  const waiting = wait.current;
  if (!waiting) return;
  if (state.state === "setting-up") {
    waiting.seen = true;
    return;
  }
  if (!waiting.seen && !state.error && state.display?.device !== "virtio") return;
  wait.current = null;
  waiting.resolve(state);
}

export function WinvmHost({ env }: { env: string }) {
  const [state, setState] = useState<WinvmState | null>(null);
  const [points, setPoints] = useState<WinvmPoint[] | null>(null);
  /** A failed read of the points: its own line with Retry, never "None yet". */
  const [pointsError, setPointsError] = useState<string | null>(null);
  /** The display settings as the computer last confirmed them; null until it has said. */
  const [settings, setSettings] = useState<Display | null>(null);
  /** Their newest read failed, said under their rows with its own Retry, over values already shown too. `null`
   *  words: no answer. */
  const [settingsError, setSettingsError] = useState<{ words: string | null } | null>(null);
  const readWords = useReadFailWords(env);
  /** A change on its way, shown at once; dropped when the computer answers either way. */
  const [pending, setPending] = useState<Partial<Changes>>({});
  /** Each select's save mark and refusal (`useSaved`): the reason stays on its own row until his next change of it. */
  const savers: Record<keyof Changes, Saved> = { sleepAfter: useSaved(), screen: useSaved(), detail: useSaved() };
  /** A press the computer refused (Set up, Wake, Sleep): the Windows row's own line. */
  const [error, setError] = useState<string | null>(null);
  /** The machine's read's own reason, for the page's one failure line. */
  const [readError, setReadError] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
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
  // The screen is read with the settings, the admin rule: a key that may not change it never asks. A read again that
  // fails keeps the values last confirmed and says so.
  const loadSettings = useCallback((): Promise<void> => {
    if (!admin) return Promise.resolve();
    return link.request<WinvmSettings>("work.winvm.settings", {}).then(
      (v) => {
        setSettings({ screen: v.screen, detail: v.detail ?? null });
        setSettingsError(null);
      },
      // No answer is said as every read says it ("The box did not answer."); a refusal in the act's words.
      (err: unknown) => setSettingsError({ words: err instanceof Error && err.message === NO_ANSWER ? null : hostFailure(env, err, "could not read the display settings") }),
    );
  }, [link, env, admin]);
  // Fits my window's upgrade, once the computer took it: waits for the state that ends it (a push, or a read after a
  // socket that dropped meanwhile).
  const upgradeEnd = useRef<UpgradeWait | null>(null);
  const load = useCallback((): Promise<void> => {
    const read = link.request<WinvmState>("work.winvm.state", {}).then(stateOf).then(
      (s) => {
        settleUpgrade(upgradeEnd, s);
        setState(s);
        setError(null);
      },
      (err: unknown) => {
        setError(hostFailure(env, err, "could not read the Windows VM"));
        setReadError(err instanceof Error ? err.message : String(err));
      },
    );
    void loadPoints();
    void loadSettings();
    return read;
  }, [link, env, loadPoints, loadSettings]);
  useEffect(() => {
    void load();
    const offPush = link.onPush((push) => {
      if (push.push === "work.winvm") {
        settleUpgrade(upgradeEnd, push.state as WinvmState);
        setState(push.state as WinvmState);
      }
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

  if (state?.cannot)
    return (
      <PageSection>
        <PageEmpty>{state.cannot}</PageEmpty>
      </PageSection>
    );
  // The machine's own read failed: said at the page's head, naming the computer; nothing stands under it.
  if (!state && error) return <ReadFailure computer={env} error={readError ?? ""} retry={load} />;
  if (!state)
    return (
      <PageSection>
        {/* As many rows as will land: a key that may change it gets its screen size and picture quality too. */}
        <PageRowsSkeleton
          rows={[
            { description: true, control: "button" },
            { control: admin ? "select" : "none", description: !admin },
            ...(admin ? ([{ control: "select" }, { control: "select" }] as const) : []),
            { description: true, control: "none" },
          ]}
        />
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
  /** A change he made shows at once and becomes the confirmed value once the computer takes it (and `then`, the step
   *  that must follow it, also went through); refused, the control goes back to the value last confirmed and its row
   *  says why, with the save mark meanwhile. Answers whether it was saved. */
  const save = <K extends keyof Changes>(field: K, value: Changes[K], then?: () => Promise<void>): Promise<boolean> => {
    setPending((p) => ({ ...p, [field]: value }));
    // Only this change's own value leaves pending: a newer pick of the same setting stays shown.
    const settle = (): void => setPending((p) => (p[field] === value ? without(p, field) : p));
    return savers[field]
      .run(async () => {
        try {
          await link.request("work.winvm.settings", { [field]: value });
        } catch (err) {
          throw new Error(hostFailure(env, err, "did not save the change", true));
        }
        await then?.();
        if (field === "sleepAfter") setState((s) => (s ? { ...s, sleepAfter: value as WinvmSleepAfter } : s));
        else setSettings((d) => (d ? { ...d, [field]: value } : d));
      })
      .finally(settle);
  };
  /** Fits my window where live resize is off turns it on: Windows restarts once, so it asks first, saves, and asks
   *  for the restart only once the save landed. A refused restart puts the size that stands back: without live resize
   *  Fits my window would not hold. */
  const pickScreen = async (screen: WinvmScreen): Promise<void> => {
    const live = state.display?.device === "virtio";
    if (screen === "fit" && state.display && !live) {
      if (!(await confirmAction(TURN_ON))) return;
      const before = settings?.screen;
      // A refused or failed upgrade puts the size that stood back: without live resize Fits my window would not hold.
      const putBack = async (): Promise<void> => {
        if (before && before !== "fit") await link.request("work.winvm.settings", { screen: before }).catch(() => void loadSettings());
      };
      await save("screen", screen, async () => {
        // The upgrade's end comes as the state's pushes, minutes later: the size stays saving until then.
        const ended = new Promise<WinvmState>((resolve) => {
          upgradeEnd.current = { seen: false, resolve };
        });
        try {
          // answered at once: the steps come as the state's pushes
          await link.request("work.winvm.display.upgrade", {});
        } catch (err) {
          upgradeEnd.current = null;
          await putBack();
          throw new Error(hostFailure(env, err, "did not fit the Windows VM to your window", true));
        }
        const end = await ended;
        if (end.display?.device !== "virtio") {
          await putBack();
          // The machine's own reason stands on the Windows row (its state's error); this row says what did not happen.
          throw new Error(hostFailure(env, null, "did not fit the Windows VM to your window", true));
        }
      });
      return;
    }
    await save("screen", screen);
  };
  return (
    <>
      <WinvmView
        state={pending.sleepAfter ? { ...state, sleepAfter: pending.sleepAfter } : state}
        points={points}
        pointsError={pointsError}
        onRetryPoints={loadPoints}
        settings={settings && { screen: pending.screen ?? settings.screen, detail: pending.detail ?? settings.detail }}
        settingsError={settingsError && (settingsError.words ?? readWords(NO_ANSWER))}
        onRetrySettings={loadSettings}
        saved={savers}
        error={error}
        pressing={pressing}
        onPress={() => void press()}
        onSleepAfter={(v) => void save("sleepAfter", v)}
        onScreen={(v) => void pickScreen(v)}
        onQuality={(v) => void save("detail", v)}
        onPoints={() => setShowPoints(true)}
        may={{ admin, operate }}
      />
      {showPoints ? <PointsDialog env={env} state={state} points={points ?? []} admin={admin} onClose={() => setShowPoints(false)} /> : null}
    </>
  );
}

export interface WinvmViewProps {
  state: WinvmState;
  points: readonly WinvmPoint[] | null;
  /** the points' read failed, in his words: the row says so with Retry */
  pointsError?: string | null;
  /** his Retry: it spins until what it returns settles */
  onRetryPoints?: () => void | Promise<void>;
  /** the guest's screen and picture quality; null until the computer has said (or for a key that may not ask) */
  settings: Display | null;
  /** their read failed before any answer: the screen's row says so, with Retry */
  settingsError?: string | null;
  onRetrySettings?: () => void | Promise<void>;
  /** each select's save mark and refusal, on its own row */
  saved?: Partial<Record<keyof Changes, Saved>>;
  /** a refused press (Set up, Wake, Sleep), on the Windows row */
  error: string | null;
  pressing: boolean;
  onPress: () => void;
  onSleepAfter: (v: WinvmSleepAfter) => void;
  onScreen: (v: WinvmScreen) => void;
  onQuality: (v: WinvmDetail) => void;
  onPoints: () => void;
  /** What this window's key may do on the computer (`linkMay`): `admin` sets it up and changes its settings, `operate` wakes and sleeps it. */
  may?: { admin: boolean; operate: boolean };
}

/** The page's rows, pure: the machine's row and, once it is set up, when it sleeps, its screen, its quality and its points. */
export function WinvmView({
  state,
  points,
  pointsError,
  onRetryPoints,
  settings,
  settingsError,
  onRetrySettings,
  saved = {},
  error,
  pressing,
  onPress,
  onSleepAfter,
  onScreen,
  onQuality,
  onPoints,
  may = { admin: true, operate: true },
}: WinvmViewProps) {
  const row = winvmRow(state);
  // a computer before live resize says no display: the size is a new Set up's
  const live = state.display?.device === "virtio";
  const turning = resizing(state);
  const press = row.press && (row.press === "setup" ? may.admin : may.operate) ? row.press : null;
  const sleepWords = SLEEP_AFTER.find((o) => o.value === state.sleepAfter)?.label;
  return (
    <PageSection>
      <SettingRow id="winvm.windows" description={row.words} error={state.blocked ?? state.error ?? error ?? undefined}>
        {press ? (
          <Button variant="secondary" size="sm" disabled={pressing} onClick={onPress}>
            <BusyLabel busy={pressing} label={PRESS_WORDS[press]} />
          </Button>
        ) : row.press || !row.busy ? null : (
          <Button variant="secondary" size="sm" disabled>
            <BusyLabel busy label={state.state === "setting-up" ? "Set up" : state.state === "waking" ? "Wake" : "Sleep"} />
          </Button>
        )}
      </SettingRow>
      {state.state !== "none" ? (
        <>
          <SettingRow id="winvm.sleeps" description={may.admin ? undefined : sleepWords} saved={may.admin ? saved.sleepAfter : undefined}>
            {may.admin ? <ChoiceSelect size="sm" label="Sleeps after" value={state.sleepAfter} options={SLEEP_AFTER} onChange={(v) => onSleepAfter(v as WinvmSleepAfter)} /> : null}
          </SettingRow>
          {!may.admin ? null : settings ? (
            <>
              {/* on the old display Windows keeps the size it was set up at through every sleep (guestScreen.ts): a size is a new Set up's */}
              <SettingRow
                id="winvm.screen"
                description={turning ? (state.step ?? undefined) : live || settings.screen === "fit" ? undefined : "Used when the VM is set up again"}
                saved={saved.screen}
              >
                <ChoiceSelect size="sm" label="Screen size" value={settings.screen} options={SCREENS} disabled={turning || state.state === "setting-up"} onChange={(v) => onScreen(v as WinvmScreen)} />
              </SettingRow>
              {live && settings.detail ? (
                <SettingRow id="winvm.quality" saved={saved.detail}>
                  <ChoiceSelect size="sm" label="Picture quality" value={settings.detail} options={QUALITIES} onChange={(v) => onQuality(v as WinvmDetail)} />
                </SettingRow>
              ) : null}
            </>
          ) : settingsError ? (
            // The display's own read failed before any answer: the wait's shape, its labels with nothing claimed.
            <>
              <SettingRow id="winvm.screen" />
              {live ? <SettingRow id="winvm.quality" /> : null}
            </>
          ) : (
            // While the display is read, its rows wait in their places with a select's bone each.
            <>
              <SettingRow id="winvm.screen">
                <SelectBone />
              </SettingRow>
              {live ? (
                <SettingRow id="winvm.quality">
                  <SelectBone />
                </SettingRow>
              ) : null}
            </>
          )}
          {may.admin && settingsError ? (
            // One red line with its own Retry under the display's rows, over values already shown too.
            <PageError data-display-failure="" action={onRetrySettings ? <RetryButton retry={onRetrySettings} /> : undefined}>
              {settingsError}
            </PageError>
          ) : null}
          {pointsError ? (
            <SettingRow id="winvm.restore" error={pointsError}>
              {onRetryPoints ? <RetryButton retry={onRetryPoints} /> : null}
            </SettingRow>
          ) : (
            <SettingRow
              id="winvm.restore"
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
        </>
      ) : null}
    </PageSection>
  );
}

/** A small select's bone (`ChoiceSelect size="sm"`, 28px), at a row's end while its value is read. */
const SelectBone = () => <Skeleton data-skeleton-control aria-label="Loading" className="h-7 w-36 shrink-0 rounded-lg" />;

/** A failed read's Retry on its own row: it spins until the read it asked settles. */
function RetryButton({ retry }: { retry: () => void | Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={retrying}
      onClick={() => {
        setRetrying(true);
        void Promise.resolve(retry()).finally(() => setRetrying(false));
      }}
    >
      <BusyLabel busy={retrying} label="Retry" />
    </Button>
  );
}

/** Restore points: saved while it sleeps, three kept; going back and deleting each after a confirm that says what is lost. */
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
  const remove = async (point: WinvmPoint): Promise<void> => {
    const ok = await confirmAction({ title: `Delete ${point.name}?`, body: `The restore point from ${dayTime(point.at)} is deleted.`, action: "Delete", danger: true });
    if (ok) await run(`delete:${point.id}`, "work.winvm.point.delete", { id: point.id }, "did not delete the point");
  };
  const sorted = [...points].sort((a, b) => b.at - a.at);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <ModalPanel
        onClose={onClose}
        busy={busy !== null}
        title="Restore points"
        // A press that cannot run says why: points are made and used only while Windows sleeps.
        description={asleep ? "Up to three are kept." : "Points are saved and used only while Windows sleeps."}
        size="sm"
      >
        <ModalBody>
          {sorted.length === 0 ? <PageEmpty>None yet</PageEmpty> : null}
          {sorted.map((point) => (
            <PageRow key={point.id} title={point.name} description={dayTime(point.at)}>
              {/* Going back and deleting are the computer's admin rule: a key that may only save points is not offered them. */}
              {admin ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" disabled={!asleep || busy !== null} onClick={() => void goBack(point)}>
                    <BusyLabel busy={busy === `back:${point.id}`} label="Go back…" />
                  </Button>
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy !== null} onClick={() => void remove(point)}>
                    <BusyLabel busy={busy === `delete:${point.id}`} label="Delete…" />
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
 * A Work job's switch for the VM, on its own page under Computers its threads may use: its threads get the
 * `windows_*` tools. Shown only where its computer has a VM set up.
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
