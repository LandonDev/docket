import { useCallback, useEffect, useState } from "react";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useHostRead } from "../../lib/connection/hostRead";
import { SettingSwitch } from "../../components/setting-switch";
import { StatusMark } from "../../components/ui/status";
import { confirmAction, type ConfirmRequest } from "../../chrome/ConfirmDialog";
import { useEnvironments } from "../../lib/connection";
import { defineChunk } from "../../lib/lazyChunk";
import { hostFailure } from "../../lib/hostFailure";
import { managedElsewhere } from "../../lib/linkMay";
import { computerInLine } from "../../lib/settings/computerName";
import { ReadFailure } from "./parts/ReadFailure";

/** A computer's jobs in one form on every row where Work is on: "No jobs", "1 job", "5 jobs". */
export const jobsWords = (n: number): string => (n === 0 ? "No jobs" : n === 1 ? "1 job" : `${n} jobs`);

/** A sentence's stop, where it has none yet. */
const withStop = (line: string): string => (/[.!?]$/.test(line) ? line : `${line}.`);

import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { setWorkOn, useWorkHosts, workOnRow } from "../../lib/workSwitch";
import { FOUND_ROW } from "../../lib/settings/reveal";
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
  // Each computer's read that failed, with its Retry: said once over the rows, never once a row.
  const [failed, setFailed] = useState<Record<string, { retry: () => Promise<void>; error: string }>>({});
  const report = useCallback((id: string, fail: { retry: () => Promise<void>; error: string } | null) => {
    setFailed((was) => {
      if (fail === null ? !(id in was) : was[id]?.error === fail.error) return was;
      const { [id]: _gone, ...rest } = was;
      return fail ? { ...rest, [id]: fail } : rest;
    });
  }, []);
  const down = environments.filter((e) => e.id in failed);
  return (
    <>
      <SettingSection of="work.on">
        {/* Each computer that did not say is named once, over the rows; its Retry asks every read that failed alike. */}
        {down.map((e) => (
          <ReadFailure key={e.id} computer={e.id} error={failed[e.id]!.error} retry={failed[e.id]!.retry} />
        ))}
        {environments.map((environment) => (
          <WorkOnRow key={environment.id} environmentId={environment.id} report={report} />
        ))}
      </SettingSection>
      {on.size > 0 ? <WorkPageBody /> : null}
    </>
  );
}

/** One computer's switch: one press, one `work.set`, to this computer alone. */
export function WorkOnRow({ environmentId, report }: { environmentId: string; report?: (id: string, fail: { retry: () => Promise<void>; error: string } | null) => void }) {
  const computer = useHost(environmentId);
  // The switch stands only once this computer has said, on this page, whether Work is on: a remembered value is no fact.
  const read = useHostRead(computer.link, () => computer.request<{ enabled: boolean }>("work.get", {}));
  const answered = read.value !== undefined;
  const failedRead = !answered && read.error !== null;
  useEffect(() => report?.(environmentId, failedRead ? { retry: read.retry, error: read.error ?? "" } : null), [failedRead, read.error, environmentId, report]);
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
  // A read that failed is said once at the page's head (ReadFailure, with Retry): its row is not drawn meanwhile.
  const failed = failedRead;
  if (failed && report) return null;
  const description = !computer.connected
    ? "Offline"
    : failed
      ? undefined
      : !answered
        ? <Skeleton className="mt-0.5 h-3 w-24" />
        : !may
          ? withStop(managedElsewhere(computer.name.name))
          : on
            ? jobsWords(jobs)
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
      // The row a computer's own page reveals (`workOnRow`): the list is the map's, this row its computer's.
      data-setting-row={workOnRow(environmentId)}
      className={FOUND_ROW}
      title={<ComputerName computer={computer.name} />}
      description={description}
      error={saved.error ?? (failed && !report ? hostFailure(environmentId, read.error, "did not say whether Work is on") : undefined)}
    >
      {control}
    </PageRow>
  );
}
