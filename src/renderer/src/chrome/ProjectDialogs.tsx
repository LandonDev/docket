import { dialogErrorWords } from "../lib/dialogErrorWords";
import { actionFailed } from "../lib/threadActionToast";
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ModalBody, ModalPanel, useClosingDialog } from "./Modal";
import { CheckRow, Field, FieldRow } from "./DialogField";
import { Dialog } from "@renderer/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@renderer/components/ui/sheet";
import { PageError, PageRowsSkeleton } from "@renderer/components/page";
import { DEFAULT_START_ON, type StartOn } from "@server/shared/defaults";
import { START_ON_OPTIONS } from "../lib/tcserver/defaults";
import { useThreadDefaults } from "../lib/tcserver/workspaces";
import { ChoiceSelect } from "../components/choice-select";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { ChoiceToggle } from "../components/choice-toggle";
import { BUILD_EMPTY, BuildFields, buildOrNull } from "./rail/buildSettings";
import { ConfirmDialog, DialogFooter as Footer, ErrorLine, confirmAction } from "./ConfirmDialog";
import { COMMIT_OPTIONS, TurnPassFieldRows, loadTurnPass, saveTurnPass } from "./TurnPassFields";
import { settingTitle } from "../lib/settings/map";
import { PlanSettingsFields } from "./PlanSettingsFields";
import { savePlanSettings, samePlanSettings, usePlanSettings, usePlanSettingsError } from "../lib/tcserver/plans";
import type { PlanSettings } from "@server/shared/plans";
import { ReviewFields, saveReviewSettings, useReviewScope } from "./ReviewFields";
import { DEFAULT_REVIEW_SETTINGS, type ReviewSettings } from "@server/shared/review";
import { AccountPinFields, projectInheritLabel } from "./AccountPinFields";
import { registry } from "../lib/connection";
import { managedElsewhere, useLinkMay } from "../lib/linkMay";
import { refusalWords } from "../lib/settingsHome";
import { useAccounts } from "../stores/accounts";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import type { BuildConfig } from "@server/shared/build";
import { TURN_PASS_OFF, passEnabled, type TurnPass } from "@server/shared/turnpass";
import { prettyCwd } from "../lib/paths";
import {
  createProject,
  createWorkspace,
  listBranches,
  renameProject,
  setProjectAccounts,
  setProjectStartOn,
  setProjectBranch,
} from "../lib/tcserver/projects";
import { archiveLinked, deleteLinked, liveHostFacts, useProjectHome } from "../lib/projectHome";
import { workShellChunk } from "../surfaces/chunks";
import type {
  BranchList,
  ProjectCleanup,
  ProjectMeta,
  ProjectMode,
  WorkspaceMeta,
} from "../lib/tcserver/types";

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const samePass = (a: TurnPass | null, b: TurnPass | null) =>
  a === b || (!!a && !!b && a.verify === b.verify && a.build === b.build && a.commit === b.commit);

const samePins = (a: AccountPins, b: AccountPins) =>
  ROUTED_PROVIDERS.every((p) => (a[p] ?? "") === (b[p] ?? ""));

const sameReview = (a: ReviewSettings | null, b: ReviewSettings | null) =>
  a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

/**
 * One project's pass, plus the workspace pass it would inherit: each undefined until its read answers. A failed read
 * is `error` (with `retry`), never a pass of nothing standing in for the host's.
 */
function useTurnPass(workspaceId: string, projectId?: string) {
  const [pass, setPass] = useState<TurnPass | null | undefined>(undefined);
  const [inherited, setInherited] = useState<TurnPass | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    const failed = (err: unknown) => live && setError(refusalWords(err));
    loadTurnPass(workspaceId).then((p) => live && setInherited(p), failed);
    if (projectId) loadTurnPass(workspaceId, projectId).then((p) => live && setPass(p), failed);
    else setPass(null);
    return () => {
      live = false;
    };
  }, [workspaceId, projectId, attempt]);
  return { pass, setPass, inherited, error, retry: () => setAttempt((n) => n + 1) };
}

function useBranches(workspaceId: string, enabled: boolean): BranchList | null {
  const [list, setList] = useState<BranchList | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    listBranches(workspaceId)
      .then((l) => live && setList(l))
      .catch(() => live && setList({ locals: [], remotes: [], current: null }));
    return () => {
      live = false;
    };
  }, [workspaceId, enabled]);
  return list;
}

function branchExists(list: BranchList | null, name: string): boolean {
  if (!list || !name) return false;
  return (
    list.locals.includes(name) ||
    list.remotes.includes(name) ||
    list.remotes.includes(`origin/${name}`)
  );
}

function suggestionsFor(list: BranchList | null, needle: string): string[] {
  if (!list) return [];
  const q = needle.trim().toLowerCase();
  if (!q) return [];
  const all = [...new Set([...list.locals, ...list.remotes])];
  return all
    .filter((b) => b !== needle && b.toLowerCase().includes(q))
    .slice(0, 4);
}

function BranchField({
  value,
  onChange,
  branches,
  placeholder,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  branches: BranchList | null;
  placeholder?: string;
  hint?: string;
}) {
  const suggestions = suggestionsFor(branches, value);
  return (
    <div className="flex flex-col gap-1.5">
      <Field label="Branch" hint={hint}>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          className="font-mono"
        />
      </Field>
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((b) => (
            <Button key={b} type="button" variant="ghost" size="xs" className="font-mono text-muted-foreground" onClick={() => onChange(b)}>
              {b}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BaseRefField({
  value,
  onChange,
  branches,
}: {
  value: string;
  onChange: (v: string) => void;
  branches: BranchList | null;
}) {
  const head = branches?.current ? `Current HEAD (${branches.current})` : "Current HEAD";
  const groups = (
    [
      ["Local", branches?.locals ?? []],
      ["Remote", branches?.remotes ?? []],
    ] as const
  ).filter(([, names]) => names.length);
  const items = [{ value: "@head", label: head }, ...groups.flatMap(([, names]) => names.map((b) => ({ value: b, label: b })))];
  return (
    <Field label="Start from">
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="@head">{head}</SelectItem>
          </SelectGroup>
          {groups.map(([group, names]) => (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {names.map((b) => (
                <SelectItem key={`${group}:${b}`} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** A section of a form without a fold: the 12px muted heading over its fields. */
function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A group's read that failed: its words, and Retry at the end of the same line, as a page says it. */
function GroupError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <PageError
      action={
        <Button type="button" variant="ghost" size="sm" onClick={retry}>
          <BusyLabel busy={false} label="Retry" />
        </Button>
      }
    >
      {error}
    </PageError>
  );
}

/** Back to the set a group follows: a quiet button at the end of its heading line. */
function FollowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="xs" className="-me-2" onClick={onClick}>
      {label}
    </Button>
  );
}

/** A value a key may not change, as words where its control would stand. */
function Value({ children }: { children: ReactNode }) {
  return <span className="text-[13px] text-muted-foreground">{children}</span>;
}

/** After each turn as words, for a key that may not set it. */
function TurnPassWords({ value }: { value: TurnPass }) {
  return (
    <>
      <FieldRow label={settingTitle("ws.checks")}>
        <Value>{value.verify ? "On" : "Off"}</Value>
      </FieldRow>
      <FieldRow label={settingTitle("ws.build")}>
        <Value>{value.build ? "On" : "Off"}</Value>
      </FieldRow>
      <FieldRow label={settingTitle("ws.commit")}>
        <Value>{COMMIT_OPTIONS.find((o) => o.value === value.commit)?.label}</Value>
      </FieldRow>
    </>
  );
}

// ---------------------------------------------------------------------------

export function NewWorkspaceDialog({
  path,
  environmentId,
  onClose,
  onCreated,
}: {
  path: string;
  /** The machine the folder is on; this one when absent. */
  environmentId?: string | null;
  onClose: () => void;
  onCreated: (workspace: WorkspaceMeta) => void;
}) {
  const [pass, setPass] = useState<TurnPass>(TURN_PASS_OFF);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      // This machine's folder dialog, or another host's folders over its link.
      const workspace = await createWorkspace(environmentId ?? registry.primary().environmentId, path);
      // Made is made: a setting the host then refuses is said by name, and
      // the dialog closes on the workspace, so Add never makes a second one.
      if (passEnabled(pass)) await saveTurnPass(workspace.id, pass).catch((err) => actionFailed("save After each turn", workspace.name, err));
      setPending(false);
      closeThen(() => onCreated(workspace));
    } catch (err) {
      setError(dialogErrorWords(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={onClose} busy={pending} title={`Add ${baseName(path)}`} description={prettyCwd(path)} size="sm">
        <form onSubmit={submit}>
          <div className="flex flex-col gap-4 px-5 py-4">
            <Section label="After each turn">
              <TurnPassFieldRows value={pass} onChange={setPass} />
            </Section>
            <ErrorLine error={error} />
          </div>
          <Footer onCancel={() => closeThen(onClose)} confirmLabel="Add workspace" pending={pending} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

export function NewProjectDialog({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: WorkspaceMeta;
  onClose: () => void;
  onCreated: (project: ProjectMeta) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ProjectMode>(
    workspace.git ? "worktree" : "local",
  );
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("@head");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branches = useBranches(workspace.id, workspace.git);
  const exists = branchExists(branches, branch.trim());
  const { inherited } = useTurnPass(workspace.id);
  const [pass, setPass] = useState<TurnPass | null>(null);
  const shownPass = pass ?? inherited ?? TURN_PASS_OFF;
  const { root, closeThen } = useClosingDialog(onClose, pending);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const b = branch.trim();
      const project = await createProject({
        workspaceId: workspace.id,
        name: trimmed,
        mode,
        ...(mode === "worktree" && b ? { branch: b } : {}),
        ...(mode === "worktree" && !exists && baseRef !== "@head"
          ? { baseRef }
          : {}),
      });
      if (pass && !samePass(pass, inherited ?? null)) {
        await saveTurnPass(workspace.id, pass, project.id).catch((err) => actionFailed("save After each turn", project.name, err));
      }
      setPending(false);
      closeThen(() => onCreated(project));
    } catch (err) {
      setError(dialogErrorWords(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={onClose} busy={pending} title="New project" description={workspace.name} size="sm">
        <form onSubmit={submit}>
          <div className="flex flex-col gap-4 px-5 py-4">
            <Field label="Name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What are you working on?" />
            </Field>
            <FieldRow
              label="Mode"
              description={mode === "worktree" ? "Own branch and folder." : `Works directly in ${workspace.name}.`}
            >
              <ChoiceToggle
                label="Mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "worktree", label: "Worktree", disabled: !workspace.git, note: workspace.git ? undefined : "Needs a git repository" },
                  { value: "local", label: "Local" },
                ]}
              />
            </FieldRow>
            {mode === "worktree" ? (
              <>
                <BranchField
                  value={branch}
                  onChange={setBranch}
                  branches={branches}
                  placeholder="Branch (automatic)"
                  hint={exists ? "Opens the existing branch." : undefined}
                />
                {exists ? null : <BaseRefField value={baseRef} onChange={setBaseRef} branches={branches} />}
              </>
            ) : null}
            <Section label="After each turn">
              <TurnPassFieldRows value={shownPass} onChange={setPass} />
            </Section>
            <ErrorLine error={error} />
          </div>
          <Footer onCancel={() => closeThen(onClose)} confirmLabel="Create" pending={pending} disabled={!name.trim()} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

// A Work project's sheet (work/shell/ProjectSettings.tsx): nothing of code in it, and none of it loaded for a code project.
const WorkProjectSettings = workShellChunk.surface("WorkProjectSettings");

/**
 * A project's settings. A project of a Work workspace gets Work's own sheet,
 * picked by the row's kind, never by the switch. A linked project's live on its settings home (the
 * box's copy, lib/projectHome.ts): every field but the branch is read from
 * that copy and saved to it over its host's link, the footer says where,
 * and a home out of reach disables Save with the reason. The branch and the
 * folder are this copy's own.
 */
export function ProjectSettingsDialog({
  project,
  workspace,
  onClose,
}: {
  project: ProjectMeta;
  workspace: WorkspaceMeta;
  onClose: () => void;
}) {
  if (workspace.kind === "work") return <WorkProjectSettings project={project} workspace={workspace} onClose={onClose} />;
  return <CodeProjectSettings project={project} workspace={workspace} onClose={onClose} />;
}

function CodeProjectSettings({
  project,
  workspace,
  onClose,
}: {
  project: ProjectMeta;
  workspace: WorkspaceMeta;
  onClose: () => void;
}) {
  const at = useProjectHome(project);
  const note = at.blocked ?? (at.linked ? `Saved on ${at.hostName}` : undefined);
  // A new home (a host's hello naming its platform late) starts the drafts over.
  return (
    <ProjectSettingsBody
      key={`${at.home.environmentId}:${at.home.id}`}
      project={project}
      workspace={workspace}
      home={at.home}
      homeWorkspace={at.workspace ?? workspace}
      linked={at.linked}
      note={note}
      blocked={at.blocked}
      onClose={onClose}
    />
  );
}

function ProjectSettingsBody({
  project,
  workspace,
  home,
  homeWorkspace,
  linked,
  note,
  blocked,
  onClose,
}: {
  /** The copy the dialog was opened on: its branch and folder. */
  project: ProjectMeta;
  workspace: WorkspaceMeta;
  /** The copy holding the settings, and its workspace. */
  home: ProjectMeta;
  homeWorkspace: WorkspaceMeta;
  /** Another host holds a copy: only then does "New threads start on" mean anything. */
  linked: boolean;
  note?: string;
  blocked: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(home.name);
  const [branch, setBranch] = useState(project.branch ?? "");
  const [baseRef, setBaseRef] = useState("@head");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worktree = project.mode === "worktree";
  const branches = useBranches(workspace.id, worktree);
  const exists = branchExists(branches, branch.trim());
  const [savedBuild, setSavedBuild] = useState<BuildConfig | null | undefined>(undefined);
  const [buildOverride, setBuildOverride] = useState<BuildConfig | null>(null);
  const [wsBuild, setWsBuild] = useState<BuildConfig | null>(null);
  const [detected, setDetected] = useState<BuildConfig | null>(null);
  // A failed read of the project's own build is said with Retry: an empty field standing in for it would save over it.
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildAttempt, setBuildAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setBuildError(null);
    void registry.linkOf(home.environmentId)
      .request<BuildConfig | null>("build.get", { workspaceId: homeWorkspace.id, projectId: home.id })
      .then((c) => {
        if (!live) return;
        setSavedBuild(c);
        setBuildOverride(c);
      })
      .catch((err: unknown) => live && setBuildError(refusalWords(err)));
    void registry.linkOf(home.environmentId)
      .request<BuildConfig | null>("build.get", { workspaceId: homeWorkspace.id })
      .then((c) => live && setWsBuild(c))
      .catch(() => {});
    void registry.linkOf(home.environmentId)
      .request<BuildConfig | null>("build.detect", { path: home.cwd })
      .then((d) => live && setDetected(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [homeWorkspace.id, home.id, home.cwd, home.environmentId, buildAttempt]);
  const [pins, setPins] = useState<AccountPins>(home.accountPins ?? {});
  const { snapshot } = useAccounts(home.environmentId);
  // A key that may not pin accounts (a given computer's) is not drawn them: the host would refuse the save.
  const mayPin = useLinkMay(home.environmentId, "project.setAccounts");
  // The rest of the sheet but the name and branch is the host's admin rule: a key that may not save a group reads it
  // as words, and the sheet says once who can.
  const may = {
    pass: useLinkMay(home.environmentId, "turnpass.set"),
    review: useLinkMay(home.environmentId, "review.set"),
    plans: useLinkMay(home.environmentId, "plans.set"),
    startOn: useLinkMay(home.environmentId, "project.setStartOn"),
    build: useLinkMay(home.environmentId, "build.set"),
  };
  const managed = !mayPin || !may.pass || !may.review || !may.plans || !may.startOn || !may.build;
  const hostName = liveHostFacts.nameOf(home.environmentId);
  const turnPass = useTurnPass(homeWorkspace.id, home.id);
  const { pass, setPass, inherited } = turnPass;
  const reviewLoad = useReviewScope(home.environmentId, home.id);
  const reviewScope = reviewLoad.scope;
  // undefined until the scope loads; null = follows the global set.
  const [review, setReview] = useState<ReviewSettings | null | undefined>(undefined);
  useEffect(() => {
    if (reviewScope && review === undefined) setReview(reviewScope.override);
  }, [reviewScope, review]);
  const shownReview = review ?? reviewScope?.global ?? DEFAULT_REVIEW_SETTINGS;
  const reviewDirty = !!reviewScope && review !== undefined && !sameReview(review, reviewScope.override);
  const [savedPass, setSavedPass] = useState<TurnPass | null | undefined>(undefined);
  useEffect(() => {
    if (pass !== undefined && savedPass === undefined) setSavedPass(pass);
  }, [pass, savedPass]);
  const shownPass = pass ?? inherited ?? TURN_PASS_OFF;
  // Plans: the project's override, else what it inherits from the host's global set.
  const planScope = usePlanSettings(home.environmentId, home.id);
  const globalPlans = usePlanSettings(home.environmentId, null);
  const projectPlansFailure = usePlanSettingsError(home.environmentId, home.id);
  const globalPlansFailure = usePlanSettingsError(home.environmentId, null);
  const plansFailure = projectPlansFailure ?? globalPlansFailure;
  const [plans, setPlans] = useState<PlanSettings | null | undefined>(undefined);
  useEffect(() => {
    if (planScope && plans === undefined) setPlans(planScope.overridden ? planScope.settings : null);
  }, [planScope, plans]);
  const shownPlans = plans ?? globalPlans?.settings ?? planScope?.settings;
  const plansDirty =
    planScope !== undefined &&
    plans !== undefined &&
    (planScope.overridden ? !plans || !samePlanSettings(plans, planScope.settings) : plans !== null);

  // New threads: the project's own host, else Thread defaults' (one copy, on the box), else the box.
  const globalStartOn = useThreadDefaults(registry.primary().environmentId, null)?.defaults.startOn ?? DEFAULT_START_ON;
  const [startOn, setStartOn] = useState<StartOn | null>(home.startOn ?? null);
  const startOnDirty = startOn !== (home.startOn ?? null);

  const nameDirty = name.trim() !== home.name && !!name.trim();
  const branchDirty =
    worktree && !!branch.trim() && branch.trim() !== (project.branch ?? "");
  const nextBuild = buildOrNull(buildOverride);
  const buildDirty =
    savedBuild !== undefined &&
    ((nextBuild?.command ?? "") !== (savedBuild?.command ?? "") ||
      (nextBuild?.outputs ?? "") !== (savedBuild?.outputs ?? ""));
  const passDirty = savedPass !== undefined && !samePass(pass ?? null, savedPass);
  const pinsDirty = !samePins(pins, home.accountPins ?? {});
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const dirty = nameDirty || branchDirty || buildDirty || passDirty || pinsDirty || plansDirty || reviewDirty || startOnDirty;
  // Each changed group saves on its own, in the sheet's order: one refused leaves the others saved, and the line says
  // which did not and why, and which did. A group that saved is the new baseline, so Save again tries the rest.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending || blocked) return;
    setPending(true);
    setError(null);
    const groups: { name: string; dirty: boolean; save: () => Promise<unknown>; landed?: () => void }[] = [
      { name: "Branch", dirty: branchDirty, save: () => setProjectBranch(project.id, branch.trim(), !exists && baseRef !== "@head" ? baseRef : undefined) },
      { name: "Name", dirty: nameDirty, save: () => renameProject(home.id, name.trim()) },
      { name: "New threads", dirty: startOnDirty, save: () => setProjectStartOn(home.id, startOn) },
      { name: "After each turn", dirty: passDirty, save: () => saveTurnPass(homeWorkspace.id, pass ?? null, home.id), landed: () => setSavedPass(pass ?? null) },
      { name: "Reviews", dirty: reviewDirty, save: () => saveReviewSettings(home.environmentId, home.id, review ?? null) },
      { name: "Accounts", dirty: pinsDirty, save: () => setProjectAccounts(home.id, pins) },
      { name: "Plans", dirty: plansDirty, save: () => savePlanSettings(home.environmentId, home.id, plans ?? null) },
      {
        name: "Build",
        dirty: buildDirty,
        save: () => registry.linkOf(home.environmentId).request("build.set", { workspaceId: homeWorkspace.id, projectId: home.id, config: nextBuild }),
        landed: () => setSavedBuild(nextBuild),
      },
    ];
    const saved: string[] = [];
    const refused: { name: string; why: string }[] = [];
    for (const group of groups.filter((g) => g.dirty)) {
      try {
        await group.save();
        group.landed?.();
        saved.push(group.name);
      } catch (err) {
        refused.push({ name: group.name, why: refusalWords(err) });
      }
    }
    setPending(false);
    if (refused.length === 0) closeThen(onClose);
    else setError(partialSaveWords(saved, refused));
  };

  // Save waits until every group has answered: a group still reading has nothing of his to save yet, and one that did
  // not answer is never written, which the footer says.
  const loading = (!turnPass.error && (pass === undefined || inherited === undefined)) || (!buildError && savedBuild === undefined) || (!reviewLoad.error && !reviewScope) || (!plansFailure && !planScope);
  const unloaded = !!(turnPass.error || buildError || reviewLoad.error || plansFailure);

  // Cancel, Escape, the backdrop and the close button: a changed draft asks before it is dropped.
  const cancel = async (): Promise<void> => {
    if (pending) return;
    if (dirty && !(await confirmAction({ title: "Discard your changes?", body: `What you changed in ${home.name}'s settings is not saved.`, action: "Discard", danger: true }))) return;
    closeThen(onClose);
  };

  return (
    <Sheet {...root} onOpenChange={(open) => (open ? root.onOpenChange(open) : void cancel())}>
      <SheetContent side="right" showCloseButton={!pending} aria-busy={pending || undefined}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader>
            <SheetTitle>Project settings</SheetTitle>
            <SheetDescription className="flex min-w-0 gap-1 text-xs">
              <span data-project-mode className="shrink-0 font-medium">{worktree ? "Worktree" : "Local"}</span>
              <span className="min-w-0 truncate">{prettyCwd(project.cwd)}</span>
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div className="flex flex-col gap-6 px-5 pb-6">
              <div className="flex flex-col gap-4">
                <Field label="Name">
                  <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                {worktree ? (
                  <>
                    <BranchField
                      value={branch}
                      onChange={setBranch}
                      branches={branches}
                      hint={branchDirty && exists ? "Switches to the existing branch." : undefined}
                    />
                    {branchDirty && !exists ? <BaseRefField value={baseRef} onChange={setBaseRef} branches={branches} /> : null}
                  </>
                ) : null}
              </div>
              {managed ? <p data-managed className="text-xs text-muted-foreground">{managedElsewhere(hostName)}</p> : null}
              {linked ? (
                <Section label="New threads" action={startOn && may.startOn ? <FollowButton label="Use global setting" onClick={() => setStartOn(null)} /> : undefined}>
                  <FieldRow label="Start on">
                    {may.startOn ? (
                      <ChoiceSelect
                        label="New threads start on"
                        size="sm"
                        value={startOn ?? globalStartOn}
                        options={START_ON_OPTIONS}
                        onChange={(next: string) => setStartOn(next as StartOn)}
                      />
                    ) : (
                      <Value>{START_ON_OPTIONS.find((o) => o.value === (startOn ?? globalStartOn))?.label}</Value>
                    )}
                  </FieldRow>
                </Section>
              ) : null}
              <Section label="After each turn" action={pass && may.pass ? <FollowButton label="Use workspace setting" onClick={() => setPass(null)} /> : undefined}>
                {pass !== undefined && inherited !== undefined ? (
                  may.pass ? (
                    <TurnPassFieldRows value={shownPass} onChange={setPass} />
                  ) : (
                    <TurnPassWords value={shownPass} />
                  )
                ) : turnPass.error ? (
                  <GroupError error={turnPass.error} retry={turnPass.retry} />
                ) : (
                  <PageRowsSkeleton rows={[{ control: "switch" }, { control: "switch" }, { control: "select" }]} />
                )}
              </Section>
              <Section label="Reviews" action={review && may.review ? <FollowButton label="Use global setting" onClick={() => setReview(null)} /> : undefined}>
                {/* Editable once the project's scope answered, as Plans below. */}
                {reviewScope && !may.review ? (
                  <FieldRow label="Review before merge">
                    <Value>{shownReview.beforeMerge ? "On" : "Off"}</Value>
                  </FieldRow>
                ) : reviewScope ? (
                  <ReviewFields value={shownReview} onChange={setReview} environmentId={home.environmentId} compact />
                ) : reviewLoad.error ? (
                  <GroupError error={reviewLoad.error} retry={reviewLoad.retry} />
                ) : (
                  <PageRowsSkeleton rows={[{ control: "switch" }]} />
                )}
              </Section>
              {mayPin ? (
                <Section label="Accounts">
                  <AccountPinFields
                    environmentId={home.environmentId}
                    value={pins}
                    onChange={setPins}
                    inheritLabel={projectInheritLabel(homeWorkspace, [...snapshot.providers.claude.profiles, ...snapshot.providers.codex.profiles])}
                  />
                </Section>
              ) : null}
              <Section label="Plans" action={plans && may.plans ? <FollowButton label="Use global setting" onClick={() => setPlans(null)} /> : undefined}>
                {/* Editable only once the project's own scope answered: a
                    change made on the inherited set alone would never save. */}
                {planScope && shownPlans && !may.plans ? (
                  <FieldRow label="Start the build when a plan is done">
                    <Value>{shownPlans.autoImplement ? "On" : "Off"}</Value>
                  </FieldRow>
                ) : planScope && shownPlans ? (
                  <PlanSettingsFields value={shownPlans} onChange={setPlans} environmentId={home.environmentId} compact />
                ) : plansFailure ? (
                  <GroupError error={plansFailure.error} retry={plansFailure.retry} />
                ) : (
                  // The five rows PlanSettingsFields draws, in their shape.
                  <PageRowsSkeleton rows={5} />
                )}
              </Section>
              <Section label="Build" action={buildOverride && may.build ? <FollowButton label="Use workspace setting" onClick={() => setBuildOverride(null)} /> : undefined}>
                {savedBuild === undefined ? (
                  buildError ? (
                    <GroupError error={buildError} retry={() => setBuildAttempt((n) => n + 1)} />
                  ) : (
                    <PageRowsSkeleton rows={2} control="none" />
                  )
                ) : may.build ? (
                  <BuildFields value={buildOverride ?? wsBuild ?? BUILD_EMPTY} onChange={setBuildOverride} detected={detected} />
                ) : (
                  <>
                    <FieldRow label="Command">
                      <Value>{(buildOverride ?? wsBuild)?.command || detected?.command || "None"}</Value>
                    </FieldRow>
                    <FieldRow label="What it makes">
                      <Value>{(buildOverride ?? wsBuild)?.outputs || detected?.outputs || "None"}</Value>
                    </FieldRow>
                  </>
                )}
              </Section>
            </div>
          </div>
          {/* Under the scroller, beside the foot: a failed save is never scrolled out of sight. */}
          {error ? (
            <div data-project-settings-error className="px-5 py-3">
              <ErrorLine error={error} />
            </div>
          ) : null}
          <Footer onCancel={() => void cancel()} confirmLabel="Save" pending={pending} disabled={!dirty || !!blocked || loading} note={blocked ?? (unloaded ? "Only what loaded is saved" : note)} />
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** A save that landed in part: the groups refused, each with why, then the groups that saved. */
export function partialSaveWords(saved: readonly string[], refused: readonly { name: string; why: string }[]): string {
  const list = (names: readonly string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const why = refused.map((r) => `${r.name} did not save: ${r.why.replace(/\.$/, "")}.`).join(" ");
  return saved.length ? `${why} ${list(saved)} saved.` : why;
}

export function ProjectTeardownDialog({
  project,
  action,
  onClose,
  onDone,
}: {
  project: ProjectMeta;
  action: "archive" | "delete";
  onClose: () => void;
  onDone: () => void;
}) {
  const [worktree, setWorktree] = useState(false);
  const [localBranch, setLocalBranch] = useState(false);
  const [remoteBranch, setRemoteBranch] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = action === "delete";
  const any = worktree || localBranch || remoteBranch;
  const cleanable = project.mode === "worktree" && !!project.branch;
  // A linked project: archive takes every copy (the home first, so a home out
  // of reach blocks it); delete takes this copy, the others only when asked.
  const at = useProjectHome(project);
  const blocked = deleting ? null : at.blocked;
  const others = deleting ? at.copies.filter((c) => c.environmentId !== project.environmentId) : [];
  const [also, setAlso] = useState<ReadonlySet<string>>(() => new Set());
  const { root, closeThen } = useClosingDialog(onClose, pending);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const cleanup: ProjectCleanup | undefined = any
      ? { worktree: worktree || localBranch, localBranch, remoteBranch }
      : undefined;
    try {
      if (deleting) await deleteLinked(project, [...also], cleanup);
      else await archiveLinked(project, true, cleanup);
      setPending(false);
      closeThen(onDone);
    } catch (err) {
      setError(dialogErrorWords(err));
      setPending(false);
    }
  };

  const mono = (text: string) => <code className="font-mono text-xs">{text}</code>;
  const boxes = cleanable
    ? [
        {
          key: "worktree",
          label: "Remove the worktree folder",
          checked: worktree || localBranch,
          disabled: localBranch,
          set: setWorktree,
        },
        {
          key: "local",
          label: <>Delete branch {mono(project.branch ?? "")}</>,
          checked: localBranch,
          set: setLocalBranch,
        },
        {
          key: "remote",
          label: <>Delete {mono(`origin/${project.branch ?? ""}`)}</>,
          checked: remoteBranch,
          set: setRemoteBranch,
        },
      ]
    : [];
  const copyBoxes = others.map((copy) => ({
    key: `copy:${copy.environmentId}:${copy.id}`,
    label: `Also delete the copy on ${liveHostFacts.nameOf(copy.environmentId)}`,
    checked: also.has(copy.id),
    disabled: !liveHostFacts.isOpen(copy.environmentId),
    set: (on: boolean) =>
      setAlso((prev) => {
        const next = new Set(prev);
        if (on) next.add(copy.id);
        else next.delete(copy.id);
        return next;
      }),
  }));
  const rows = [...boxes, ...copyBoxes];
  const checks = rows.length ? (
    <div className="flex flex-col">
      {rows.map((b) => (
        <CheckRow key={b.key} label={b.label} checked={b.checked} disabled={b.disabled} onCheckedChange={b.set} />
      ))}
    </div>
  ) : null;

  // Deleting with nothing to decide is a confirm: one title, one line, Cancel
  // and the red verb. With cleanup or other copies to choose, it is a form
  // dialog like Archive's, since a confirm never holds a checkbox.
  if (deleting && !checks) {
    return (
      <ConfirmDialog
        title={`Delete ${project.name}?`}
        body="Its threads are deleted for good."
        confirmLabel="Delete project"
        danger
        onCancel={onClose}
        onConfirm={async () => {
          await deleteLinked(project, [], undefined);
        }}
        onDone={onDone}
      />
    );
  }

  return (
    <Dialog {...root}>
      <ModalPanel
        onClose={onClose}
        busy={pending}
        title={deleting ? `Delete ${project.name}?` : `Archive ${project.name}?`}
        description={deleting ? "Its threads are deleted for good." : "Its threads stay; restore it anytime."}
        size="sm"
      >
        {checks || error ? (
          <ModalBody>
            {checks}
            <ErrorLine error={error} />
          </ModalBody>
        ) : null}
        <Footer
          onCancel={() => closeThen(onClose)}
          onConfirm={() => void confirm()}
          confirmLabel={deleting ? "Delete project" : "Archive"}
          danger={deleting || any}
          pending={pending}
          disabled={!!blocked}
          note={blocked ?? undefined}
        />
      </ModalPanel>
    </Dialog>
  );
}

export { AccountPinFields, ConfirmDialog, projectInheritLabel };
