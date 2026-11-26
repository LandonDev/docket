import { useEffect, useState } from "react";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { Modal, ModalBody } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";
import { startAway, useAway } from "../../lib/away";
import { useEnvironments } from "../../lib/connection";
import { useLinkMay } from "../../lib/linkMay";
import { requestSettings } from "../../lib/monaco/debugTab";
import { isWebMode } from "../../lib/nativeWeb";
import { thisDesktopInLine } from "../../lib/native";
import { accessWords } from "../../lib/settings/access";
import { useComputerNames } from "../../lib/settings/computerName";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useThreadDefaults, useThreadDefaultsError, useWorkspaces } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
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

/** One open row per job: its dot, its name, the access its new threads start with and that level's line. */
function JobsAccess() {
  const jobs = useWorkspaces()
    .filter((w) => w.kind === "work")
    .sort((a, b) => a.name.localeCompare(b.name));
  const [open, setOpen] = useState<WorkspaceMeta | null>(null);
  if (jobs.length === 0) return null;
  return (
    <>
      <SettingSection of="work.access">
        {jobs.map((job) => (
          <JobAccessRow key={job.id} job={job} onOpen={() => setOpen(job)} />
        ))}
      </SettingSection>
      {open ? <JobThreadsDialog job={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function JobAccessRow({ job, onOpen }: { job: WorkspaceMeta; onOpen: () => void }) {
  const scope = useThreadDefaults(job.environmentId, job.id);
  const failure = useThreadDefaultsError(job.environmentId, job.id);
  // A key that may not set the job's defaults reads its access, with no way in it could not use.
  const may = useLinkMay(job.environmentId, "defaults.set");
  const description = scope ? accessWords(scope.defaults.permission) : failure ? undefined : <Skeleton className="mt-0.5 h-3 w-56" />;
  return (
    <PageRow
      data-job={job.id}
      media={<SectorDot sector={job.sector ?? null} />}
      title={job.name}
      description={description}
      error={!scope && failure ? failure.error : undefined}
      onOpen={may ? onOpen : undefined}
      openLabel={`New threads in ${job.name}`}
    />
  );
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
