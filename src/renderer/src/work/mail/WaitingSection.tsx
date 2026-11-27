import { useEffect, useRef, useState } from "react";
import type { MailWaiting } from "@shared/contract-work-mail";
import { Region } from "../../components/bones";
import { ChoiceSelect } from "../../components/choice-select";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry, TimeoutError } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { useLinkMay } from "../../lib/linkMay";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { lifeosHostName, lifeosStateOf, sessionFailure, useLifeosStatus } from "../shell/lifeos";
import { downIsSilence, downWords, useDownPress } from "../shell/lifeosDown";
import { savedOf, savedOfState, useLiveDown, type SavedDown } from "../shell/lifeosLive";
import { connectingWords } from "../shell/lifeosWords";
import { useDownAction } from "../shell/DownSignIn";
import { SettingRow } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { ReadFailure } from "../../surfaces/settings/parts/ReadFailure";
import { inWords } from "../../lib/settings/workWords";

/**
 * A job's Waiting on rows (docs/agents/work-mail.md "Waiting on"), under its page's Writing and mail: how many working
 * days a sent question waits before Waiting on lists it (LifeOS keeps it for the sector, so LifeOS desktop reads the
 * same), and the switch for the routine that drafts nudges by itself. The switch is off until he turns it on, since
 * each nudge it drafts is a model run. Both are the host's admin rule: a key that may not change them is not shown the
 * rows (the page says once who can). Each saves with the mark, and a refusal puts it back with the row's red line.
 */

export const WAIT_DAYS = ["1", "2", "3", "5", "7", "10"] as const;
const DAY_CHOICES = WAIT_DAYS.map((d) => ({ value: d, label: d === "1" ? "1 working day" : `${d} working days` }));

/** `failed`: the request itself failed after a value was known; the value stays, and the failure is said on the days' row. */
type Load = { status: "loading" } | { status: "ready"; value: MailWaiting; failed?: string; failedAs?: SavedDown } | { status: "error"; error: string };

/** The LifeOS state the host's reason for a failed days' read names, after its own "LifeOS did not answer:" whatever the cause; null for any other cause. */
export const daysState = (error: string): LifeosStateName | null => lifeosStateOf(error.replace(/^LifeOS did not answer:\s*/i, ""));

/**
 * The days' read failed while the switch's did not. Said from the true cause in the shared LifeOS line's words
 * (`sessionFailure`, `host` named): signed out reads as signed out, and "did not answer" is kept for an answer that
 * never came.
 */
export function daysFailure(error: string, host?: string | null): string {
  const state = daysState(error);
  if (state === "connecting") return connectingWords(host);
  return state ? sessionFailure(state, false, host) : "LifeOS could not read the waiting time";
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

export function WaitingRows({ workspace }: { workspace: WorkspaceMeta }) {
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
  // A read again because the host is back (`useLiveDown`'s onBack): told when that read lands.
  const landed = useRef<(() => void) | null>(null);
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
        setLoad(shown.current ? { status: "ready", value: shown.current.value, failed: error, failedAs: savedOf(err) } : { status: "error", error });
      },
    ).finally(() => {
      if (!live) return;
      setRetrying(false);
      landed.current?.();
      landed.current = null;
    });
    return () => {
      live = false;
    };
  }, [env, workspace.id, attempt]);

  const value = load.status === "ready" ? load.value : null;
  const failed = load.status === "ready" ? load.failed : undefined;
  // What the days' row says is the host's live status's (`useLiveDown`) over the cause the last read saved: a sign-out
  // while the page is open takes the row down at once, a sign-in begun elsewhere is Show the code, LifeOS on its way is
  // a wait with no press; once a status heard since says connected, the row reads again with no press, through the same
  // numbered ask, so the switch keeps the value its last save gave it. The switch keeps its own way throughout.
  const saved: SavedDown = load.status === "ready" && failed ? (load.failedAs ?? null) : value?.error ? savedOfState(daysState(value.error)) : null;
  // While that read is out (`again`) the row draws its bone, never the old cause.
  const live = useLiveDown(saved, env, () => new Promise<void>((done) => ((landed.current = done), setAttempt((n) => n + 1))));
  useLifeosStatus(env);

  const daysSaved = useSaved();
  const routineSaved = useSaved();
  // The days he picked, shown at once until the host's answer replaces them (or a refusal puts the old ones back).
  const [pickedDays, setPickedDays] = useState<string | null>(null);
  const change = (patch: { days?: number; routine?: boolean }): Promise<boolean> =>
    (patch.days !== undefined ? daysSaved : routineSaved).run(() =>
      inWords(env, async () => {
        const n = ++asked.current;
        const value = await ask(env, "work.mail.setWaiting", { workspaceId: workspace.id, ...patch });
        shown.current = laidOver(shown.current, n, value, { days: patch.days !== undefined, routine: patch.routine !== undefined });
        setLoad({ status: "ready", value: shown.current.value });
      }),
    );

  const host = lifeosHostName(env);
  // A LifeOS that is signed out, refused, waiting for a sign-in or off is a state, said muted with the rule's press
  // (`useDownPress`: Sign in, Show the code, Open Settings, else who can); only silence, or a cause with no state, is
  // the red line with Retry.
  const down = live.down;
  const stated = !!down && !downIsSilence(down);
  const { press, elsewhere } = useDownPress(stated ? down : null, env);
  const { action, dialog } = useDownAction(press, env);
  const daysWords = live.again ? undefined : down ? downWords(down, host) : live.waits ? connectingWords(host) : (failed ?? (value?.error ? daysFailure(value.error, host) : undefined));
  // Said muted: a state, or LifeOS on its way; silence and a cause with no state are the red line.
  const muted = stated || live.waits;
  // The row has no value to change: none was read, or the host's LifeOS is down now, or on its way.
  const noDays = value?.days === null || !!down || live.waits;
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
  // The days' row's control, once a value is read: the state's press, Retry, or the select.
  const control = !value ? null : noDays && stated ? (
    action ? (
      <Button variant="ghost" size="sm" onClick={action.run}>
        {action.label}
      </Button>
    ) : null
  ) : noDays && !live.waits && (value.error || failed || down) ? (
    // Asks the whole section again; the switch below stays as it was while it is out.
    retry
  ) : value.days !== null && !noDays ? (
    <DaysSelect
      days={value.days}
      picked={pickedDays}
      onChange={(days) => {
        setPickedDays(days);
        void change({ days: Number(days) }).then(() => setPickedDays(null));
      }}
    />
  ) : null;
  return (
    <Region loading={load.status === "loading"} label="" bones={<WaitingBones />}>
      {load.status === "error" ? (
        <ReadFailure computer={env} error={load.error} retry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {value ? (
        <>
          <SettingRow
            id="job.unanswered"
            saved={noDays ? undefined : daysSaved}
            description={
              muted ? (
                <>
                  {daysWords}
                  {elsewhere ? <span className="block">{elsewhere}</span> : null}
                </>
              ) : undefined
            }
            error={muted ? undefined : daysWords}
          >
            {live.again || control ? (
              // Read again now the host is back: the select itself, held, until the read lands.
              <Region loading={!!live.again} label="" className="shrink-0" bones={<DaysSelect days={SAMPLE_DAYS} disabled again />}>
                {live.again ? null : control}
              </Region>
            ) : null}
          </SettingRow>
          <SettingRow id="job.nudges" saved={routineSaved} description="Starts a thread each time one comes due">
            <SettingSwitch label="Draft nudges by themselves" on={value.routine} onChange={(routine) => change({ routine })} />
          </SettingRow>
          {dialog}
        </>
      ) : null}
    </Region>
  );
}

/** The days a row is drawn with while it waits: the setting's own default. */
const SAMPLE_DAYS = 3;

/** How long sent mail waits before it counts as unanswered, in working days. */
function DaysSelect({ days, picked, disabled, again, onChange }: { days: number; picked?: string | null; disabled?: boolean; again?: boolean; onChange?: (days: string) => void }) {
  const select = (
    <ChoiceSelect
      label="Count sent mail as unanswered after"
      size="sm"
      disabled={disabled}
      value={picked ?? String(days)}
      options={DAY_CHOICES.some((c) => c.value === String(days)) ? DAY_CHOICES : [...DAY_CHOICES, { value: String(days), label: `${days} working days` }]}
      onChange={onChange ?? (() => {})}
    />
  );
  return again ? <span data-days-again="">{select}</span> : select;
}

/** The section's two rows while it reads, at rest: the select at its default, the switch off. */
function WaitingBones() {
  return (
    <>
      <SettingRow id="job.unanswered">
        <DaysSelect days={SAMPLE_DAYS} disabled />
      </SettingRow>
      <SettingRow id="job.nudges" description="Starts a thread each time one comes due">
        <SettingSwitch label="Draft nudges by themselves" on={false} onChange={() => {}} />
      </SettingRow>
    </>
  );
}
