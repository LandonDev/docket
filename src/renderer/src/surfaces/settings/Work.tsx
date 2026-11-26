import { useCallback, useEffect, useState } from "react";
import { PageError, PageRow, PageRowsSkeleton } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useHostRead } from "../../lib/connection/hostRead";
import { SettingSwitch } from "../../components/setting-switch";
import { StatusMark } from "../../components/ui/status";
import { confirmAction, type ConfirmRequest } from "../../chrome/ConfirmDialog";
import { useEnvironments } from "../../lib/connection";
import { defineChunk } from "../../lib/lazyChunk";
import { hostFailure } from "../../lib/hostFailure";
import { managedElsewhere } from "../../lib/linkMay";
import { computerInLine, useComputerNames } from "../../lib/settings/computerName";

/** "the box", "the box and MacBook Pro", "the box, PURDUE-LT and MacBook Pro". */
const listOf = (names: readonly string[]): string => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { setWorkOn, useWorkHosts } from "../../lib/workSwitch";
import { ComputerName } from "./parts/ComputerName";
import { useHost } from "./parts/hostRpc";
import { SaveMark } from "./parts/SaveMark";
import { SettingSection } from "./parts/SettingRow";
import { useSaved } from "./parts/useSaved";

// The rest of the page (each job's access, what goes without asking, travel, where new jobs go) rides Work's own chunk.
export const workPageChunk = defineChunk("work-settings", () => import("../../work/shell/WorkPage"));
const WorkPageBody = workPageChunk.surface("WorkPageBody", <PageRowsSkeleton rows={4} description control="none" />);

/** "Turn Work off on the box?": what the off switch asks first (docs/agents/settings.md "Acts that ask first"). */
export function workOffAsk(computer: string, jobs: number): ConfirmRequest {
  const what = jobs > 0 ? `The Outbox, Work Chats and ${jobs === 1 ? "its job" : `${jobs} jobs`}` : "The Outbox and Work Chats";
  return {
    title: `Turn Work off on ${computer}?`,
    body: `${what} leave the list on every device. Nothing is deleted, and turning it on brings them back.`,
    action: "Turn off",
    danger: true,
  };
}

/**
 * Settings → Work (docs/agents/work.md "The switch", docs/agents/settings.md "The pages: Work"). "Work is on for" is
 * one row per computer this window reaches, each with its own switch: a press writes `work.set` to that computer and
 * no other, and off asks first. A computer this window's key may not switch shows its state in words and who can.
 * The section is `work.on`, where another page's "Work" row lands. With Work on somewhere the rest of the page loads
 * from Work's chunk.
 */
export function WorkPage() {
  const environments = useEnvironments();
  const on = useWorkHosts();
  const names = useComputerNames();
  // Each computer's read that failed, with its Retry: said once over the rows, never once a row.
  const [failed, setFailed] = useState<Record<string, () => Promise<void>>>({});
  const [retrying, setRetrying] = useState(false);
  const report = useCallback((id: string, retry: (() => Promise<void>) | null) => {
    setFailed((was) => {
      if ((retry === null) === !(id in was)) return was;
      const { [id]: _gone, ...rest } = was;
      return retry ? { ...rest, [id]: retry } : rest;
    });
  }, []);
  const down = environments.filter((e) => e.id in failed);
  const retryAll = (): void => {
    setRetrying(true);
    void Promise.all(down.map((e) => failed[e.id]!())).finally(() => setRetrying(false));
  };
  const said = listOf(down.map((e) => computerInLine(names(e.id))));
  return (
    <>
      <SettingSection of="work.on">
        {down.length ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" disabled={retrying} onClick={retryAll}>
                <BusyLabel busy={retrying} label="Retry" />
              </Button>
            }
          >
            {`${said.charAt(0).toUpperCase()}${said.slice(1)} did not say whether Work is on.`}
          </PageError>
        ) : null}
        {environments.map((environment) => (
          <WorkOnRow key={environment.id} environmentId={environment.id} report={report} />
        ))}
      </SettingSection>
      {on.size > 0 ? <WorkPageBody /> : null}
    </>
  );
}

/** One computer's switch: one press, one `work.set`, to this computer alone. */
export function WorkOnRow({ environmentId, report }: { environmentId: string; report?: (id: string, retry: (() => Promise<void>) | null) => void }) {
  const computer = useHost(environmentId);
  // The switch stands only once this computer has said, on this page, whether Work is on: a remembered value is no fact.
  const read = useHostRead(computer.link, () => computer.request<{ enabled: boolean }>("work.get", {}));
  const answered = read.value !== undefined;
  const failedRead = !answered && read.error !== null;
  useEffect(() => report?.(environmentId, failedRead ? read.retry : null), [failedRead, environmentId, report]);
  useEffect(() => () => report?.(environmentId, null), [environmentId, report]);
  useEffect(() => {
    if (read.value) setWorkOn(environmentId, !!read.value.enabled);
  }, [read.value, environmentId]);
  const on = useWorkHosts().has(environmentId);
  const jobs = useWorkspaces().filter((w) => w.kind === "work" && w.environmentId === environmentId).length;
  const saved = useSaved();
  const may = computer.may("work.set", { enabled: !on });
  const flip = async (next: boolean): Promise<boolean> => {
    if (!next && !(await confirmAction(workOffAsk(computerInLine(computer.name), jobs)))) return false;
    return saved.run(async () => {
      // A refusal in the house's words, naming the computer: never the link's own text.
      const answer = await computer.request<{ enabled: boolean }>("work.set", { enabled: next }).catch((err: unknown) => {
        throw new Error(hostFailure(environmentId, err, "did not save the change", true));
      });
      setWorkOn(environmentId, !!answer?.enabled);
    });
  };
  // A read that failed is said once over the rows (the page's own line, with Retry): the row holds no fact meanwhile.
  const failed = failedRead;
  const description = !computer.connected
    ? "Offline"
    : failed
      ? undefined
      : !answered
        ? <Skeleton className="mt-0.5 h-3 w-24" />
        : !may
          ? managedElsewhere(computer.name.name)
          : on && jobs > 0
            ? jobs === 1
              ? "1 job"
              : `${jobs} jobs`
            : undefined;
  const control = !computer.connected || (failed && report) ? null : failed ? (
    <Button variant="ghost" size="sm" onClick={() => void read.retry()}>
      Retry
    </Button>
  ) : !answered ? (
    <Skeleton className="h-5 w-8 rounded-full" />
  ) : may ? (
    <>
      <SaveMark state={saved.state} />
      <SettingSwitch label={`Work on ${computerInLine(computer.name)}`} on={on} onChange={flip} />
    </>
  ) : (
    <StatusMark state="idle" glyph={false} word={on ? "On" : "Off"} className="text-xs" />
  );
  return (
    <PageRow
      data-work-on={environmentId}
      title={<ComputerName computer={computer.name} />}
      description={description}
      error={saved.error ?? (failed && !report ? hostFailure(environmentId, read.error, "did not say whether Work is on") : undefined)}
    >
      {control}
    </PageRow>
  );
}
