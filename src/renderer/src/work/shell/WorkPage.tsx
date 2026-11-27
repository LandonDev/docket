import { useEffect, useState } from "react";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ThreadDefaultsDialog } from "../../chrome/ThreadDefaultsDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { awayStore, startAway, useAway } from "../../lib/away";
import { useStore } from "zustand";
import { registry, useEnvironments } from "../../lib/connection";
import { requestSettings } from "../../lib/monaco/debugTab";
import { isWebMode } from "../../lib/nativeWeb";
import { thisDesktopInLine } from "../../lib/native";
import { ACCESS_NAMES, accessWords } from "../../lib/settings/access";
import { computerInLine, readFailWords, useComputerNames } from "../../lib/settings/computerName";
import type { PermissionPolicy, WorkspaceMeta } from "../../lib/tcserver/types";
import { scopeKey, useWorkspaceCatalog, useWorkspaces, workspaceStore } from "../../lib/tcserver/workspaces";
import { useLinksMay } from "../../lib/linkMay";
import { useWorkHosts } from "../../lib/workSwitch";
import { OpenCue, SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { ReadFailure } from "../../surfaces/settings/parts/ReadFailure";
import { ListFilter, useListFilter } from "../../surfaces/settings/parts/ListFilter";
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
      {/* The sign-ins Work leans on are Connections' page: one way there, as AI accounts has. */}
      <SettingSection of="work.connections">
        <SettingRow id="work.connections" onOpen={() => requestSettings("connections")} openLabel="LifeOS, Office and Google sign-ins" />
      </SettingSection>
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
export function JobsAccess({ computer }: { /** One computer's jobs alone, on that computer's page (`pc.jobs`). */ computer?: string } = {}) {
  const jobs = useWorkspaces()
    .filter((w) => w.kind === "work" && (computer === undefined || w.environmentId === computer))
    .sort((a, b) => a.name.localeCompare(b.name));
  const { defaults, defaultsErrors, defaultsStale } = useWorkspaceCatalog();
  const [open, setOpen] = useState<WorkspaceMeta | null>(null);
  // The filtered list's own Retry while it runs: the jobs it asks and the words it said, kept until every read settles.
  const [retrying, setRetrying] = useState<{ keys: readonly string[]; words: string } | null>(null);
  const may = useLinksMay();
  const names = useComputerNames();
  const key = jobs.map((j) => `${j.environmentId}:${j.id}`).join(",");
  useEffect(() => {
    for (const job of jobs) void workspaceStore.loadDefaults(job.environmentId, job.id);
  }, [key]);
  // Past eight jobs, a find field over them: by a job's name or its computer's.
  const filter = useListFilter(jobs, (job: WorkspaceMeta) => `${job.name} ${names(job.environmentId).name} ${computerInLine(names(job.environmentId))}`);
  if (jobs.length === 0) return null;
  const levelOf = (job: WorkspaceMeta) => defaults.get(scopeKey(job.environmentId, job.id))?.defaults.permission;
  // A read that failed is said even while an earlier answer is held (`defaultsStale`); a job with nothing held draws no row.
  const errorOf = (job: WorkspaceMeta) => defaultsErrors.get(scopeKey(job.environmentId, job.id)) ?? defaultsStale.get(scopeKey(job.environmentId, job.id));
  const erred = jobs.filter((job) => errorOf(job) !== undefined);
  const failed = erred.filter((job) => !levelOf(job));
  // A level held over a failed refresh is the last one read, not a current one: it is said as such, and never counts
  // toward the level the heading says for most jobs.
  const heldOf = (job: WorkspaceMeta) => !!levelOf(job) && defaultsStale.has(scopeKey(job.environmentId, job.id));
  const levels = jobs.map(levelOf).filter((level): level is PermissionPolicy => !!level);
  const common = mostOf(jobs.filter((job) => !heldOf(job)).map(levelOf).filter((level): level is PermissionPolicy => !!level));
  const keyOf = (job: WorkspaceMeta) => scopeKey(job.environmentId, job.id);
  const matches = (job: WorkspaceMeta) => filter.shown.includes(job);
  // The jobs that answered, or are still out: a job whose read failed draws no row, the page's line stands for it; nor
  // one the filtered list is asking again.
  const shown = jobs.filter((job) => !failed.includes(job) && !retrying?.keys.includes(keyOf(job)));
  // The rows the query leaves. A query that matches only jobs whose read failed says those failures at the list, with
  // one Retry, and the page's head leaves them out.
  const rows = shown.filter(matches);
  const missed = rows.length === 0 ? jobs.filter((job) => matches(job) && (failed.includes(job) || !!retrying?.keys.includes(keyOf(job)))) : [];
  // One line a computer whose jobs did not answer (the page says a silence once: `ReadFailure`), its Retry asking them again.
  const failuresOf = (said: readonly WorkspaceMeta[]) =>
    [...new Set(said.map((job) => job.environmentId))].map((environmentId) => {
      const ones = said.filter((job) => job.environmentId === environmentId);
      return (
        <ReadFailure
          key={environmentId}
          computer={environmentId}
          error={errorOf(ones[0]!) ?? ""}
          retry={() => Promise.all(ones.map((job) => workspaceStore.loadDefaults(job.environmentId, job.id)))}
        />
      );
    });
  // Every job's read failed: the line alone, with no heading, no list and no rows standing on nothing.
  if (failed.length === jobs.length) return <>{failuresOf(erred)}</>;
  // Under a list, the failures the filtered list says itself are left out of the page's head.
  const failures = failuresOf(erred.filter((job) => !missed.includes(job)));
  const settled = levels.length === shown.length;
  // Jobs on more than one computer: each row says its own.
  const several = new Set(jobs.map((job) => job.environmentId)).size > 1;
  const missedWords = retrying?.words ?? missed.map((job) => `${job.name}: ${readFailWords(errorOf(job) ?? "", names(job.environmentId))}`).join(" ");
  const retryMissed = (): void => {
    setRetrying({ keys: missed.map(keyOf), words: missedWords });
    void Promise.allSettled(missed.map((job) => workspaceStore.loadDefaults(job.environmentId, job.id))).then(() => setRetrying(null));
  };
  return (
    <>
      {/* While any set is out the line under the heading waits as one bone and no row says a line, as most will not. */}
      <SettingSection of={computer === undefined ? "work.access" : "pc.jobs"} description={!settled ? <Skeleton className="inline-block h-3 w-64 align-middle" /> : common ? accessWords(common) : undefined}>
        {failures}
        <ListFilter filter={filter} label="Find a job" />
        {missed.length ? (
          <PageError
            data-missed=""
            action={
              <Button variant="ghost" size="sm" disabled={retrying !== null} onClick={retryMissed}>
                <BusyLabel busy={retrying !== null} label="Retry" />
              </Button>
            }
          >
            {missedWords}
          </PageError>
        ) : null}
        {rows.map((job) => {
          const level = levelOf(job);
          const held = heldOf(job);
          // A job whose set is still out holds its name alone, and no way in yet.
          const opens = may(job.environmentId, "defaults.set") && !!level;
          return (
            <PageRow
              key={job.id}
              data-job={job.id}
              media={<SectorDot sector={job.sector ?? null} />}
              title={
                several ? (
                  <>
                    {job.name} <span className="text-muted-foreground">on {computerInLine(names(job.environmentId))}</span>
                  </>
                ) : (
                  job.name
                )
              }
              // The shared level is said once, in the heading's line; only a job on another level says its own.
              description={settled && level ? (held ? `${ACCESS_NAMES[level]}, as last read` : level !== common ? accessWords(level) : undefined) : undefined}
              onOpen={opens ? () => setOpen(job) : undefined}
              openLabel={`New threads in ${job.name}`}
            >
              {opens ? <OpenCue /> : null}
            </PageRow>
          );
        })}
      </SettingSection>
      {/* The same New threads dialog a job's page opens, whose failures it says at its own head. */}
      {open ? <ThreadDefaultsDialog workspace={open} onClose={() => setOpen(null)} /> : null}
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


/** Away for Work threads is Away's own switch: this row says where it stands and goes there. */
function AwayRow() {
  const { work } = useAway();
  // Away's state stands once this computer has said it: a default is no answer. Away's own page holds its read.
  const known = useStore(awayStore, (state) => state.pending !== null || registry.primaryEnvironmentId in state.hosts);
  useEffect(() => startAway(), []);
  return <SettingRow id="work.away" description={known ? (work ? "Away is on for Work threads" : "Off for Work threads") : undefined} onOpen={() => requestSettings("away", "away.work")} openLabel="Away" />;
}
