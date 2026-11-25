import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight } from "../../chrome/icons";
import { makeFunctionReference } from "convex/server";
import type { SectorKey } from "@shared/work";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import { wordCount } from "@server/shared/preamble";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { Input } from "@renderer/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@renderer/components/ui/sheet";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "@renderer/components/ui/collapsible";
import { ChoiceSelect } from "../../components/choice-select";
import { ConfirmDialog, DialogFooter as Footer, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { useClosingDialog } from "../../chrome/Modal";
import { AccountPinFields, projectInheritLabel } from "../../chrome/AccountPinFields";
import { renameProject, setProjectAccounts } from "../../lib/tcserver/projects";
import { useLinkMay } from "../../lib/linkMay";
import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { workErrorWords } from "../../lib/workErrorWords";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { useProjects } from "../../lib/tcserver/workspaces";
import { useAccounts } from "../../stores/accounts";
import { dialogsChunk } from "../../surfaces/chunks";
import { ProjectShare } from "../guests/Share";
import { cn } from "../../lib/cn";
import { lifeosHostName, reopenLifeos, sessionWaits, sessionWords, useLifeosQuery, useLifeosSession } from "./lifeos";
import { useHostLive } from "./lifeosLive";
import { connectingWords } from "./lifeosWords";
import { downAction, downOf, useDownPress } from "./lifeosDown";
import { SignInFor } from "./DownSignIn";

// The rules dialog rides the dialogs chunk, as it does for a code project: asked for at the press on Edit.
const PreambleDialog = dialogsChunk.surface("PreambleDialog");

/**
 * A Work project's settings (docs/agents/work.md "A Work project's
 * settings"): its name and state, which are LifeOS's and are written there;
 * the rules its threads open with and the accounts they use, which are this
 * host's; and Delete, which deletes the project in LifeOS and leaves its
 * tasks. Nothing of code is drawn: no folder, branch, completed turn,
 * review, plans or build. The server refuses those for a Work project
 * (workProjectGate.ts), so this sheet is not the only thing keeping them out.
 */

export const PROJECT_STATES = [
  { value: "backlog", label: "Backlog" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number]["value"];

type LifeosProject = { _id: string; name: string; status: ProjectState; targetDate?: number | null };

/** A target as the date field holds it, "YYYY-MM-DD" on his own calendar, or "" for none. */
export function targetDay(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The date field's day as LifeOS keeps a target: the start of that day here. "" is no target. */
export function targetMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

/** Whether LifeOS can be read and written for the two fields it owns. */
export type LifeosReach =
  | { status: "ready" }
  /** on its way: the field holds the mirror's name and what he types; Save waits. `waits`: the host said its LifeOS is still connecting, named under the fields with no press */
  | { status: "loading"; waits?: string }
  /**
   * the two stand as plain words, never as disabled controls, and one line under them says why, with the press that can
   * help: Retry where asking again can, Sign in where LifeOS is signed out. `busy`: his Retry is out, spinning in place
   */
  | { status: "failed"; line: string; note?: string; press?: { label: string; run: () => void | Promise<void> }; busy?: boolean }
  /** a project of the workspace that mirrors nothing: its name is this host's */
  | { status: "local" };

/** Said once a Save while LifeOS is out of reach saved this host's part: what saved, and where his other words wait. */
export const KEPT_LINE = "Accounts saved. Your name, state and target changes wait here until LifeOS answers.";

const samePins = (a: AccountPins, b: AccountPins) => ROUTED_PROVIDERS.every((p) => (a[p] ?? "") === (b[p] ?? ""));

const words = (n: number) => `${n} word${n === 1 ? "" : "s"}`;

/** What the rules row says: how much is sent, or that nothing is. */
export function rulesLine(project: Pick<ProjectMeta, "preamble" | "preambleEnabled">): string {
  const count = wordCount(project.preamble ?? "");
  if (count === 0) return "None";
  return project.preambleEnabled === false ? `${words(count)}, not sent` : words(count);
}

/**
 * The sheet's fields, with no store behind them: what a preview and a test
 * draw. Name, State and Target are LifeOS's and come first; while LifeOS
 * cannot be reached they stand read-only and one line under them says why.
 * Sharing is one row that opens the Share sheet. What only shapes the
 * project's threads (its rules, its accounts) folds under Thread setup.
 */
export function WorkProjectFields({
  name,
  onName,
  state,
  onState,
  target = "",
  onTarget,
  reach,
  rules,
  onEditRules,
  accounts,
  sharing,
  setupOpen,
  onSetupOpen,
}: {
  name: string;
  onName: (name: string) => void;
  /** null until LifeOS answers */
  state: ProjectState | null;
  onState: (state: ProjectState) => void;
  /** `targetDay`'s words: "YYYY-MM-DD", or "" for none */
  target?: string;
  onTarget?: (day: string) => void;
  reach: LifeosReach;
  /** `rulesLine`'s words */
  rules: string;
  onEditRules: () => void;
  /** the account rows; left out when there is none to draw */
  accounts?: ReactNode;
  /** Share's opener; left out for a project that mirrors nothing in LifeOS */
  sharing?: ReactNode;
  /** Thread setup's fold, held by the caller so a test or a preview can draw it open */
  setupOpen?: boolean;
  onSetupOpen?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  // The row's label would name its button "Rules": the button names itself.
  const editId = useId();
  const open = setupOpen ?? ownOpen;
  const setOpen = onSetupOpen ?? setOwnOpen;
  const failed = reach.status === "failed";
  const stateLabel = PROJECT_STATES.find((s) => s.value === state)?.label;
  const targetLabel = target ? dayWords(target) : null;
  return (
    <div className="flex flex-col gap-6 px-5 pb-6">
      {failed ? (
        // Out of reach: what is known, as words. A control that cannot write is not drawn (docs/DESIGN.md).
        <div className="flex flex-col">
          <FieldRow label="Name">
            <span data-readonly-name className="min-w-0 truncate text-[13px] text-muted-foreground">
              {name}
            </span>
          </FieldRow>
          {stateLabel ? (
            <FieldRow label="State">
              <span data-readonly-state className="text-[13px] text-muted-foreground">
                {stateLabel}
              </span>
            </FieldRow>
          ) : null}
          {targetLabel ? (
            <FieldRow label="Target">
              <span data-readonly-target className="text-[13px] text-muted-foreground tabular-nums">
                {targetLabel}
              </span>
            </FieldRow>
          ) : null}
          <p data-lifeos-line className="flex items-baseline gap-2 pt-2 text-xs text-muted-foreground">
            <span className="min-w-0">
              {reach.line}
              {reach.note ? <span className="block">{reach.note}</span> : null}
            </span>
            {reach.press ? (
              <Button type="button" variant="link" size="xs" className="h-auto shrink-0 px-0 text-xs" disabled={reach.busy} onClick={reach.press.run}>
                <BusyLabel busy={!!reach.busy} label={reach.press.label} />
              </Button>
            ) : null}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => onName(e.target.value)} />
          </Field>
          {reach.status === "local" ? null : (
            <div className="-my-2 flex flex-col">
              <FieldRow label="State">
                {state && reach.status === "ready" ? (
                  <ChoiceSelect label="State" size="sm" value={state} options={PROJECT_STATES} onChange={onState} />
                ) : (
                  // The select's own box, so the row holds still when the state lands.
                  <Skeleton data-state-loading className="h-7 w-24 rounded-md" />
                )}
              </FieldRow>
              <FieldRow label="Target">
                {reach.status === "ready" ? (
                  <Input data-target-date type="date" value={target} onChange={(e) => onTarget?.(e.target.value)} className="h-7 w-36 text-[13px] tabular-nums" />
                ) : (
                  <Skeleton data-target-loading className="h-7 w-36 rounded-md" />
                )}
              </FieldRow>
            </div>
          )}
          {reach.status === "loading" && reach.waits ? (
            <p data-lifeos-waits role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 text-pretty">{reach.waits}</span>
            </p>
          ) : null}
        </div>
      )}
      {sharing ? (
        <div className="-my-2 flex flex-col">
          <FieldRow label="Sharing" description="A view-only link for one guest">
            <span data-project-sharing className="contents">
              {sharing}
            </span>
          </FieldRow>
        </div>
      ) : null}
      <Collapsible open={open} onOpenChange={setOpen} data-thread-setup>
        <CollapsibleTrigger className="group/d inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">
          Thread setup
          <ChevronRight className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col pt-2">
            <FieldRow label="Rules" description={<span data-rules-line>{rulesWhat(rules)}</span>}>
              <Button id={editId} aria-labelledby={editId} type="button" variant="secondary" size="sm" onClick={onEditRules}>
                Edit
              </Button>
            </FieldRow>
            {accounts ? (
              <div className="flex flex-col pt-2">
                <p className="pb-1 text-xs text-muted-foreground">The accounts its threads run on</p>
                {accounts}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** The rules row's line: how much there is, and what it does where it does anything. */
const rulesWhat = (rules: string): string => (rules.endsWith("not sent") ? rules : `${rules === "None" ? "None yet" : rules}. New threads here read them first.`);

const DAY_WORDS = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
/** A target day in words, "Mar 14, 2027". */
export const dayWords = (day: string): string => {
  const ms = targetMs(day);
  return ms == null ? day : DAY_WORDS.format(ms);
};

export function WorkProjectSettings({ project: opened, workspace, onClose }: { project: ProjectMeta; workspace: WorkspaceMeta; onClose: () => void }) {
  // The copy the catalog holds now: the rules dialog saves on its own, and LifeOS's rename comes back through the host.
  const projects = useProjects();
  const project = projects.find((p) => p.id === opened.id && p.environmentId === opened.environmentId) ?? opened;
  const lifeosId = project.lifeosProjectId ?? null;
  const sector = (workspace.sector ?? null) as SectorKey | null;
  const session = useLifeosSession(workspace.environmentId, sector);
  const listed = useLifeosQuery<LifeosProject[]>(session, "projects:list", sector ? { sector } : {});
  const row = lifeosId && listed.status === "ready" ? (listed.value.find((p) => p._id === lifeosId) ?? null) : null;
  // What LifeOS last said, kept through a dropped connection: the two fields then stand read-only on it.
  const [known, setKnown] = useState<LifeosProject | null>(null);
  if (row && row !== known) setKnown(row);

  // The line his Retry was pressed on: it stays, its Retry spinning, until the answer replaces it.
  const [retrying, setRetrying] = useState<Extract<LifeosReach, { status: "failed" }> | null>(null);
  const live = useHostLive(workspace.environmentId);
  const down = useDownPress(downOf(session), workspace.environmentId);
  // Sign in and Show the code open the sign-in dialog over the sheet, as its child.
  const [signingIn, setSigningIn] = useState(false);
  const reach = useMemo((): LifeosReach => {
    if (!lifeosId) return { status: "local" };
    if (row) return { status: "ready" };
    if (listed.status === "ready") return { status: "failed", line: "This project is no longer in LifeOS" };
    if (retrying) return { ...retrying, busy: true };
    // The host said its LifeOS is on its way: the wait, named, under the fields; any other wait is the State's bone alone.
    if (sessionWaits(session) && live.waits) return { status: "loading", waits: connectingWords(lifeosHostName(workspace.environmentId)) };
    if (listed.status === "loading" || sessionWaits(session)) return { status: "loading" };
    let shown: Extract<LifeosReach, { status: "failed" }>;
    const retry = () => {
      setRetrying(shown);
      void reopenLifeos(workspace.environmentId, sector)
        .catch(() => {})
        .finally(() => setRetrying(null));
    };
    if (session.client) return (shown = { status: "failed", line: listed.status === "failed" ? listed.error : sessionWords(session), press: { label: "Retry", run: retry } });
    // A session that is down says its state once, with the press `useDownPress` gives: Retry only where LifeOS or the
    // host did not answer, never for a computer the host keeps LifeOS from; Sign in or Show the code, the sign-in dialog,
    // where this window may sign the host in; Open Settings where Work is off and it may turn it on; else who can.
    const { press, elsewhere } = down;
    const action = downAction(press, retry, () => setSigningIn(true));
    return (shown = { status: "failed", line: sessionWords(session), ...(elsewhere ? { note: elsewhere } : {}), ...(action ? { press: action } : {}) });
  }, [lifeosId, row, listed, session, retrying, live.waits, workspace.environmentId, sector, down]);

  // null follows what is saved, so a rename that lands from elsewhere shows until he types.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [stateDraft, setStateDraft] = useState<ProjectState | null>(null);
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const savedName = (row ?? known)?.name ?? project.name;
  const name = nameDraft ?? savedName;
  const state = stateDraft ?? (row ?? known)?.status ?? null;
  const savedTarget = targetDay((row ?? known)?.targetDate);
  const target = targetDraft ?? savedTarget;
  // What saved on this host while LifeOS's fields waited: said under the fields until he saves the rest or leaves.
  const [keptLine, setKeptLine] = useState<string | null>(null);
  const [pins, setPins] = useState<AccountPins>(project.accountPins ?? {});
  const { snapshot } = useAccounts(project.environmentId);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingRules, setEditingRules] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { root, closeThen } = useClosingDialog(onClose, pending);

  const writable = reach.status === "ready" || reach.status === "local";
  const nameChanged = !!name.trim() && name.trim() !== savedName;
  const stateChanged = !!lifeosId && !!state && state !== (row ?? known)?.status;
  const targetChanged = !!lifeosId && target !== savedTarget;
  const nameDirty = writable && nameChanged;
  const stateDirty = reach.status === "ready" && stateChanged;
  const targetDirty = reach.status === "ready" && targetChanged;
  const pinsDirty = !samePins(pins, project.accountPins ?? {});
  const dirty = nameDirty || stateDirty || targetDirty || pinsDirty;
  // What he changed of LifeOS's that LifeOS cannot take now: kept as typed, never dropped. Save still saves this host's
  // part (the accounts) and says so; LifeOS's part waits in the fields for the next Save.
  const stranded = !writable && (nameChanged || stateChanged || targetChanged);

  const save = async () => {
    if (pending || (stranded && !pinsDirty)) return;
    // Nothing left to send: an earlier try landed after all (its answer was lost), so the sheet is done.
    if (!dirty) {
      setError(null);
      closeThen(onClose);
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (lifeosId && (nameDirty || stateDirty || targetDirty)) {
        if (!session.client) throw new Error(sessionWords(session));
        await session.client.mutation(makeFunctionReference<"mutation">("projects:update"), {
          id: lifeosId,
          patch: {
            ...(nameDirty ? { name: name.trim() } : {}),
            ...(stateDirty ? { status: state } : {}),
            ...(targetDirty ? { targetDate: targetMs(target) } : {}),
          },
        });
      } else if (nameDirty) await renameProject(project.id, name.trim());
      if (pinsDirty) await setProjectAccounts(project.id, pins);
      setPending(false);
      if (stranded) {
        // The accounts are saved here; the sheet stays, with his LifeOS words in it, until LifeOS can take them.
        setKeptLine(KEPT_LINE);
        return;
      }
      closeThen(onClose);
    } catch (err) {
      // What landed stays landed: the drafts are compared with what is saved, so Retry sends only the rest.
      const host = registry.environment(project.environmentId)?.name;
      setError(workErrorWords(err, { host: host ? nameInLine(host) : undefined, write: true }) || "The project did not save.");
      setPending(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const remove = async () => {
    if (!session.client || !lifeosId) throw new Error(sessionWords(session));
    // The host archives the mirror once LifeOS's list no longer holds the project and none of its threads works.
    await session.client.mutation(makeFunctionReference<"mutation">("projects:remove"), { id: lifeosId });
  };

  // A key that may not pin accounts (a given computer's) is not drawn the rows: the host would refuse the save.
  const mayPin = useLinkMay(project.environmentId, "project.setAccounts");
  const accountRows = mayPin && ROUTED_PROVIDERS.some((p) => snapshot.providers[p].profiles.length > 0 || !!pins[p]) ? (
    <AccountPinFields
      environmentId={project.environmentId}
      value={pins}
      onChange={setPins}
      inheritLabel={projectInheritLabel(workspace, [...snapshot.providers.claude.profiles, ...snapshot.providers.codex.profiles])}
    />
  ) : null;

  return (
    <Sheet {...root}>
      <SheetContent side="right" showCloseButton={!pending} aria-busy={pending || undefined} data-work-project-settings>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader>
            <SheetTitle>Project settings</SheetTitle>
            <SheetDescription className="min-w-0 truncate text-xs">{workspace.name}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <WorkProjectFields
              name={name}
              onName={setNameDraft}
              state={state}
              onState={setStateDraft}
              target={target}
              onTarget={setTargetDraft}
              reach={reach}
              rules={rulesLine(project)}
              onEditRules={() => setEditingRules(true)}
              accounts={accountRows}
              sharing={lifeosId ? <ProjectShare env={workspace.environmentId} project={{ id: lifeosId, name: savedName }} /> : null}
            />
          </div>
          {/* Under the scroller, beside the foot: a failed save is never scrolled out of sight. The foot's Save, still live, is its retry. */}
          {keptLine && stranded && !error ? (
            <p data-project-settings-kept role="status" className="px-5 py-3 text-xs text-muted-foreground">
              {keptLine}
            </p>
          ) : null}
          {error ? (
            <div data-project-settings-error className="px-5 py-3">
              <ErrorLine error={error} />
            </div>
          ) : null}
          <Footer
            start={
              // Drawn only while LifeOS can take it: what cannot be done is absent, never disabled.
              lifeosId && reach.status === "ready" ? (
                <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={pending} onClick={() => setDeleting(true)}>
                  Delete project
                </Button>
              ) : null
            }
            onCancel={() => closeThen(onClose)}
            confirmLabel="Save"
            pending={pending}
            // After a failed save Save stays live, as its retry: even once an earlier try is seen to have landed, when it closes the sheet.
            disabled={(!dirty && !error) || (stranded && !pinsDirty)}
          />
        </form>
        {/* Inside the sheet's own tree, so each opens over it as its child and a press in one never closes the sheet. */}
        {signingIn ? <SignInFor environmentId={workspace.environmentId} onClose={() => setSigningIn(false)} /> : null}
        {editingRules ? <PreambleDialog scope={{ kind: "project", project, workspace }} onClose={() => setEditingRules(false)} /> : null}
        {deleting ? (
          <ConfirmDialog
            title={`Delete ${savedName}?`}
            body="Its tasks stay, with no project."
            confirmLabel="Delete project"
            danger
            onCancel={() => setDeleting(false)}
            onConfirm={remove}
            onDone={() => {
              setDeleting(false);
              closeThen(onClose);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
