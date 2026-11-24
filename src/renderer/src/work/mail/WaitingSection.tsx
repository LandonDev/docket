import { useEffect, useState } from "react";
import type { MailWaiting } from "@shared/contract-work-mail";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { useLinkMay } from "../../lib/linkMay";
import { workErrorWords } from "../../lib/workErrorWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { lifeosStateOf, sessionFailure } from "../shell/lifeos";

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

type Load = { status: "loading" } | { status: "ready"; value: MailWaiting } | { status: "error"; error: string };

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

export function WaitingSection({ workspace }: { workspace: WorkspaceMeta }) {
  if (!useLinkMay(workspace.environmentId, "work.mail.setWaiting")) return null;
  return <Waiting workspace={workspace} />;
}

function Waiting({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let live = true;
    ask(env, "work.mail.waiting", { workspaceId: workspace.id }).then(
      (value) => live && setLoad({ status: "ready", value }),
      (err: unknown) => live && setLoad({ status: "error", error: workErrorWords(err) || "The host did not answer" }),
    ).finally(() => live && setRetrying(false));
    return () => {
      live = false;
    };
  }, [env, workspace.id, attempt]);

  const change = async (patch: { days?: number; routine?: boolean }, failed: string): Promise<boolean> => {
    try {
      setLoad({ status: "ready", value: await ask(env, "work.mail.setWaiting", { workspaceId: workspace.id, ...patch }) });
      return true;
    } catch (err) {
      void loadToast().then((toast) => toast.error(failed, { description: workErrorWords(err) || undefined }));
      return false;
    }
  };

  const value = load.status === "ready" ? load.value : null;
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
          <PageRow title="Count as waiting after" error={value.error ? daysFailure(value.error) : undefined}>
            {value.days === null && value.error ? (
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
