import { DEFAULT_START_ON, type StartOn } from "@server/shared/defaults";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { registry } from "../lib/connection";
import { useEnvironments } from "../lib/connection/status";
import { ACCESS_LABEL, ACCESS_LINE, ACCESS_ORDER, FULL_ACCESS_CONFIRM } from "../lib/settings/access";
import { settingTitle } from "../lib/settings/map";
import { useLinkMay } from "../lib/linkMay";
import { homeEnvironmentId, usePublishHome } from "../lib/settings/pageHome";
import { homeNote } from "../lib/settingsHome";
import { nameInLine } from "../lib/hostWords";
import { EFFORT_LABELS, effortLadder, modelForDefaults, modelOptions, normalizeDefaults, parseDefaultsScope, providerOptions, storedModelId, type DefaultsScope } from "../lib/tcserver/defaults";
import { scopeKey, useThreadDefaults, useThreadDefaultsError, useWorkspaceCatalog, workspaceStore } from "../lib/tcserver/workspaces";
import type { ThreadDefaults, WorkspaceMeta } from "../lib/tcserver/types";
import { ChoiceSelect } from "../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../components/page";
import { Button } from "../components/ui/button";
import { SettingRow, SettingSection } from "../surfaces/settings/parts/SettingRow";
import { SaveMark } from "../surfaces/settings/parts/SaveMark";
import { ValueWords } from "../surfaces/settings/parts/ValueWords";
import { ManagedLine } from "../surfaces/settings/parts/ManagedLine";
import { useComputerName } from "../lib/settings/computerName";
import { FailureLinesHere, FailuresSaidOnce, ReadFailure } from "../surfaces/settings/parts/ReadFailure";
import { readWhenOpen, withDeadline } from "../lib/connection/openRead";
import { Skeleton } from "../components/ui/skeleton";
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
  // A key that may read the set but not change it sees each value as words (`DefaultsRows`), and no Use….
  const may = useLinkMay(environmentId, "defaults.set", { workspaceId, defaults: null });
  const write = (row: Row, next: ThreadDefaults) =>
    draft.change(saved[row], normalizeDefaults(next, environmentId), (set) => workspaceStore.saveDefaults(environmentId, workspaceId, set));
  /** Drops the scope's own set: a workspace follows New threads again, New threads takes Docket's. */
  const clear = () => cleared.run(() => workspaceStore.saveDefaults(environmentId, workspaceId, null));
  return { scope, failure, value: draft.value, saved, write, blocked, clear, cleared, may };
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
  const model = storedModelId(value);
  const modelChoices = [{ value: "", label: "Default" }, ...modelOptions(value.provider, environmentId)];
  // What each row says for a key that may not change it: the value's own label, as the select would show it.
  const words: Record<Row, string> = {
    app: providerOptions().find((p) => p.value === value.provider)?.label ?? value.provider,
    model: modelChoices.find((m) => m.value === model)?.label ?? model,
    effort: EFFORT_LABELS[value.reasoning],
    access: ACCESS_LABEL[value.permission],
    startOn: START_ON_CHOICES.find((c) => c.value === (value.startOn ?? DEFAULT_START_ON))?.label ?? "",
  };
  const row = (id: Row, mapId: string, title: string, select: ReactNode, description?: string) => {
    const control = set.may ? select : <ValueWords>{words[id]}</ValueWords>;
    return layout === "setting" ? (
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
  };
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
          value={model}
          options={modelChoices}
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
          {set.scope?.overridden && !set.blocked && set.may ? (
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
          <UseNewThreadsPress reset={reset} saved={set.cleared} disabled={set.blocked} variant="ghost" />
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

/**
 * "Different in N places": the jobs and workspaces that keep a set of their own, opening a dialog of them. A place
 * whose set has not been read yet holds the row in its shape; one whose computer did not answer leaves the count a
 * floor ("at least"), the places named, and its computer's failure at the page's head with Retry.
 */
function DifferentPlaces() {
  const { workspaces, defaults, defaultsErrors } = useWorkspaceCatalog();
  const [open, setOpen] = useState(false);
  const keyOf = (w: WorkspaceMeta) => scopeKey(w.environmentId, w.id);
  const own = workspaces.filter((w) => defaults.get(keyOf(w))?.overridden).sort((a, b) => a.name.localeCompare(b.name));
  const unheard = workspaces.filter((w) => !defaults.has(keyOf(w)));
  const failed = unheard.filter((w) => defaultsErrors.has(keyOf(w)));
  const waiting = unheard.length > failed.length;
  // A place listed after the catalog's own reads (a workspace push) has its set asked for here, once, under the
  // store's deadline: the row never waits on an answer nobody asked for.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const w of unheard) {
      const key = keyOf(w);
      if (defaultsErrors.has(key) || asked.current.has(key)) continue;
      asked.current.add(key);
      void workspaceStore.loadDefaults(w.environmentId, w.id);
    }
  });
  const n = failed.length ? `at least ${own.length}` : own.length;
  const line = [own.length ? own.map((w) => w.name).join(", ") : null, failed.length ? `Not heard from ${failed.map((w) => w.name).join(", ")}` : null].filter(Boolean).join(". ");
  return (
    <>
      {waiting ? (
        // Still reading: the row's shape, never a count it does not have.
        <PageRowsSkeleton rows={[{ description: true, control: "none" }]} />
      ) : (
        <>
          {failed.map((w) => (
            <ReadFailure key={keyOf(w)} computer={w.environmentId} error={defaultsErrors.get(keyOf(w)) ?? ""} retry={() => workspaceStore.loadDefaults(w.environmentId, w.id)} />
          ))}
          {own.length || failed.length ? (
            <SettingRow
              id="defaults.different"
              vars={{ n }}
              description={line}
              onOpen={own.length ? () => setOpen(true) : undefined}
              openLabel={own.length ? settingTitle("defaults.different", { n }) : undefined}
            />
          ) : null}
        </>
      )}
      {/* The dialog keeps the places it opened with, so one he sets back stays in the list, saying so, and it stays
          open, in one place in the tree, while that place is read again. */}
      {open ? <DifferentPlacesDialog places={own} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Each job and workspace with its own set, what it starts with, and Use New threads beside it. */
function DifferentPlacesDialog({ places, onClose }: { places: readonly WorkspaceMeta[]; onClose: () => void }) {
  const [shown] = useState(places);
  return (
    <Modal title="Different from New threads" size="sm" onClose={onClose}>
      {/* The dialog's own failures, said in it under its title, so a Retry is never behind it. */}
      <FailuresSaidOnce head={false}>
        <ModalBody className="@container/places gap-0">
          <FailureLinesHere />
          {shown.map((place) => (
            <OwnSetRow key={`${place.environmentId}|${place.id}`} place={place} />
          ))}
        </ModalBody>
        <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={onClose} />
      </FailuresSaidOnce>
    </Modal>
  );
}

/** Under 22rem of dialog the row wraps: the words take the whole line and the press goes under them. */
const PLACE_ROW = "@max-[22rem]/places:flex-wrap @max-[22rem]/places:[&>[data-slot=item-content]]:basis-full";

function OwnSetRow({ place }: { place: WorkspaceMeta }) {
  const scope = useThreadDefaults(place.environmentId, place.id);
  const failure = useThreadDefaultsError(place.environmentId, place.id);
  const saved = useSaved();
  const { blocked } = homeNote(scope?.home);
  const own = scope?.overridden === true;
  const reset = useUseNewThreads(place);
  // Once cleared, the place says only what its computer answered: nothing while it reads, its failure with Retry.
  const words = !scope ? undefined : own ? summary(scope.defaults, place.environmentId) : "Same as New threads";
  return (
    // A page row, so the set's words wrap whole at any width ("Full access" is never cut). The press sits beside, or
    // under the words in a narrow dialog, so a place's name and set keep their lines.
    <PageRow title={place.name} description={words} error={saved.error ?? undefined} className={PLACE_ROW}>
      {failure ? <ReadFailure computer={place.environmentId} error={failure.error} retry={failure.retry} /> : null}
      <SaveMark state={saved.state} />
      {own && reset.may ? <UseNewThreadsPress reset={reset} saved={saved} disabled={blocked} variant="outline" /> : null}
    </PageRow>
  );
}

/**
 * Use New threads, once the set it would bring is read: a button-shaped bone while the inherited set is out, its
 * computer's failure (with Retry) when it could not be read, the press once it is known.
 */
function UseNewThreadsPress({ reset, saved, disabled, variant }: { reset: ReturnType<typeof useUseNewThreads>; saved: Saved; disabled?: boolean; variant: "outline" | "ghost" }) {
  if (reset.failure) return <ReadFailure computer={reset.environmentId} error={reset.failure.error} retry={reset.failure.retry} />;
  if (!reset.inherited) return <Skeleton data-skeleton-control className="h-7 w-32 shrink-0 rounded-md" />;
  return (
    <Button variant={variant} size="sm" disabled={disabled || saved.state === "saving" || saved.state === "slow"} onClick={() => void reset.run(saved)}>
      Use New threads
    </Button>
  );
}

/** The set a place would follow, and the keeper's name when the store named one this window cannot match to exactly
 *  one linked computer (so the set came from a follower's copy, not the keeper). */
type InheritedRead = { scope: DefaultsScope; unverified: string | null };

/** Why a read failed, in its own words. */
const failureOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Use New threads for one place: offered only to a key that may write that place's set (`defaults.set`), and acting
 * only on a current answer. It reads the set the place would follow afresh as it opens (never a cached one: `inherited`
 * stays null until that read answers, `failure` says it could not, with Retry), reads it again at the press, and asks
 * first whenever that answer starts threads with Full access, naming the Access the place has today. A keeper it
 * cannot match to one linked computer leaves the answer unknown, so it asks first then too. After the clear the store
 * reads the place again and holds no guess meanwhile (`saveDefaults`): every summary of it waits, then says the set
 * that came back, or the read's failure with Retry.
 */
export function useUseNewThreads(place: Pick<WorkspaceMeta, "id" | "environmentId" | "name">) {
  const may = useLinkMay(place.environmentId, "defaults.set", { workspaceId: place.id, defaults: null });
  const [fresh, setFresh] = useState<{ read: InheritedRead | null; error: string | null }>({ read: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const environmentId = place.environmentId;
  const read = useCallback(async (): Promise<InheritedRead> => {
    const ask = (id: string) => withDeadline(readWhenOpen<unknown>(registry.linkOf(id), "defaults.get", { workspaceId: null })).then(parseDefaultsScope);
    const here = await ask(environmentId);
    // No home: this computer keeps the set itself.
    if (!here.home) return { scope: here, unverified: null };
    // A follower answers with its copy; the computer that keeps the set (the box, its `home`) is asked for its own.
    const keeper = homeEnvironmentId(here.home, registry.environments());
    if (!keeper) return { scope: here, unverified: here.home.name };
    if (keeper === environmentId) return { scope: here, unverified: null };
    const kept = await ask(keeper);
    return { scope: { ...kept, home: here.home }, unverified: null };
  }, [environmentId]);
  useEffect(() => {
    let live = true;
    setFresh({ read: null, error: null });
    read().then(
      (answer) => live && setFresh({ read: answer, error: null }),
      (err: unknown) => live && setFresh({ read: null, error: failureOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [read, attempt]);
  const run = async (saved: Saved): Promise<boolean> => {
    // The answer in hand at the press: asked again, so a change made meanwhile cannot skip the Full access check.
    let now: InheritedRead;
    try {
      now = await read();
      setFresh({ read: now, error: null });
    } catch (err) {
      setFresh({ read: null, error: failureOf(err) });
      return false;
    }
    const own = workspaceStore.defaultsAt(place.environmentId, place.id);
    const today = own?.overridden ? ACCESS_LABEL[own.defaults.permission] : null;
    const todayWords = today ? ` Today they start with ${today}.` : "";
    if (now.unverified) {
      // The keeper cannot be asked, so the set it keeps is not known: asked first as if it were Full access.
      const ok = await confirmAction({
        title: `Use New threads for ${place.name}`,
        body: `New threads are kept on ${nameInLine(now.unverified)}, which this window cannot ask, so its new threads may start with Full access and ask before nothing. Sends, posts and payments still wait.${todayWords}`,
        action: "Use New threads",
      });
      if (!ok) return false;
    } else if (now.scope.defaults.permission === "auto") {
      const ok = await confirmAction({
        title: `Give ${place.name} Full access`,
        body: `Its new threads then start with Full access, as New threads do, and ask before nothing. Sends, posts and payments still wait.${todayWords}`,
        action: "Use New threads",
      });
      if (!ok) return false;
    }
    return saved.run(() => workspaceStore.saveDefaults(place.environmentId, place.id, null));
  };
  return {
    may,
    inherited: fresh.read?.scope ?? null,
    failure: fresh.error === null ? null : { error: fresh.error, retry: () => setAttempt((n) => n + 1) },
    environmentId,
    run,
  };
}

/**
 * A job's or a workspace's own start set, the one editor of it: the rows save as they change, as New threads' do,
 * and Use New threads drops the set so the place follows New threads again. Opened from the rail's item, the job
 * and workspace pages and the Work page. Its props stay `workspace` and `onClose`.
 */
export function ThreadDefaultsDialog({ workspace, onClose }: { workspace: WorkspaceMeta; onClose: () => void }) {
  const set = useDefaultsSet(workspace.environmentId, workspace.id);
  const reset = useUseNewThreads(workspace);
  const computer = useComputerName(workspace.environmentId);
  return (
    <Modal title="New threads" description={workspace.name} size="sm" onClose={onClose}>
      {/* The dialog's own failures, said in it under its title, so a Retry is never behind it. */}
      <FailuresSaidOnce head={false}>
      <ModalBody className="gap-0">
        <FailureLinesHere />
        {/* Who can change the set is said first, above its rows. */}
        {set.value && !set.may ? <ManagedLine computer={set.scope?.home?.name ?? computer.name} /> : null}
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
          set.scope?.overridden && reset.may ? <UseNewThreadsPress reset={reset} saved={set.cleared} disabled={set.blocked} variant="ghost" /> : null
        }
        note={set.scope && !set.scope.overridden ? "Same as New threads" : undefined}
        confirmLabel="Done"
        closeOnConfirm
        onConfirm={onClose}
      />
      </FailuresSaidOnce>
    </Modal>
  );
}
