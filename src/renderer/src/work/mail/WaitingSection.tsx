import { useEffect, useState } from "react";
import type { MailWaiting } from "@shared/contract-work-mail";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

/**
 * A Work workspace's Waiting on (docs/agents/work-mail.md "Waiting on"), on its
 * settings page: how many working days a sent question waits before Waiting on
 * lists it (LifeOS keeps it for the sector, so LifeOS desktop reads the same),
 * and the switch for the routine that drafts nudges by itself. The switch is
 * off until he turns it on, since each nudge it drafts is a model run.
 */

export const WAIT_DAYS = ["1", "2", "3", "5", "7", "10"] as const;
const DAY_CHOICES = WAIT_DAYS.map((d) => ({ value: d, label: d === "1" ? "1 working day" : `${d} working days` }));

type Load = { status: "loading" } | { status: "ready"; value: MailWaiting } | { status: "error"; error: string };

const ask = (env: string, method: string, params: Record<string, unknown>): Promise<MailWaiting> => registry.linkOf(env).request<MailWaiting>(method, params);

export function WaitingSection({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let live = true;
    ask(env, "work.mail.waiting", { workspaceId: workspace.id }).then(
      (value) => live && setLoad({ status: "ready", value }),
      (err: unknown) => live && setLoad({ status: "error", error: refusalWords(err) || "The host did not answer" }),
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
      void loadToast().then((toast) => toast.error(failed, { description: refusalWords(err) || undefined }));
      return false;
    }
  };

  const value = load.status === "ready" ? load.value : null;
  return (
    <PageSection title="Waiting on">
      {load.status === "loading" ? <PageRowsSkeleton rows={2} control="switch" /> : null}
      {load.status === "error" ? (
        <PageError
          action={
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
          }
        >
          {load.error}
        </PageError>
      ) : null}
      {value ? (
        <>
          <PageRow title="Questions wait" error={value.error}>
            {value.days !== null ? (
              <ChoiceSelect
                label="Working days a question waits"
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
