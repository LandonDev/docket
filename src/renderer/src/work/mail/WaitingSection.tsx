import { useEffect, useRef, useState } from "react";
import type { MailWaiting } from "@shared/contract-work-mail";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry, TimeoutError } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { useLinkMay } from "../../lib/linkMay";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { lifeosHostName, lifeosStateOf, sessionFailure } from "../shell/lifeos";

/**
 * A Work workspace's Waiting on (docs/agents/work-mail.md "Waiting on"), on its
 * settings page: how many working days a sent question waits before Waiting on
 * lists it (LifeOS keeps it for the sector, so LifeOS desktop reads the same),
 * and the switch for the routine that drafts nudges by itself. The switch is
 * off until he turns it on, since each nudge it drafts is a model run. Both are
 * the host's admin rule: a key that may not change them is not shown the
 * section (the page says once who can).
 */

export const WAIT_DAYS = ["1", "2", "3", "5", "7", "10"] as const;
const DAY_CHOICES = WAIT_DAYS.map((d) => ({ value: d, label: d === "1" ? "1 working day" : `${d} working days` }));

/** `failed`: the request itself failed after a value was known; the value stays, and the failure is said on the days' row. */
type Load = { status: "loading" } | { status: "ready"; value: MailWaiting; failed?: string } | { status: "error"; error: string };

/**
 * The days' read failed while the switch's did not: the host sends LifeOS's reason inside the answer, after its own
 * "LifeOS did not answer:" whatever the cause. Said from the true cause in the shared LifeOS line's words
 * (`sessionFailure`): signed out reads as signed out, and "did not answer" is kept for an answer that never came.
 */
export function daysFailure(error: string): string {
  const state = lifeosStateOf(error.replace(/^LifeOS did not answer:\s*/i, ""));
  if (state === "connecting") return "LifeOS is still connecting";
  return state ? sessionFailure(state) : "LifeOS could not read the waiting time";
}

const ask = (env: string, method: string, params: Record<string, unknown>): Promise<MailWaiting> => registry.linkOf(env).request<MailWaiting>(method, params);

/** What the section shows, and the start of the newest ask that set each half: the days with their error, and the routine. */
export type Shown = { value: MailWaiting; days: number; routine: number };

/** Which halves an ask sets: a read both, a save only what it changes. */
export type Owns = { days: boolean; routine: boolean };

/**
 * An answer to the ask started `n`th, laid over what is shown. A half is taken from it unless a newer ask set that
 * half, and the ask marks only the halves it sets. The host reads the routine before it waits on the days, so a read
 * (a Retry) that was out across his flip of the switch answers the routine as it was before: its days and their error
 * are taken, the routine the flip saved stays.
 */
export function laidOver(shown: Shown | null, n: number, value: MailWaiting, owns: Owns): Shown {
  const days = !shown || n >= shown.days;
  const routine = !shown || n >= shown.routine;
  const from = (take: boolean): MailWaiting => (take || !shown ? value : shown.value);
  const d = from(days);
  const r = from(routine);
  return {
    value: { days: d.days, ...(d.error !== undefined ? { error: d.error } : {}), routine: r.routine, ...(r.routineId !== undefined ? { routineId: r.routineId } : {}) },
    days: days && owns.days ? n : (shown?.days ?? n),
    routine: routine && owns.routine ? n : (shown?.routine ?? n),
  };
}

const BOTH: Owns = { days: true, routine: true };

export function WaitingSection({ workspace }: { workspace: WorkspaceMeta }) {
  if (!useLinkMay(workspace.environmentId, "work.mail.setWaiting")) return null;
  return <Waiting workspace={workspace} />;
}

function Waiting({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  // Every ask (the read, its Retry, a save) is numbered as it starts, and its answer replaces only what no newer ask set.
  const asked = useRef(0);
  const shown = useRef<Shown | null>(null);
  const shownFor = useRef(`${env}|${workspace.id}`);
  useEffect(() => {
    let live = true;
    // Another workspace's section starts from nothing.
    if (shownFor.current !== `${env}|${workspace.id}`) {
      shownFor.current = `${env}|${workspace.id}`;
      shown.current = null;
    }
    const n = ++asked.current;
    ask(env, "work.mail.waiting", { workspaceId: workspace.id }).then(
      (value) => {
        if (!live) return;
        shown.current = laidOver(shown.current, n, value, BOTH);
        setLoad({ status: "ready", value: shown.current.value });
      },
      (err: unknown) => {
        // A read that failed after a newer save answered leaves the section as that save left it.
        if (!live || (shown.current && shown.current.routine > n)) return;
        // The workspace's host is known and its link open: its silence is said with the computer named, as the session's
        // line says it; any other cause in Work's words, the computer named in them.
        const host = lifeosHostName(env);
        const error = err instanceof TimeoutError ? sessionFailure("unanswered", false, host) : workErrorWords(err, host ? { host: nameInLine(host) } : {}) || sessionFailure("unanswered", false, host);
        // A Retry that failed keeps what was known, the routine's switch with it: the failure and Retry stay on the days'
        // row. Only a first read with nothing known is the whole section's error.
        setLoad(shown.current ? { status: "ready", value: shown.current.value, failed: error } : { status: "error", error });
      },
    ).finally(() => live && setRetrying(false));
    return () => {
      live = false;
    };
  }, [env, workspace.id, attempt]);

  const change = async (patch: { days?: number; routine?: boolean }, failed: string): Promise<boolean> => {
    const n = ++asked.current;
    try {
      const value = await ask(env, "work.mail.setWaiting", { workspaceId: workspace.id, ...patch });
      shown.current = laidOver(shown.current, n, value, { days: patch.days !== undefined, routine: patch.routine !== undefined });
      setLoad({ status: "ready", value: shown.current.value });
      return true;
    } catch (err) {
      void loadToast().then((toast) => toast.error(failed, { description: workErrorWords(err) || undefined }));
      return false;
    }
  };

  const value = load.status === "ready" ? load.value : null;
  const failed = load.status === "ready" ? load.failed : undefined;
  const retry = (
    <Button
      variant="ghost"
      size="sm"
      disabled={retrying}
      onClick={() => {
        setRetrying(true);
        setAttempt((n) => n + 1);
      }}
    >
      <BusyLabel busy={retrying} label="Retry" />
    </Button>
  );
  return (
    <PageSection title="Waiting on">
      {load.status === "loading" ? <PageRowsSkeleton rows={2} control="switch" /> : null}
      {load.status === "error" ? (
        <PageError action={retry}>{load.error}</PageError>
      ) : null}
      {value ? (
        <>
          <PageRow title="Count as waiting after" error={failed ?? (value.error ? daysFailure(value.error) : undefined)}>
            {value.days === null && (value.error || failed) ? (
              // Asks the whole section again; the switch below stays as it was while it is out.
              retry
            ) : value.days !== null ? (
              <ChoiceSelect
                label="Count as waiting after"
                size="sm"
                value={String(value.days)}
                options={DAY_CHOICES.some((c) => c.value === String(value.days)) ? DAY_CHOICES : [...DAY_CHOICES, { value: String(value.days), label: `${value.days} working days` }]}
                onChange={(days) => void change({ days: Number(days) }, "The waiting time did not change")}
              />
            ) : null}
          </PageRow>
          <PageRow title="Draft nudges by themselves" description="Starts a thread each time a mail comes due">
            <SettingSwitch label="Draft nudges by themselves" on={value.routine} onChange={(routine) => change({ routine }, "The nudge routine did not change")} />
          </PageRow>
        </>
      ) : null}
    </PageSection>
  );
}
