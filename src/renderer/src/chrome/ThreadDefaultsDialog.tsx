import { DEFAULT_START_ON, type StartOn } from "@server/shared/defaults";
import { useState, type ReactNode } from "react";
import { registry } from "../lib/connection";
import { useEnvironments } from "../lib/connection/status";
import { ACCESS_LABEL, ACCESS_LINE, ACCESS_ORDER, FULL_ACCESS_CONFIRM } from "../lib/settings/access";
import { settingTitle } from "../lib/settings/map";
import { useLinkMay } from "../lib/linkMay";
import { usePublishHome } from "../lib/settings/pageHome";
import { homeNote } from "../lib/settingsHome";
import { BUILT_IN_SCOPE, EFFORT_LABELS, effortLadder, modelForDefaults, modelOptions, normalizeDefaults, providerOptions, storedModelId } from "../lib/tcserver/defaults";
import { scopeKey, useThreadDefaults, useThreadDefaultsError, useWorkspaceCatalog, workspaceStore } from "../lib/tcserver/workspaces";
import type { ThreadDefaults, WorkspaceMeta } from "../lib/tcserver/types";
import { ChoiceSelect } from "../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { SettingRow, SettingSection } from "../surfaces/settings/parts/SettingRow";
import { SaveMark } from "../surfaces/settings/parts/SaveMark";
import { ReadFailure } from "../surfaces/settings/parts/ReadFailure";
import { useDraft } from "../surfaces/settings/parts/useDraft";
import { useSaved, type Saved } from "../surfaces/settings/parts/useSaved";
import { confirmAction, DialogFooter } from "./ConfirmDialog";
import { FieldRow } from "./DialogField";
import { Modal, ModalBody } from "./Modal";

/**
 * What a new thread starts with (docs/agents/settings.md "The pages: Everywhere"): agent app, model, effort and
 * access. One set on the box for every new thread (`defaults.set` with no workspace), and a job's or a workspace's own
 * set over it, which only its dialog edits (`ThreadDefaultsDialog`). Every change saves at once, with its row's mark;
 * a refusal puts back the set the computer last confirmed. While the box that keeps the set is out of reach the
 * controls are held.
 */

type Row = "app" | "model" | "effort" | "access" | "startOn";

/** "Linked projects start on": which copy of a project kept on two computers a new thread starts on. */
const START_ON_CHOICES: { value: StartOn; label: string }[] = [
  { value: "box", label: "The box" },
  { value: "mac", label: "The Mac" },
];

/** One scope's set as an editor holds it: what the computer confirmed, what is shown, each row's save. */
function useDefaultsSet(environmentId: string, workspaceId: string | null) {
  const scope = useThreadDefaults(environmentId, workspaceId, true);
  const failure = useThreadDefaultsError(environmentId, workspaceId);
  const draft = useDraft(scope?.defaults);
  const saved: Record<Row, Saved> = { app: useSaved(), model: useSaved(), effort: useSaved(), access: useSaved(), startOn: useSaved() };
  const cleared = useSaved();
  const { blocked } = homeNote(scope?.home);
  const write = (row: Row, next: ThreadDefaults) =>
    draft.change(saved[row], normalizeDefaults(next, environmentId), (set) => workspaceStore.saveDefaults(environmentId, workspaceId, set));
  /** Drops the scope's own set: a workspace follows New threads again, New threads takes Docket's. */
  const clear = () => cleared.run(() => workspaceStore.saveDefaults(environmentId, workspaceId, null));
  return { scope, failure, value: draft.value, saved, write, blocked, clear, cleared };
}
type DefaultsSet = ReturnType<typeof useDefaultsSet>;

/** The set's rows: on the New threads page each is its map row, in a dialog a field row. Effort only for a model
 *  with a ladder; Linked projects start on only on the one set, with two or more computers. */
function DefaultsRows({ set, environmentId, startOn, layout }: { set: DefaultsSet; environmentId: string; startOn: boolean; layout: "setting" | "page" | "dialog" }) {
  const value = set.value!;
  const ladder = effortLadder(modelForDefaults(value, environmentId));
  const disabled = set.blocked;
  const size = layout === "dialog" ? "sm" : undefined;
  const pickAccess = async (permission: ThreadDefaults["permission"]) => {
    // Full access as the start of every new thread widens what they do unasked: it asks first.
    if (permission === "auto" && value.permission !== "auto" && !(await confirmAction(FULL_ACCESS_CONFIRM))) return;
    void set.write("access", { ...value, permission });
  };
  const row = (id: Row, mapId: string, title: string, control: ReactNode, description?: string) =>
    layout === "setting" ? (
      <SettingRow key={id} id={mapId} saved={set.saved[id]} description={description}>
        {control}
      </SettingRow>
    ) : layout === "page" ? (
      <PageRow key={id} title={title} description={description} error={set.saved[id].error}>
        <SaveMark state={set.saved[id].state} />
        {control}
      </PageRow>
    ) : (
      <FieldRow key={id} label={title} description={description} error={set.saved[id].error}>
        <span className="flex items-center gap-2">
          <SaveMark state={set.saved[id].state} />
          {control}
        </span>
      </FieldRow>
    );
  return (
    <>
      {row(
        "app",
        "defaults.app",
        "Agent app",
        <ChoiceSelect label="Agent app" size={size} disabled={disabled} value={value.provider} options={providerOptions()} onChange={(provider) => void set.write("app", { ...value, provider, model: "" })} />,
      )}
      {row(
        "model",
        "defaults.model",
        "Model",
        <ChoiceSelect
          label="Model"
          // "Default" is a choice, not an empty field: it reads in the value's tone.
          className="data-placeholder:text-foreground"
          size={size}
          disabled={disabled}
          value={storedModelId(value)}
          options={[{ value: "", label: "Default" }, ...modelOptions(value.provider, environmentId)]}
          onChange={(model) => void set.write("model", { ...value, model })}
        />,
      )}
      {ladder.length > 1
        ? row(
            "effort",
            "defaults.effort",
            "Effort",
            <ChoiceSelect
              label="Effort"
              size={size}
              disabled={disabled}
              value={value.reasoning}
              options={ladder.map((level) => ({ value: level, label: EFFORT_LABELS[level] }))}
              onChange={(reasoning) => void set.write("effort", { ...value, reasoning })}
            />,
          )
        : null}
      {row(
        "access",
        "defaults.access",
        "Access",
        <ChoiceSelect
          label="Access"
          size={size}
          disabled={disabled}
          value={value.permission}
          options={ACCESS_ORDER.map((p) => ({ value: p, label: ACCESS_LABEL[p] }))}
          onChange={(permission) => void pickAccess(permission)}
        />,
        ACCESS_LINE[value.permission],
      )}
      {startOn
        ? row(
            "startOn",
            "defaults.startOn",
            "Linked projects start on",
            <ChoiceSelect
              label="Linked projects start on"
              size={size}
              disabled={disabled}
              value={value.startOn ?? DEFAULT_START_ON}
              options={START_ON_CHOICES}
              onChange={(next) => void set.write("startOn", { ...value, startOn: next })}
            />,
          )
        : null}
    </>
  );
}

/** The five rows in their shape while the set loads. */
const DEFAULTS_SKELETON = [{}, {}, {}, { description: true }];

/**
 * A scope's set on a page: `null` is New threads' "Start with" section; a workspace id is that workspace's own set
 * (its page's "New threads" section, until the job and workspace pages open `ThreadDefaultsDialog` instead).
 */
export function ThreadDefaultsEditor({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useWorkspaceCatalog().workspaces.find((w) => w.id === workspaceId);
  // The one set is asked of this window's own computer, which forwards it to the box.
  const environmentId = workspaceId === null ? registry.primary().environmentId : workspace?.environmentId;
  if (!environmentId) return <PageRowsSkeleton rows={DEFAULTS_SKELETON} />;
  return workspaceId === null ? <StartWith key={environmentId} environmentId={environmentId} /> : <WorkspaceSet key={environmentId} environmentId={environmentId} workspaceId={workspaceId} />;
}

/** Docket's own start set, said as its row says it. */
const DOCKETS = "Claude Code, its default model, Medium effort, Auto-accept edits";

/**
 * "Start with": the one set. `alsoRetry` is the page's other read (Builds from plans) when it failed too: the page
 * then says the failure once, here, and its Retry asks both.
 */
function StartWith({ environmentId }: { environmentId: string }) {
  const set = useDefaultsSet(environmentId, null);
  usePublishHome("defaults", set.scope ? (set.scope.home ?? null) : undefined);
  // Which copy of a linked project a thread starts on is a question only with two computers.
  const startOn = useEnvironments().length > 1;
  const reset = async () => {
    const ok = await confirmAction({
      title: "Use Docket's defaults",
      body: `The set saved for every computer is cleared. New threads start with ${DOCKETS}.`,
      action: "Use Docket's defaults",
    });
    if (ok) void set.clear();
  };
  // A failed read is the page's one line, alone at its head: no heading over it, nothing under it.
  if (!set.value && set.failure) return <ReadFailure computer={environmentId} error={set.failure.error} retry={set.failure.retry} />;
  return (
    <SettingSection of="defaults.app">
      {set.value ? (
        <>
          <DefaultsRows set={set} environmentId={environmentId} startOn={startOn} layout="setting" />
          <DifferentPlaces />
          {/* Asks first, so last in its section; offered only while there is a set to clear and the box can take it. */}
          {set.scope?.overridden && !set.blocked ? (
            <SettingRow id="defaults.reset" description={DOCKETS} saved={set.cleared}>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void reset()}>
                Use…
              </Button>
            </SettingRow>
          ) : null}
        </>
      ) : set.failure ? (
        // Said once a page: Builds from plans' failure, the same computer's, draws nothing and this Retry asks it too.
        <ReadFailure computer={environmentId} error={set.failure.error} retry={set.failure.retry} />
      ) : (
        <PageRowsSkeleton rows={startOn ? [...DEFAULTS_SKELETON, {}] : DEFAULTS_SKELETON} />
      )}
    </SettingSection>
  );
}

/** A workspace's own set on its page: the same rows as plain page rows (the map's are the one set's alone), and Use
 *  New threads while it keeps one. */
function WorkspaceSet({ environmentId, workspaceId }: { environmentId: string; workspaceId: string }) {
  const set = useDefaultsSet(environmentId, workspaceId);
  const workspace = useWorkspaceCatalog().workspaces.find((w) => w.id === workspaceId && w.environmentId === environmentId);
  const reset = useUseNewThreads({ id: workspaceId, environmentId, name: workspace?.name ?? "This workspace" });
  return (
    <PageSection
      title="New threads"
      action={
        set.scope?.overridden && reset.may ? (
          <Button variant="ghost" size="sm" disabled={set.blocked} onClick={() => void reset.run(set.cleared)}>
            Use New threads
          </Button>
        ) : null
      }
    >
      {set.value ? (
        <DefaultsRows set={set} environmentId={environmentId} startOn={false} layout="page" />
      ) : set.failure ? (
        <ReadFailure computer={environmentId} error={set.failure.error} retry={set.failure.retry} />
      ) : (
        <PageRowsSkeleton rows={DEFAULTS_SKELETON} />
      )}
      {set.cleared.error ? <PageError>{set.cleared.error}</PageError> : null}
    </PageSection>
  );
}


/** A set in one comma sentence: "Opus 5.5, High, Full access" (the model names its app). */
export function summary(value: ThreadDefaults, environmentId?: string): string {
  const model = modelForDefaults(value, environmentId);
  const effort = effortLadder(model).length > 1 ? EFFORT_LABELS[value.reasoning] : null;
  return [model.name, effort, ACCESS_LABEL[value.permission]].filter(Boolean).join(", ");
}

/** "Different in N places": the jobs and workspaces that keep a set of their own, opening a dialog of them. */
function DifferentPlaces() {
  const { workspaces, defaults } = useWorkspaceCatalog();
  const [open, setOpen] = useState(false);
  const own = workspaces.filter((w) => defaults.get(scopeKey(w.environmentId, w.id))?.overridden).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {own.length ? (
        <SettingRow id="defaults.different" vars={{ n: own.length }} description={own.map((w) => w.name).join(", ")} onOpen={() => setOpen(true)} openLabel={settingTitle("defaults.different", { n: own.length })} />
      ) : null}
      {/* The dialog keeps the places it opened with, so one he sets back stays in the list, saying so. */}
      {open ? <DifferentPlacesDialog places={own} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Each job and workspace with its own set, what it starts with, and Use New threads beside it. */
function DifferentPlacesDialog({ places, onClose }: { places: readonly WorkspaceMeta[]; onClose: () => void }) {
  const [shown] = useState(places);
  return (
    <Modal title="Different from New threads" size="sm" onClose={onClose}>
      <ModalBody className="gap-0">
        {shown.map((place) => (
          <OwnSetRow key={`${place.environmentId}|${place.id}`} place={place} />
        ))}
      </ModalBody>
      <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={onClose} />
    </Modal>
  );
}

function OwnSetRow({ place }: { place: WorkspaceMeta }) {
  const scope = useThreadDefaults(place.environmentId, place.id);
  const saved = useSaved();
  const { blocked } = homeNote(scope?.home);
  const own = scope?.overridden === true;
  const reset = useUseNewThreads(place);
  return (
    // A page row, so the set's words wrap whole at any width ("Full access" is never cut), and the press sits beside.
    <PageRow title={place.name} description={scope ? (own ? summary(scope.defaults, place.environmentId) : "Same as New threads") : undefined} error={saved.error ?? undefined}>
      <SaveMark state={saved.state} />
      {own && reset.may ? (
        <Button variant="outline" size="sm" disabled={blocked || saved.state === "saving" || saved.state === "slow"} onClick={() => void reset.run(saved)}>
          Use New threads
        </Button>
      ) : null}
    </PageRow>
  );
}

/**
 * Use New threads for one place: offered only to a key that may write that place's set (`defaults.set`), and asking
 * first when the place would start its threads with Full access it does not have now, naming the Access it inherits.
 */
export function useUseNewThreads(place: Pick<WorkspaceMeta, "id" | "environmentId" | "name">) {
  const may = useLinkMay(place.environmentId, "defaults.set", { workspaceId: place.id, defaults: null });
  const run = async (saved: Saved): Promise<boolean> => {
    const own = workspaceStore.defaultsAt(place.environmentId, place.id);
    const inherited = workspaceStore.defaultsAt(place.environmentId, null)?.defaults ?? BUILT_IN_SCOPE.defaults;
    if (own?.overridden && own.defaults.permission !== "auto" && inherited.permission === "auto") {
      const ok = await confirmAction({
        title: `Give ${place.name} Full access`,
        body: `Its new threads then start with Full access, as New threads do, and ask before nothing. Sends, posts and payments still wait. Today they start with ${ACCESS_LABEL[own.defaults.permission]}.`,
        action: "Use New threads",
      });
      if (!ok) return false;
    }
    return saved.run(() => workspaceStore.saveDefaults(place.environmentId, place.id, null));
  };
  return { may, run };
}

/**
 * A job's or a workspace's own start set, the one editor of it: the rows save as they change, as New threads' do,
 * and Use New threads drops the set so the place follows New threads again. Opened from the rail's item, the job
 * and workspace pages and the Work page. Its props stay `workspace` and `onClose`.
 */
export function ThreadDefaultsDialog({ workspace, onClose }: { workspace: WorkspaceMeta; onClose: () => void }) {
  const set = useDefaultsSet(workspace.environmentId, workspace.id);
  const reset = useUseNewThreads(workspace);
  return (
    <Modal title="New threads" description={workspace.name} size="sm" onClose={onClose}>
      <ModalBody className="gap-0">
        {set.value ? (
          <DefaultsRows set={set} environmentId={workspace.environmentId} startOn={false} layout="dialog" />
        ) : set.failure ? (
          <ReadFailure computer={workspace.environmentId} error={set.failure.error} retry={set.failure.retry} />
        ) : (
          <PageRowsSkeleton rows={DEFAULTS_SKELETON} />
        )}
        {set.cleared.error ? <PageError>{set.cleared.error}</PageError> : null}
      </ModalBody>
      <DialogFooter
        start={
          set.scope?.overridden && reset.may ? (
            <Button variant="ghost" disabled={set.blocked} onClick={() => void reset.run(set.cleared)}>
              Use New threads
            </Button>
          ) : null
        }
        note={set.scope && !set.scope.overridden ? "Same as New threads" : undefined}
        confirmLabel="Done"
        closeOnConfirm
        onConfirm={onClose}
      />
    </Modal>
  );
}
