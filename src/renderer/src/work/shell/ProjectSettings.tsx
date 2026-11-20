import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { makeFunctionReference } from "convex/server";
import type { SectorKey } from "@shared/work";
import { ROUTED_PROVIDERS, type AccountPins } from "@server/shared/accounts";
import { wordCount } from "@server/shared/preamble";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@renderer/components/ui/sheet";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { ChoiceSelect } from "../../components/choice-select";
import { ConfirmDialog, DialogFooter as Footer, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { useClosingDialog } from "../../chrome/Modal";
import { AccountPinFields, projectInheritLabel } from "../../chrome/AccountPinFields";
import { renameProject, setProjectAccounts } from "../../lib/tcserver/projects";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { useProjects } from "../../lib/tcserver/workspaces";
import { useAccounts } from "../../stores/accounts";
import { dialogsChunk } from "../../surfaces/chunks";
import { reopenLifeos, sessionFailure, sessionWaits, useLifeosQuery, useLifeosSession } from "./lifeos";

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

type LifeosProject = { _id: string; name: string; status: ProjectState };

/** Whether LifeOS can be read and written for the two fields it owns. */
export type LifeosReach =
  | { status: "ready" }
  /** on its way: the field holds the mirror's name and what he types; Save waits */
  | { status: "loading" }
  /** the two stand as plain words, never as disabled controls, and one line under them says why, with Retry where asking again can help */
  | { status: "failed"; line: string; retry?: () => void }
  /** a project of the workspace that mirrors nothing: its name is this host's */
  | { status: "local" };

const samePins = (a: AccountPins, b: AccountPins) => ROUTED_PROVIDERS.every((p) => (a[p] ?? "") === (b[p] ?? ""));

const words = (n: number) => `${n} word${n === 1 ? "" : "s"}`;

/** What the rules row says: how much is sent, or that nothing is. */
export function rulesLine(project: Pick<ProjectMeta, "preamble" | "preambleEnabled">): string {
  const count = wordCount(project.preamble ?? "");
  if (count === 0) return "None";
  return project.preambleEnabled === false ? `${words(count)}, not sent` : words(count);
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

/**
 * The sheet's fields, with no store behind them: what a preview and a test
 * draw. Name and State are LifeOS's; while LifeOS cannot be reached they
 * stand read-only and one line under them says why.
 */
export function WorkProjectFields({
  name,
  onName,
  state,
  onState,
  reach,
  rules,
  onEditRules,
  accounts,
}: {
  name: string;
  onName: (name: string) => void;
  /** null until LifeOS answers */
  state: ProjectState | null;
  onState: (state: ProjectState) => void;
  reach: LifeosReach;
  /** `rulesLine`'s words */
  rules: string;
  onEditRules: () => void;
  /** the account rows; the section is left out when there is none to draw */
  accounts?: ReactNode;
}) {
  const failed = reach.status === "failed";
  const stateLabel = PROJECT_STATES.find((s) => s.value === state)?.label;
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
          <p data-lifeos-line className="flex items-baseline gap-2 pt-2 text-xs text-muted-foreground">
            <span className="min-w-0">{reach.line}</span>
            {reach.retry ? (
              <Button type="button" variant="link" size="xs" className="h-auto shrink-0 px-0 text-xs" onClick={reach.retry}>
                Retry
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
            <FieldRow label="State" className="-my-2">
              {state && reach.status === "ready" ? (
                <ChoiceSelect label="State" size="sm" value={state} options={PROJECT_STATES} onChange={onState} />
              ) : (
                // The select's own box, so the row holds still when the state lands.
                <Skeleton data-state-loading className="h-7 w-24 rounded-md" />
              )}
            </FieldRow>
          )}
        </div>
      )}
      <Section label="Rules for its threads">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <span data-rules-line className="min-w-0 truncate text-[13px] text-foreground">
            {rules}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={onEditRules}>
            Edit
          </Button>
        </div>
      </Section>
      {accounts ? <Section label="Accounts">{accounts}</Section> : null}
    </div>
  );
}

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

  const [retrying, setRetrying] = useState(false);
  const reach = useMemo((): LifeosReach => {
    if (!lifeosId) return { status: "local" };
    if (row) return { status: "ready" };
    if (listed.status === "ready") return { status: "failed", line: "This project is no longer in LifeOS" };
    if (listed.status === "loading" || sessionWaits(session) || retrying) return { status: "loading" };
    const retry = () => {
      setRetrying(true);
      void reopenLifeos(workspace.environmentId, sector)
        .catch(() => {})
        .finally(() => setRetrying(false));
    };
    if (session.client) return { status: "failed", line: listed.status === "failed" ? listed.error : sessionFailure(session.state), retry };
    // Asking again helps only when LifeOS did not answer. Signed out is mended in Settings, Work, and the line names the sign-in.
    if (session.state === "unreachable") return { status: "failed", line: sessionFailure(session.state), retry };
    return { status: "failed", line: session.state === "refused" ? sessionFailure(session.state) : "Sign in to LifeOS to change its name or state" };
  }, [lifeosId, row, listed, session, retrying, workspace.environmentId, sector]);

  // null follows what is saved, so a rename that lands from elsewhere shows until he types.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [stateDraft, setStateDraft] = useState<ProjectState | null>(null);
  const savedName = (row ?? known)?.name ?? project.name;
  const name = nameDraft ?? savedName;
  const state = stateDraft ?? (row ?? known)?.status ?? null;
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
  const nameDirty = writable && nameChanged;
  const stateDirty = reach.status === "ready" && stateChanged;
  const pinsDirty = !samePins(pins, project.accountPins ?? {});
  const dirty = nameDirty || stateDirty || pinsDirty;
  // A name or state he changed that LifeOS cannot take now: Save waits, so nothing he typed is dropped behind a save of the rest.
  const stranded = !writable && (nameChanged || stateChanged);

  const save = async () => {
    if (pending || stranded) return;
    // Nothing left to send: an earlier try landed after all (its answer was lost), so the sheet is done.
    if (!dirty) {
      setError(null);
      closeThen(onClose);
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (lifeosId && (nameDirty || stateDirty)) {
        if (!session.client) throw new Error(sessionFailure(session.state));
        await session.client.mutation(makeFunctionReference<"mutation">("projects:update"), {
          id: lifeosId,
          patch: { ...(nameDirty ? { name: name.trim() } : {}), ...(stateDirty ? { status: state } : {}) },
        });
      } else if (nameDirty) await renameProject(project.id, name.trim());
      if (pinsDirty) await setProjectAccounts(project.id, pins);
      setPending(false);
      closeThen(onClose);
    } catch (err) {
      // What landed stays landed: the drafts are compared with what is saved, so Retry sends only the rest.
      setError(errorText(err));
      setPending(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const remove = async () => {
    if (!session.client || !lifeosId) throw new Error(sessionFailure(session.state));
    // The host archives the mirror once LifeOS's list no longer holds the project and none of its threads works.
    await session.client.mutation(makeFunctionReference<"mutation">("projects:remove"), { id: lifeosId });
  };

  const accountRows = ROUTED_PROVIDERS.some((p) => snapshot.providers[p].profiles.length > 0 || !!pins[p]) ? (
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
              reach={reach}
              rules={rulesLine(project)}
              onEditRules={() => setEditingRules(true)}
              accounts={accountRows}
            />
          </div>
          {/* Under the scroller, beside the foot: a failed save is never scrolled out of sight. The foot's Save, still live, is its retry. */}
          {error ? (
            <div data-project-settings-error className="px-5 py-3">
              <ErrorLine error={error} />
            </div>
          ) : null}
          <Footer
            start={
              // Drawn only while LifeOS can take it: what cannot be done is absent, never disabled.
              lifeosId && reach.status === "ready" ? (
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setDeleting(true)}>
                  Delete project
                </Button>
              ) : null
            }
            onCancel={() => closeThen(onClose)}
            confirmLabel="Save"
            pending={pending}
            // After a failed save Save stays live, as its retry: even once an earlier try is seen to have landed, when it closes the sheet.
            disabled={(!dirty && !error) || stranded}
          />
        </form>
        {/* Inside the sheet's own tree, so each opens over it as its child and a press in one never closes the sheet. */}
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
