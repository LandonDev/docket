import { useEffect, useState } from "react";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { Modal, ModalBody } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";
import { startAway, useAway } from "../../lib/away";
import { useEnvironments } from "../../lib/connection";
import { requestSettings } from "../../lib/monaco/debugTab";
import { isWebMode } from "../../lib/nativeWeb";
import { thisDesktopInLine } from "../../lib/native";
import { ACCESS_NAMES, accessWords } from "../../lib/settings/access";
import { useComputerNames } from "../../lib/settings/computerName";
import type { PermissionPolicy, WorkspaceMeta } from "../../lib/tcserver/types";
import { scopeKey, useWorkspaceCatalog, useWorkspaces, workspaceStore } from "../../lib/tcserver/workspaces";
import { BusyLabel, Button } from "../../components/ui/button";
import { useLinksMay } from "../../lib/linkMay";
import { useWorkHosts } from "../../lib/workSwitch";
import { OpenCue, SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { StartAddressesRow } from "../clashes/StartPlaces";
import { setWorkHome, workHome } from "./actions";
import { GrantsRow, ToolsRow } from "./WorkPageSends";

/**
 * Settings → Work below "Work is on for" (docs/agents/settings.md "The pages: Work"), while Work is on somewhere:
 * each job's access for its new threads, what goes without asking (the send grants, each add-on's tools, Away),
 * Travel's start addresses, and which computer a new job is made on. Every row opens where its setting lives; the
 * only control here is New jobs are made on, this window's own.
 */
export function WorkPageBody() {
  const linked = useEnvironments();
  const on = useWorkHosts();
  const hosts = linked.filter((e) => on.has(e.id));
  const [home, setHome] = useState(() => workHome(linked));
  const names = useComputerNames();
  const mac = thisDesktopInLine();
  return (
    <>
      <JobsAccess />
      <SettingSection of="work.grants">
        <GrantsRow id="work.grants" />
        <ToolsRow />
        <AwayRow />
      </SettingSection>
      {home ? (
        <SettingSection of="work.start">
          <StartAddressesRow environmentId={home} />
        </SettingSection>
      ) : null}
      {hosts.length > 1 && !isWebMode() ? (
        <SettingSection of="work.home" vars={{ mac }}>
          <SettingRow id="work.home">
            <ChoiceSelect
              size="sm"
              label="New jobs are made on"
              value={home && hosts.some((h) => h.id === home) ? home : hosts[0]!.id}
              options={hosts.map((h) => ({ value: h.id, label: names(h.id).name }))}
              onChange={(id) => {
                setWorkHome(id);
                setHome(id);
              }}
            />
          </SettingRow>
        </SettingSection>
      ) : null}
    </>
  );
}

/**
 * One open row per job: its dot, its name and the access its new threads start with. The level most jobs share is
 * said once, with its line, under the heading; a job on another level says its own line (rule 6). The jobs' sets are
 * read together: while any is out the rows hold their shape, and reads that failed are one line with one Retry.
 */
function JobsAccess() {
  const jobs = useWorkspaces()
    .filter((w) => w.kind === "work")
    .sort((a, b) => a.name.localeCompare(b.name));
  const { defaults, defaultsErrors } = useWorkspaceCatalog();
  const [open, setOpen] = useState<WorkspaceMeta | null>(null);
  const [retrying, setRetrying] = useState(false);
  const may = useLinksMay();
  const key = jobs.map((j) => `${j.environmentId}:${j.id}`).join(",");
  useEffect(() => {
    for (const job of jobs) void workspaceStore.loadDefaults(job.environmentId, job.id);
  }, [key]);
  if (jobs.length === 0) return null;
  const levelOf = (job: WorkspaceMeta) => defaults.get(scopeKey(job.environmentId, job.id))?.defaults.permission;
  const failed = jobs.filter((job) => !levelOf(job) && defaultsErrors.has(scopeKey(job.environmentId, job.id)));
  const levels = jobs.map(levelOf).filter((level): level is PermissionPolicy => !!level);
  const common = mostOf(levels);
  const retry = (): void => {
    setRetrying(true);
    void Promise.all(failed.map((job) => workspaceStore.loadDefaults(job.environmentId, job.id))).finally(() => setRetrying(false));
  };
  return (
    <>
      <SettingSection of="work.access" description={common && levels.length === jobs.length ? accessWords(common) : undefined}>
        {failed.length ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" disabled={retrying} onClick={retry}>
                <BusyLabel busy={retrying} label="Retry" />
              </Button>
            }
          >
            {failed.length === jobs.length ? "The jobs' access did not load." : `The access of ${failed.map((j) => j.name).join(" and ")} did not load.`}
          </PageError>
        ) : null}
        {jobs.map((job) => {
          const level = levelOf(job);
          const opens = may(job.environmentId, "defaults.set");
          return (
            <PageRow
              key={job.id}
              data-job={job.id}
              media={<SectorDot sector={job.sector ?? null} />}
              title={job.name}
              // The shared level's line is the heading's; a job on another level says its own.
              description={level ? (level === common && levels.length === jobs.length ? ACCESS_NAMES[level] : accessWords(level)) : failed.includes(job) ? undefined : <Skeleton className="mt-0.5 h-3 w-40" />}
              onOpen={opens ? () => setOpen(job) : undefined}
              openLabel={`New threads in ${job.name}`}
            >
              {opens ? <OpenCue /> : null}
            </PageRow>
          );
        })}
      </SettingSection>
      {open ? <JobThreadsDialog job={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** The level most jobs share; none when no two agree and there is more than one. */
export function mostOf(levels: readonly PermissionPolicy[]): PermissionPolicy | undefined {
  const counts = new Map<PermissionPolicy, number>();
  for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!top) return undefined;
  return top[1] > 1 || levels.length === 1 ? top[0] : undefined;
}

/** The job's New threads, in a dialog: the one editor of a workspace's start set (chrome/ThreadDefaultsDialog.tsx). */
export function JobThreadsDialog({ job, onClose }: { job: WorkspaceMeta; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title={job.name} size="sm">
      <ModalBody>
        <ThreadDefaultsEditor workspaceId={job.id} />
      </ModalBody>
    </Modal>
  );
}

/** Away for Work threads is Away's own switch: this row says where it stands and goes there. */
function AwayRow() {
  const { work } = useAway();
  useEffect(() => startAway(), []);
  return <SettingRow id="work.away" description={work ? "Away is on for Work threads" : "Off for Work threads"} onOpen={() => requestSettings("away", "away.work")} openLabel="Away" />;
}
