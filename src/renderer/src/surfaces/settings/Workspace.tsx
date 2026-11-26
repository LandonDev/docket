import { useEffect, useRef, useState, type ReactNode } from "react";
import { PROVIDER_NAME } from "@server/shared/usageMeter";
import { wordCount } from "@server/shared/preamble";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import { BuildEditor, takeRequestedBuildFocus } from "../../chrome/rail/buildSettings";
import { TurnPassEditor, useTurnPassRead } from "../../chrome/TurnPassFields";
import { ProjectSettingsDialog } from "../../chrome/ProjectDialogs";
import { PreambleDialog } from "../../chrome/PreambleDialog";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import { OrchestrationRulesEditor } from "../../chrome/OrchestrationRules";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { requestSettings } from "../../lib/monaco/debugTab";
import { BusyLabel, Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { takeRequestedRulesFocus, useRulesScope } from "../../lib/tcserver/rules";
import { useProjects, useWorkspaces } from "../../lib/tcserver/workspaces";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { setWorkspaceAccounts } from "../../lib/tcserver/projects";
import { useAccounts } from "../../stores/accounts";
import { pinRowShown, shortName } from "../../lib/accountScope";
import { useLinkMay } from "../../lib/linkMay";
import { useComputerName } from "../../lib/settings/computerName";
import { useAccountsRead } from "./parts/useAccountsRead";
import { ReadFailure } from "./parts/ReadFailure";
import { ListFilter, useListFilter } from "./parts/ListFilter";
import { ManagedLine } from "./parts/ManagedLine";
import { SaveMark } from "./parts/SaveMark";
import { OpenCue, SettingRow, SettingSection } from "./parts/SettingRow";
import { StartSetRow } from "./parts/StartSetRow";
import { useSaved } from "./parts/useSaved";

/**
 * A code workspace's page (docs/agents/settings.md "The pages: jobs, workspaces, Archive"): New threads, After each
 * turn, Accounts, Build, Subagents, its job (`job`, drawn from Work's chunk while Work is on for its computer), then
 * its projects. Every row changes this workspace alone, on its own computer. The rows an admin key alone may change
 * are words for any other key, with one line saying who can, said once at the top. The Build rail tab and the
 * workspace menu's rules item deep-link here with their section in view.
 */
export function WorkspacePage({ workspaceId, job }: { workspaceId: string; job?: ReactNode }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const build = useRef<HTMLDivElement>(null);
  const rules = useRef<HTMLDivElement>(null);
  // What a deep link asked for, taken once: the Build section in view, or the rules for its agents open in their sheet.
  const [asked] = useState(() => ({ build: takeRequestedBuildFocus(), rules: takeRequestedRulesFocus() }));
  useEffect(() => {
    // A jump the person asked for: no smooth scroll. Focus lands on the section, so the next Tab reaches its first control.
    const target = asked.build ? build.current : asked.rules ? rules.current : null;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [asked]);
  // The page's one read: After each turn's pass. Until it answers every section stands in its shape; refused, it is one
  // red line with one Retry under the first heading, and the rest keep their shape rather than say it again.
  const pass = useTurnPassRead(workspaceId);
  if (!workspace) return null;
  if (!pass.read.value) return <WorkspaceShapes workspace={workspace} error={pass.read.error} retry={pass.read.retry} />;
  return (
    <>
      <NewThreadsSection workspace={workspace} />
      <TurnPassEditor workspaceId={workspaceId} pass={pass} />
      <AccountsSection workspace={workspace} />
      <div id="settings-build" ref={build} tabIndex={-1} className="outline-none">
        <BuildEditor workspaceId={workspaceId} />
      </div>
      <div id="settings-orchestration" ref={rules} tabIndex={-1} className="outline-none">
        <AgentsSection workspace={workspace} startOpen={asked.rules} />
      </div>
      {job}
      <ProjectsSection workspace={workspace} />
    </>
  );
}

/** The page while its read is out, or once refused: each section's heading, its rows in their shape. */
function WorkspaceShapes({ workspace, error, retry }: { workspace: WorkspaceMeta; error: string | null; retry: () => void }) {
  const projects = useProjects().filter((p) => p.workspaceId === workspace.id && !p.archived).length;
  const may = useLinkMay(workspace.environmentId, "turnpass.set");
  const control = (kind: "button" | "switch" | "select" | "field") => (may ? kind : ("none" as const));
  // Refused: the one line, the computer named, and nothing under it. Bones say "waiting", which this no longer is.
  if (error) {
    return (
      <PageSection>
        <ReadFailure computer={workspace.environmentId} error={error} retry={retry} />
      </PageSection>
    );
  }
  return (
    <>
      <SettingSection of="ws.threads">
        <PageRowsSkeleton rows={[{ description: true, control: control("button") }, { description: true, control: control("button") }]} />
      </SettingSection>
      <SettingSection of="ws.checks">
        <PageRowsSkeleton rows={[{ control: control("switch") }, { control: control("switch") }, { control: control("select") }]} />
      </SettingSection>
      <SettingSection of="ws.accounts">
        <PageRowsSkeleton rows={2} media description control="none" />
      </SettingSection>
      <SettingSection of="ws.command">
        <PageRowsSkeleton rows={[{ description: true, control: control("field"), wide: may }, { description: true, control: control("field"), wide: may }]} />
      </SettingSection>
      <SettingSection of="ws.agents">
        <PageRowsSkeleton rows={[{ description: true, control: control("button") }]} />
      </SettingSection>
      {projects ? (
        <SettingSection of="ws.projects">
          <PageRowsSkeleton rows={Math.min(projects, 8)} control="none" />
        </SettingSection>
      ) : null}
    </>
  );
}

/** Model and access, the rules read before the first message; and, for a key that may change none of the page, who can. */
function NewThreadsSection({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const mayDefaults = useLinkMay(env, "defaults.set");
  const mayRules = useLinkMay(env, "workspace.setPreamble");
  const mayAdmin = useLinkMay(env, "turnpass.set");
  const computer = useComputerName(env);
  const [editing, setEditing] = useState(false);
  return (
    <SettingSection of="ws.threads">
      <StartSetRow id="ws.threads" workspace={workspace} whose="workspace" may={mayDefaults} />
      <SettingRow id="ws.rules" description={preambleWords(workspace)}>
        {mayRules ? (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit…
          </Button>
        ) : null}
      </SettingRow>
      {mayAdmin ? null : <ManagedLine computer={computer.name} />}
      {editing ? <PreambleDialog scope={{ kind: "workspace", workspace }} onClose={() => setEditing(false)} /> : null}
    </SettingSection>
  );
}

/** "214 words, on", "214 words, off", or "None". */
export function preambleWords(workspace: Pick<WorkspaceMeta, "preamble" | "preambleEnabled">): string {
  const text = workspace.preamble?.trim();
  if (!text) return "None";
  const n = wordCount(text);
  return `${n} ${n === 1 ? "word" : "words"}, ${workspace.preambleEnabled === false ? "off" : "on"}`;
}

/**
 * The AI account this workspace's threads spend from, per agent app. Auto picks by model and moves a thread when its
 * account runs out; a project or a thread can still pin its own. Each saves with the mark; a refusal puts it back.
 */
function AccountsSection({ workspace }: { workspace: WorkspaceMeta }) {
  // The accounts are their own read: bones until the computer answers, then the true value; never the empty
  // snapshot standing in for an answer ("Auto, no other account" before anything was asked).
  const accounts = useAccountsRead(workspace.environmentId);
  const may = useLinkMay(workspace.environmentId, "workspace.setAccounts");
  const pins = workspace.accountPins ?? {};
  const snapshot = accounts.snapshot;
  if (!snapshot) {
    return (
      <SettingSection of="ws.accounts">
        {accounts.error ? (
          <ReadFailure computer={workspace.environmentId} error={accounts.error} retry={accounts.retry} />
        ) : (
          // In the shape of the rows that land most often: an agent app, its value as words, an open row.
          <PageRowsSkeleton rows={2} media description control="none" />
        )}
      </SettingSection>
    );
  }
  const rows = ROUTED_PROVIDERS.filter((provider) => pinRowShown(provider, snapshot.providers[provider].profiles, pins[provider] ?? ""));
  if (rows.length === 0) return null;
  return (
    <SettingSection of="ws.accounts">
      {rows.map((provider) => (
        <AccountRow key={provider} workspace={workspace} provider={provider} profiles={snapshot.providers[provider].profiles} may={may} />
      ))}
    </SettingSection>
  );
}

type Profile = ReturnType<typeof useAccounts>["snapshot"]["providers"][(typeof ROUTED_PROVIDERS)[number]]["profiles"][number];

function AccountRow({ workspace, provider, profiles, may }: { workspace: WorkspaceMeta; provider: (typeof ROUTED_PROVIDERS)[number]; profiles: Profile[]; may: boolean }) {
  const saved = useSaved();
  const [picked, setPicked] = useState<string | null>(null);
  const pins = workspace.accountPins ?? {};
  const current = pins[provider] ?? "";
  const pinned = profiles.find((p) => p.name === current);
  const known = current === "" || !!pinned;
  // No account to pick: Auto is the value, said as words, and the row goes to AI accounts where one is added.
  if (may && profiles.length === 0 && current === "") {
    return (
      <PageRow
        media={<HarnessIcon harness={provider} className="size-4 shrink-0" />}
        title={PROVIDER_NAME[provider]}
        description="Auto, no other account to pick"
        onOpen={() => requestSettings("accounts")}
        openLabel={`${PROVIDER_NAME[provider]}: AI accounts`}
      >
        <OpenCue />
      </PageRow>
    );
  }
  const choose = (next: string): void => {
    const updated: AccountPins = { ...pins };
    if (next) updated[provider] = next;
    else delete updated[provider];
    setPicked(next);
    void saved.run(() => setWorkspaceAccounts(workspace.id, updated)).then(() => setPicked(null));
  };
  return (
    <PageRow
      media={<HarnessIcon harness={provider} className="size-4 shrink-0" />}
      title={PROVIDER_NAME[provider]}
      description={may ? undefined : pinned ? shortName(pinned) : current || "Auto"}
      error={saved.error ?? undefined}
    >
      {may ? (
        <>
          <SaveMark state={saved.state} />
          <ChoiceSelect
            label={`${PROVIDER_NAME[provider]} account`}
            value={picked ?? current}
            onChange={choose}
            options={[
              { value: "", label: "Auto" },
              ...profiles.map((p) => ({ value: p.name, label: shortName(p) })),
              ...(known ? [] : [{ value: current, label: `${current}, not in AI accounts` }]),
            ]}
          />
        </>
      ) : null}
    </PageRow>
  );
}

/**
 * Subagents: this workspace's own rules for its agents, or the set every computer reads. Change… opens the Subagents
 * editor for this workspace in a sheet; once it keeps its own, the editor's Use Subagents… asks first, since the set
 * it kept goes.
 */
function AgentsSection({ workspace, startOpen = false }: { workspace: WorkspaceMeta; startOpen?: boolean }) {
  const env = workspace.environmentId;
  const { scope, error, retry } = useRulesScope(env, workspace.id);
  const may = useLinkMay(env, "rules.set");
  const [open, setOpen] = useState(startOpen);
  return (
    <SettingSection of="ws.agents">
      {scope ? (
        <SettingRow id="ws.agents" description={scope.overridden ? "Set for this workspace" : "Same as Subagents"}>
          {may ? (
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              Change…
            </Button>
          ) : null}
        </SettingRow>
      ) : error ? (
        <PageRow title={<span className="sr-only">Rules for its agents</span>} error={error}>
          <Button variant="ghost" size="sm" onClick={retry}>
            <BusyLabel busy={false} label="Retry" />
          </Button>
        </PageRow>
      ) : (
        <PageRowsSkeleton rows={[{ description: true, control: may ? "button" : "none" }]} />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" width={560}>
          {/* The editor holds its own Use Subagents…, which asks first: the sheet adds no second one. */}
          <SheetHeader>
            <SheetTitle>Rules for {workspace.name}'s agents</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto px-5 pb-5 @container/page">
            <OrchestrationRulesEditor workspaceId={workspace.id} />
          </div>
        </SheetContent>
      </Sheet>
    </SettingSection>
  );
}

/** Its projects by name, each opening its sheet; a find field past eight. */
function ProjectsSection({ workspace }: { workspace: WorkspaceMeta }) {
  const projects = useProjects()
    .filter((p) => p.workspaceId === workspace.id && !p.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const filter = useListFilter(projects, projectWords);
  const { snapshot } = useAccounts(workspace.environmentId);
  const [open, setOpen] = useState<ProjectMeta | null>(null);
  if (projects.length === 0) return null;
  return (
    <SettingSection of="ws.projects">
      <ListFilter filter={filter} label="Find a project" />
      {filter.shown.map((project) => (
        <PageRow key={project.id} title={project.name} description={pinsLine({ ...workspace.accountPins, ...project.accountPins }, snapshot)} onOpen={() => setOpen(project)} openLabel={`${project.name} settings`}>
          <OpenCue />
        </PageRow>
      ))}
      {open ? <ProjectSettingsDialog project={open} workspace={workspace} onClose={() => setOpen(null)} /> : null}
    </SettingSection>
  );
}

const projectWords = (project: ProjectMeta): string => project.name;

/** The accounts a project's threads spend from (its pins over the workspace's), one span per agent app; nothing when none is pinned. */
function pinsLine(pins: AccountPins, snapshot: ReturnType<typeof useAccounts>["snapshot"]): ReactNode {
  const pinned = ROUTED_PROVIDERS.filter((provider) => pins[provider]);
  if (pinned.length === 0) return undefined;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {pinned.map((provider) => {
        const name = pins[provider]!;
        const profile = snapshot.providers[provider].profiles.find((p) => p.name === name);
        return (
          <span key={provider} className="inline-flex items-center gap-1">
            <HarnessIcon harness={provider} className="size-3 shrink-0" />
            {profile ? shortName(profile) : name}
          </span>
        );
      })}
    </span>
  );
}
