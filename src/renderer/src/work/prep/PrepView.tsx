import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { PrepDraft, PrepFileRef, PrepLine, PrepPage, PrepPerson, PrepSuggestion, PrepTask } from "@shared/contract-work-prep";
import type { ContextChip } from "@shared/work";
import { formatDue } from "work-kit/views/lib/format";
import { ArrowLeft, MoreHorizontal, X } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { defineChunk } from "../../lib/lazyChunk";
import { refusalWords } from "../../lib/settingsHome";
import { useSessionMetaValue } from "../../lib/tcserver/store";
import { openWorkView, useWorkView, workOpenPort, workViewNow } from "../../lib/workSwitch";
import { resetAgendaPlace } from "../agenda/place";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { openHeld } from "../canvas/held";
import { Lifeos } from "../icons";
import { Face } from "../mail/face";
import { faceMap, pictureOf, type FaceRow } from "../people/model";
import { sessionWaits, useLifeosQuery, type LifeosSession } from "../shell/lifeos";
import { shared, useShared } from "../tasks/store";
import { useMinute } from "../tasks/minute";
import type { WorkViewProps } from "../views/registry";
import { ViewStateLine } from "../views/ViewStateLine";
import { briefPrep, decidePrepTasks, followUpPrep, loadPrep, openWorkspaceFile, setPrepAhead, usePrep, usePrepHeld } from "./data";
import {
  addTasksLabel,
  briefIsComing,
  draftLine,
  fileWhere,
  headVerb,
  isOver,
  lastLabel,
  moreWords,
  nobodyOn,
  notesLines,
  outcomeIsComing,
  pageThread,
  personLine,
  personTrail,
  problemWords,
  shownTasks,
  suggestionLine,
  failedWords,
  taskLine,
  threadStopped,
  whenLine,
  type HeadVerb,
} from "./model";

/**
 * A meeting's page (docs/agents/work-prep.md): who is coming, the last mail
 * with each, the open tasks that touch them or the subject, the files in
 * play and what was agreed last time; then, on his press, the few things a
 * thread found worth knowing walking in, and after the meeting what came of
 * it. It is a view of the workspace with no row in the column: Agenda's
 * Prepare opens it, and its header leads back. Opening it reads facts and
 * starts nothing; nothing on it sends.
 */

const dialogs = defineChunk("work-prep-dialogs", () => import("./PrepDialogs"));
const AddPeopleDialog = dialogs.surface("AddPeopleDialog");
const NotesDialog = dialogs.surface("NotesDialog");

/** The one name of the Prepare-ahead switch, in More and in the offer. */
export const AHEAD_LABEL = "Prepare meetings each morning";

/** Suggested tasks start unticked: he ticks, then adds. Flip to start them ticked. */
export const TICKED_AT_FIRST = false;

/** What the header and the body share: the dialog that is open, and the meeting it was opened on (a dialog never follows him to another meeting's page). */
const ui = shared<{ dialog: "people" | "notes" | null; eventId: string | null }>({ dialog: null, eventId: null });
const openDialog = (dialog: "people" | "notes", eventId: string): void => ui.set({ dialog, eventId });
const closeDialog = (): void => ui.set({ dialog: null, eventId: null });

/** The meeting this workspace's page is on: the event the view was opened with. */
function useEventId(workspaceId: string): string | null {
  const open = useWorkView();
  return open?.workspaceId === workspaceId && open.view === "prep" && open.event ? open.event : null;
}

export const eventChip = (event: { id: string; title: string }): ContextChip => ({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event.id } });

const said = (err: unknown, fallback = "The host did not answer"): void => void loadToast().then((toast) => toast.error(refusalWords(err) || fallback));

/** The header's verb now: from the page, the clock, and what this window knows of the page's two threads. */
function useHeadVerb(page: PrepPage | null): HeadVerb {
  const now = useMinute();
  const brief = useSessionMetaValue(page?.briefSessionId, (meta) => meta.status);
  const follow = useSessionMetaValue(page?.followSessionId, (meta) => meta.status);
  return page ? headVerb(page, now, { brief, follow }) : null;
}

// ── The offer, once per workspace ──

const OFFER_KEY = "work.prep.aheadOffer";
const offerListeners = new Set<() => void>();
function offerSettled(workspaceId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(OFFER_KEY) ?? "[]") as unknown[]).includes(workspaceId);
  } catch {
    return false;
  }
}
/** The offer was answered (turned on, or dismissed): it is never drawn in this workspace again. */
export function settleOffer(workspaceId: string): void {
  try {
    const all = new Set(JSON.parse(localStorage.getItem(OFFER_KEY) ?? "[]") as string[]);
    all.add(workspaceId);
    localStorage.setItem(OFFER_KEY, JSON.stringify([...all]));
  } catch {
    // A window with no storage offers again next time; nothing else depends on it.
  }
  for (const listener of offerListeners) listener();
}
function useOfferSettled(workspaceId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      offerListeners.add(listener);
      return () => void offerListeners.delete(listener);
    },
    () => offerSettled(workspaceId),
  );
}

// ── The header ──

/** In place of the view's name: the way back to Agenda, then which meeting this is. */
export function Title(props: WorkViewProps) {
  const eventId = useEventId(props.workspace.id);
  const { page } = usePrepHeld(props.workspace.id, eventId);
  return <BackTitle name={page?.event.title} onBack={() => openWorkView({ workspaceId: props.workspace.id, view: "agenda" })} />;
}

/** The way back, the shape every Work screen has (docs/DESIGN.md "Project screens"): a 24px arrow, where it goes, then where he is, muted. */
export function BackTitle({ name, onBack }: { name: string | undefined; onBack: () => void }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Back to Agenda" className="-ms-1.5 shrink-0 text-muted-foreground" onClick={onBack}>
        <ArrowLeft />
      </Button>
      <span className="shrink-0">Agenda</span>
      {name ? <span className="min-w-0 truncate font-normal text-muted-foreground">{name}</span> : null}
    </span>
  );
}

export function Head(props: WorkViewProps) {
  const workspaceId = props.workspace.id;
  const eventId = useEventId(workspaceId);
  const { page } = usePrepHeld(workspaceId, eventId);
  const verb = useHeadVerb(page);
  const now = useMinute();
  const [busy, setBusy] = useState<"brief" | "followUp" | null>(null);
  const briefStatus = useSessionMetaValue(page?.briefSessionId, (meta) => meta.status);
  const followStatus = useSessionMetaValue(page?.followSessionId, (meta) => meta.status);
  if (!page || !eventId) return null;
  const openThread = (sessionId: string | null) => {
    if (sessionId) workOpenPort.get()?.(sessionId);
  };
  // The page stays: the header says Preparing, and the brief lands on it when the thread writes.
  const start = (kind: "brief" | "followUp") => {
    setBusy(kind);
    // A thread this window holds and knows has stopped is not waited on: the host, which cannot read a thread's status, starts a new one.
    const restart = kind === "brief" ? threadStopped(page.briefSessionId, briefStatus) : threadStopped(page.followSessionId, followStatus);
    (kind === "brief" ? briefPrep : followUpPrep)(props.env, workspaceId, eventId, restart)
      .then(() => loadPrep(props.env, workspaceId, eventId), (err: unknown) => said(err, "The thread did not start"))
      .finally(() => setBusy(null));
  };
  const proposed = shownTasks(page.doc.after?.tasks ?? []).filter((t) => t.state === "proposed");
  return (
    <PageVerbs
      verb={verb}
      busy={busy}
      thread={pageThread(page) !== null}
      again={!!page.doc.brief && !isOver(page.event, now) && verb !== "preparing"}
      notes={!!page.doc.notes}
      rest={proposed.length}
      ahead={page.aheadOffered ? page.aheadOn : null}
      onBrief={() => start("brief")}
      onFollowUp={() => start("followUp")}
      onOpenThread={() => openThread(verb === "preparing" ? page.briefSessionId : pageThread(page))}
      onNotes={() => openDialog("notes", eventId)}
      onAddPeople={() => openDialog("people", eventId)}
      onThread={() => props.startThread(eventChip(page.event))}
      onDismissRest={() => void decidePrepTasks(props.env, workspaceId, eventId, proposed.map((t) => t.id), "reject").catch(said)}
      // The offer is answered once the host has taken the switch; a refusal leaves it where it was.
      onAhead={(on) => void setPrepAhead(props.env, workspaceId, eventId, on).then(() => settleOffer(workspaceId), (err: unknown) => said(err))}
    />
  );
}

export interface PageVerbsProps {
  verb: HeadVerb;
  /** the press in flight: its button spins */
  busy?: "brief" | "followUp" | null;
  /** the page has a thread to open */
  thread: boolean;
  /** a brief stands and the meeting is still ahead: More offers Prepare again */
  again: boolean;
  notes: boolean;
  /** suggested tasks still waiting for his word */
  rest: number;
  /** Prepare each morning: on, off, or null where it is not offered */
  ahead: boolean | null;
  onBrief: () => void;
  onFollowUp: () => void;
  onOpenThread: () => void;
  onNotes: () => void;
  onAddPeople: () => void;
  onThread: () => void;
  onDismissRest: () => void;
  onAhead: (on: boolean) => void;
}

/** The header's end: the page's one verb for where the meeting stands, then More. */
export function PageVerbs(p: PageVerbsProps) {
  const rows: MenuRow[] = [
    ...(p.thread ? [{ kind: "item" as const, id: "open", label: "Open thread" }] : []),
    ...(p.again ? [{ kind: "item" as const, id: "again", label: "Prepare again" }] : []),
    { kind: "item", id: "people", label: "Add people…" },
    // The header already holds Add notes once the meeting is over.
    ...(p.verb === "addNotes" ? [] : [{ kind: "item" as const, id: "notes", label: p.notes ? "Edit notes…" : "Add notes…" }]),
    ...(p.rest > 0 ? [{ kind: "item" as const, id: "rest", label: "Dismiss the rest" }] : []),
    { kind: "item", id: "thread", label: "New thread about this" },
    ...(p.ahead === null ? [] : [{ kind: "sep" as const }, { kind: "item" as const, id: "ahead", label: AHEAD_LABEL, checked: p.ahead }]),
  ];
  const pick: Record<string, () => void> = { open: p.onOpenThread, again: p.onBrief, people: p.onAddPeople, notes: p.onNotes, rest: p.onDismissRest, thread: p.onThread, ahead: () => p.onAhead(!p.ahead) };
  return (
    <div className="flex items-center gap-1">
      {p.verb === "brief" ? (
        <Button variant="ghost" size="sm" disabled={p.busy === "brief"} onClick={p.onBrief}>
          <BusyLabel busy={p.busy === "brief"} label="Brief me" />
        </Button>
      ) : p.verb === "preparing" || p.verb === "following" ? (
        // The thread is at work: the word says so, and a press opens it.
        <Button variant="ghost" size="sm" className="font-normal text-muted-foreground" onClick={p.onOpenThread}>
          <BusyLabel busy label={p.verb === "preparing" ? "Preparing" : "Following up"} />
        </Button>
      ) : p.verb === "addNotes" ? (
        <Button variant="ghost" size="sm" onClick={p.onNotes} {...dialogs.intent}>
          Add notes
        </Button>
      ) : p.verb === "followUp" ? (
        <Button variant="ghost" size="sm" disabled={p.busy === "followUp"} onClick={p.onFollowUp}>
          <BusyLabel busy={p.busy === "followUp"} label="Follow up" />
        </Button>
      ) : null}
      <RowsMenu
        label="More"
        align="end"
        rows={rows}
        onPick={(id) => pick[id]?.()}
        tip={{ label: "More" }}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="More" {...dialogs.intent}>
            <MoreHorizontal />
          </Button>
        }
      />
    </div>
  );
}

// ── The body ──

/** Address to picture, from Mail's own index, so a person has the face Mail gives them. */
function useFaces(lifeos: LifeosSession): ReadonlyMap<string, string> {
  const rows = useLifeosQuery<FaceRow[]>(lifeos, "mail:faces", {});
  const base = (lifeos.client as { url?: string } | null)?.url;
  const value = rows.status === "ready" ? rows.value : undefined;
  return useMemo(() => faceMap(value, base ? `${base}/api/storage/` : null), [value, base]);
}

export function View(props: WorkViewProps) {
  const workspaceId = props.workspace.id;
  const eventId = useEventId(workspaceId);
  const { page, loaded, error } = usePrep(props.env, workspaceId, eventId);
  const faces = useFaces(props.lifeos);
  const verb = useHeadVerb(page);
  const now = useMinute();
  const offered = useOfferSettled(workspaceId);
  const open = useShared(ui);
  // A dialog is its own meeting's: one opened on another meeting's page is not drawn here, and it goes with the page.
  const dialog = open.eventId === eventId ? open.dialog : null;
  useEffect(() => closeDialog, [eventId]);
  // Agenda keeps its day and view through a visit here (its own unmount leaves them be); leaving for anywhere but
  // Agenda or another meeting's page ends that visit, so the next opens on today's list.
  useEffect(
    () => () => {
      const next = workViewNow();
      if (next?.workspaceId === workspaceId && (next.view === "agenda" || next.view === "prep")) return;
      resetAgendaPlace();
    },
    [workspaceId],
  );
  // A Notes dialog whose close could not keep his words opens again on them (PrepDialogs `reopenNotes`).
  useEffect(() => {
    if (!eventId) return;
    const reopen = () => openDialog("notes", eventId);
    void dialogs.load().then((m) => (m.reopenNotes.current = reopen), () => {});
    return () => {
      const chunk = dialogs.loaded();
      if (chunk?.reopenNotes.current === reopen) chunk.reopenNotes.current = null;
    };
  }, [eventId]);
  // A session that cannot read is the frame's to say (its sign-in or its line), never a second banner here.
  if (!props.lifeos.client) return sessionWaits(props.lifeos) ? <PrepSkeleton /> : null;
  if (!eventId) return <EmptyState title="No meeting is open" action={{ label: "Back to Agenda", onClick: () => openWorkView({ workspaceId, view: "agenda" }) }} />;
  const retry = () => loadPrep(props.env, workspaceId, eventId);
  if (!page) return loaded && error ? <EmptyState title="This page did not load" line={error} action={{ label: "Retry", onClick: retry }} /> : <PrepSkeleton />;
  const close = closeDialog;
  return (
    <>
      <PrepPageBody
        // A new meeting's page keeps nothing of the last one's ticks.
        key={page.event.id}
        page={page}
        faces={faces}
        now={now}
        verb={verb}
        offer={!offered}
        onRetry={retry}
        onAddPeople={() => openDialog("people", eventId)}
        onDecide={(ids, decision) => decidePrepTasks(props.env, workspaceId, eventId, ids, decision)}
        onOpenDraft={(draft) => openHeld({ at: "lifeos", table: "outbox", id: draft.outboxId }, props.env)}
        onOpenNotesFile={() => {
          const file = page.notesFile;
          // Beside the thread that reads it, once there is one; a document not yet followed up opens beside a new thread.
          if (file?.itemId && page.followSessionId) {
            workOpenPort.get()?.(page.followSessionId);
            // On its own tab, whatever tab that thread's pane last showed.
            const { followSessionId } = page;
            const { itemId } = file;
            void import("../canvas/store").then(({ openItem }) => openItem(props.env, followSessionId, { itemId })).catch(() => undefined);
          } else if (file?.kind === "document" && file.source?.at === "file") void openWorkspaceFile(props.env, { path: file.source.path, title: file.title }).catch(said);
        }}
        onAhead={() =>
          setPrepAhead(props.env, workspaceId, eventId, true).then(
            () => settleOffer(workspaceId),
            (err: unknown) => said(err),
          )
        }
        onDismissOffer={() => settleOffer(workspaceId)}
        refreshError={error}
      />
      {dialog === "people" ? <AddPeopleDialog key={eventId} env={props.env} lifeos={props.lifeos} page={page} faces={faces} onClose={close} /> : null}
      {dialog === "notes" ? <NotesDialog key={eventId} env={props.env} page={page} onClose={close} /> : null}
    </>
  );
}

/** The page's bones, at its own insets and in its shape: the title and its line, then people, then a section of rows. */
export function PrepSkeleton() {
  return (
    <div aria-busy className="mx-auto flex w-full max-w-[720px] flex-col ps-7 pe-6 py-6">
      <Skeleton className="h-4 w-[34%]" />
      <Skeleton className="mt-2.5 h-3 w-[46%]" />
      <div className="mt-8 flex flex-col gap-3">
        <Skeleton className="h-3 w-[9%]" />
        {[38, 30, 44].map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-8 flex flex-col gap-3">
        <Skeleton className="h-3 w-[7%]" />
        <Skeleton className="h-3 w-[58%]" />
        <Skeleton className="h-3 w-[42%]" />
      </div>
    </div>
  );
}

/** Up and down between the page's rows. */
function moveBetweenRows(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-page-row]");
  if (!row) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-page-row]")];
  const next = all[all.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
  e.preventDefault();
  next?.focus();
}

export interface PrepBodyProps {
  page: PrepPage;
  faces: ReadonlyMap<string, string>;
  now?: number;
  /** the header's verb, which says whether a brief is on its way */
  verb?: HeadVerb;
  /** the one-time offer of Prepare ahead may still be drawn in this workspace */
  offer?: boolean;
  /** reads the page again: what a part that did not load offers */
  onRetry: () => void | Promise<void>;
  onAddPeople: () => void;
  /** his word on suggested tasks; answers the ones LifeOS did not take */
  onDecide?: (taskIds: string[], decision: "accept" | "reject") => Promise<{ id: string; error: string }[]>;
  onOpenDraft?: (draft: PrepDraft) => void;
  /** opens the file that holds the notes: beside its thread once one reads it, else (a document) beside a new one */
  onOpenNotesFile?: () => void;
  /** Turn on, under his first brief: settles once the host has taken it */
  onAhead?: () => void | Promise<void>;
  onDismissOffer?: () => void;
  /** the last read failed, though an older page still shows: said in the state line, with Retry */
  refreshError?: string | null;
  /** for the preview: a filing that already failed, and the tasks ticked */
  failedAtFirst?: { id: string; error: string }[];
  tickedAtFirst?: readonly string[];
}

/** The page over a `PrepPage`, holding no query: the preview and the tests draw it as the app does. */
export function PrepPageBody({ page, faces, now = Date.now(), verb = null, offer = false, onRetry, onAddPeople, onDecide, onOpenDraft, onOpenNotesFile, onAhead, onDismissOffer, refreshError = null, failedAtFirst, tickedAtFirst }: PrepBodyProps) {
  const { event, workspaceId, doc } = page;
  const go = (view: string, target: Record<string, unknown>) => openWorkView({ workspaceId, view, ...target });
  const openLine = (line: PrepLine) => (line.ref ? () => openRef(workspaceId, line.ref!) : undefined);
  const more = moreWords(page.morePeople);
  const after = doc.after;
  const outcome = !!(doc.notes || after);
  const [failed, setFailed] = useState<{ id: string; error: string }[]>(failedAtFirst ?? []);
  // The line about a failed filing stays until the next answer is in: a Retry spins on it, and nothing flickers away.
  const decide = async (ids: string[], decision: "accept" | "reject"): Promise<void> => {
    if (!onDecide) return;
    let now: { id: string; error: string }[];
    try {
      now = await onDecide(ids, decision);
    } catch (err) {
      now = ids.map((id) => ({ id, error: refusalWords(err) || "The host did not answer" }));
    }
    setFailed((was) => [...was.filter((f) => !ids.includes(f.id)), ...now]);
  };
  const [turningOn, setTurningOn] = useState(false);
  // One line at a time: a filing that failed is his to try again before a part that did not load.
  const stillFailed = failed.filter((f) => after?.tasks.some((t) => t.id === f.id && t.state === "proposed"));
  const problem = problemWords(page.problems);
  // The brief's lines rise in only when they land on a page that was open without them.
  const briefAtMount = useRef(doc.brief?.at ?? null);
  const briefLanded = !!doc.brief && doc.brief.at !== briefAtMount.current;
  return (
    <>
      {stillFailed.length ? (
        // Retry is the one way to try again: the tasks it names are unticked below, so no second button says the same.
        <ViewStateLine word={failedWords(stillFailed, after?.tasks ?? [])} detail={stillFailed[0]!.error} onRetry={() => decide(stillFailed.map((f) => f.id), "accept")} />
      ) : refreshError ? (
        <ViewStateLine word="This page did not refresh" detail={refreshError} onRetry={onRetry} />
      ) : problem ? (
        <ViewStateLine word={problem} onRetry={onRetry} />
      ) : null}
      <div onKeyDown={moveBetweenRows} className="mx-auto w-full max-w-[720px] ps-7 pe-6 py-6">
        <header className="flex flex-col gap-0.5">
          <h1 className="text-base leading-6 font-semibold tracking-[-0.01em] text-pretty wrap-anywhere text-foreground select-text">{event.title || "Untitled meeting"}</h1>
          <p className="text-xs text-muted-foreground select-text">{whenLine(event, now)}</p>
        </header>

        {after?.summary.length ? (
          <Words lines={after.summary} onOpen={openLine} />
        ) : outcomeIsComing(page, verb) ? (
          // The follow-up thread is reading his notes: its outcome will lead the page from here.
          <TextBones label="The outcome is being written" />
        ) : null}
        {doc.notes ? <Notes key={notesLines(page)} text={doc.notes.text} lines={notesLines(page)} file={page.notesFile} onOpenFile={onOpenNotesFile} /> : null}
        {after ? (
          <>
            <Section label="Decided" show={after.decisions.length > 0}>
              {after.decisions.map((line, i) => (
                <LineRow key={i} text={line.text} onOpen={openLine(line)} />
              ))}
            </Section>
            <ToDo tasks={shownTasks(after.tasks)} now={now} onDecide={decide} onOpenTask={(id) => go("tasks", { task: id })} tickedAtFirst={tickedAtFirst} />
            <Section label="Open questions" show={after.questions.length > 0}>
              {after.questions.map((line, i) => (
                <LineRow key={i} text={line.text} onOpen={openLine(line)} />
              ))}
            </Section>
          </>
        ) : null}
        <Section label="Mail" show={page.drafts.length > 0}>
          {page.drafts.map((draft) => (
            <LineRow key={draft.outboxId} text={draftLine(draft)} line="Waiting in the Outbox" onOpen={onOpenDraft ? () => onOpenDraft(draft) : undefined} />
          ))}
        </Section>

        {doc.brief ? (
          // What matters leads the page with no heading; once the outcome stands above it, it is named.
          <Brief label={outcome ? "Brief" : undefined}>
            <Words key={doc.brief.at} lines={doc.brief.matters} onOpen={openLine} land={briefLanded} bare={outcome} />
            {offer && !outcome && page.aheadOffered && !page.aheadOn ? (
              // One quiet line: the switch by its one name, then its two answers kept together when the page is narrow.
              <div data-prep-offer className="mt-2 flex min-h-6 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{AHEAD_LABEL}</span>
                <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={turningOn}
                  onClick={() => {
                    setTurningOn(true);
                    void Promise.resolve(onAhead?.()).finally(() => setTurningOn(false));
                  }}
                >
                  <BusyLabel busy={turningOn} label="Turn on" />
                </Button>
                <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="text-muted-foreground" disabled={turningOn} onClick={onDismissOffer}>
                  <X />
                </Button>
                </span>
              </div>
            ) : null}
          </Brief>
        ) : briefIsComing(page, verb) ? (
          <TextBones label="The brief is being written" />
        ) : null}

        {page.last ? (
          <Section label={lastLabel(page.last)} onOpenLabel={() => go("prep", { event: page.last!.eventId })}>
            {page.last.decided.map((line, i) => (
              <LineRow key={`d${i}`} text={line.text} onOpen={openLine(line)} />
            ))}
            {page.last.open.map((line, i) => (
              <LineRow key={`o${i}`} text={line.text} line="Left open" onOpen={openLine(line)} />
            ))}
            {page.last.tasks.map((task) => (
              <TaskRow key={task.id} task={task} line="Still to do" now={now} onOpen={() => go("tasks", { task: task.id })} />
            ))}
          </Section>
        ) : null}

        <Section
          label="People"
          // Under the heading and outside the list: these are not people.
          foot={
            nobodyOn(page) ? (
              <div className="flex min-h-8 items-center gap-2 text-[13px] leading-5 text-muted-foreground">
                <span>No one is listed on this meeting</span>
                <Button variant="ghost" size="xs" onClick={onAddPeople} {...dialogs.intent}>
                  Add people
                </Button>
              </div>
            ) : more ? (
              <p className="py-1.5 text-xs text-muted-foreground">{more}</p>
            ) : null
          }
        >
          {page.people.map((person) => (
            <PersonRow key={person.address ?? person.name} person={person} picture={person.address ? pictureOf([person.address], faces) : undefined} now={now} onOpen={personOpener(workspaceId, person)} />
          ))}
        </Section>

        <Section label="Tasks" show={page.tasks.length > 0}>
          {page.tasks.map((task) => (
            <TaskRow key={task.id} task={task} line={taskLine(task)} now={now} onOpen={() => go("tasks", { task: task.id })} />
          ))}
        </Section>

        <Section label="Files" show={page.files.length > 0}>
          {page.files.map((file, i) => (
            <LineRow key={file.url ?? `${file.title}:${i}`} text={file.title} line={fileWhere(file)} onOpen={fileOpener(file)} />
          ))}
        </Section>
      </div>
    </>
  );
}

/** What a line's reference opens: its mail, its task, its event's page, its document or its person, each where it lives. */
function openRef(workspaceId: string, ref: NonNullable<PrepLine["ref"]>): void {
  if (ref.table === "mailThreads") openWorkView({ workspaceId, view: "mail", mail: ref.id });
  else if (ref.table === "tasks") openWorkView({ workspaceId, view: "tasks", task: ref.id });
  else if (ref.table === "events") openWorkView({ workspaceId, view: "prep", event: ref.id });
  else if (ref.table === "people") openWorkView({ workspaceId, view: "people", person: ref.id });
  else openWorkView({ workspaceId, view: "docs", doc: { id: ref.id, title: "" } });
}

/** A person's row opens their newest mail, or their page in People when there is none; a name alone opens nothing. */
function personOpener(workspaceId: string, person: PrepPerson): (() => void) | undefined {
  if (person.mail) return () => openWorkView({ workspaceId, view: "mail", mail: person.mail!.id });
  if (person.personId) return () => openWorkView({ workspaceId, view: "people", person: person.personId! });
  return undefined;
}

/** A link opens outside the app, as every link does. */
function fileOpener(file: PrepFileRef): (() => void) | undefined {
  const url = file.url;
  return url ? () => void window.open(url, "_blank", "noopener,noreferrer") : undefined;
}

// ── What a thread wrote: body text, a paragraph a line ──

/** The brief's place: under the title with no heading, or a named section once the outcome leads the page. */
function Brief({ label, children }: { label: string | undefined; children: ReactNode }) {
  if (!label) return <section aria-label="What matters">{children}</section>;
  return (
    <section aria-label={label} className="mt-6">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

/**
 * Lines as body text (14/22), one paragraph each, at a reading measure. A
 * line that names a mail, a task or a document is pressable and opens it.
 * `land`: the lines rise in, a step apart, as rows that land together do.
 */
function Words({ lines, onOpen, land = false, bare = false }: { lines: readonly PrepLine[]; onOpen: (line: PrepLine) => (() => void) | undefined; land?: boolean; bare?: boolean }) {
  return (
    <div className={cn("flex max-w-[65ch] flex-col gap-2 text-sm leading-[22px] text-foreground", bare ? "mt-1" : "mt-4")}>
      {lines.map((line, i) => {
        const open = onOpen(line);
        return (
          // The landing rides a wrapper, so a pressable line keeps its own press fill.
          <div key={i} className={land ? "step-land" : undefined} style={land ? ({ "--stagger": Math.min(i, 3) } as CSSProperties) : undefined}>
            {open ? (
              // The app's own row, at the brief's type: its focus ring and press fill, the words free to wrap.
              <ItemButton data-page-row="" size="xs" onClick={open} className={cn("-mx-2 w-[calc(100%+16px)] rounded-md py-0 text-sm leading-[22px] text-pretty", ROW_PRESS)}>
                {line.text}
              </ItemButton>
            ) : (
              <p className="text-pretty select-text">{line.text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Three text bones where what a thread is writing will land, at the reading measure. */
function TextBones({ label }: { label: string }) {
  return (
    <div aria-busy aria-label={label} className="mt-5 flex max-w-[65ch] flex-col gap-3">
      {[92, 78, 58].map((w) => (
        <Skeleton key={w} className="h-3.5" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

const CLAMP = { 2: "line-clamp-2", 6: "line-clamp-6" } as const;

/**
 * His notes: the file that holds them, which opens beside its thread, and what he typed. They show `lines` lines
 * (six while they lead the page, two once the outcome stands over what they say), then Show all, offered only when
 * the words run past that at the width they are drawn at.
 */
function Notes({ text, lines, file, onOpenFile }: { text: string; lines: 2 | 6; file: PrepPage["notesFile"]; onOpenFile: (() => void) | undefined }) {
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  const words = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = words.current;
    if (!el || all) return;
    // Measured, not guessed from the text's length: five short lines wrap to eight in a narrow window.
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, lines, all]);
  if (!text && !file) return null;
  return (
    <section aria-label="Notes" className="mt-6">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">Notes</h2>
      {file ? (
        <div role="list">
          <LineRow text={file.title} onOpen={onOpenFile} />
        </div>
      ) : null}
      {text ? (
        <p ref={words} className={cn("max-w-[65ch] text-sm leading-[22px] whitespace-pre-line text-foreground select-text", file && "mt-1", !all && CLAMP[lines])}>
          {text}
        </p>
      ) : null}
      {long || all ? (
        <Button variant="ghost" size="xs" className="-ms-2 mt-1 text-muted-foreground" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </section>
  );
}

// ── To do: the tasks the follow-up suggested ──

/**
 * Suggested tasks wait on the tint an addition has until he ticks them and
 * presses Add; a filed one loses the tint, takes LifeOS's mark and opens its
 * sheet. The section's foot holds Tick all and, while any is ticked, the
 * page's one primary button.
 */
function ToDo({
  tasks,
  now,
  onDecide,
  onOpenTask,
  tickedAtFirst,
}: {
  tasks: readonly PrepSuggestion[];
  now: number;
  onDecide: (ids: string[], decision: "accept" | "reject") => Promise<void>;
  onOpenTask: (lifeosTaskId: string) => void;
  tickedAtFirst?: readonly string[] | undefined;
}) {
  const proposed = tasks.filter((t) => t.state === "proposed");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(tickedAtFirst ?? (TICKED_AT_FIRST ? proposed.map((t) => t.id) : [])));
  const [adding, setAdding] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  if (!tasks.length) return null;
  const picked = proposed.filter((t) => ticked.has(t.id));
  const allTicked = proposed.length > 0 && picked.length === proposed.length;
  const tick = (id: string, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const add = () => {
    const ids = picked.map((t) => t.id);
    setAdding(true);
    void onDecide(ids, "accept").finally(() => {
      setAdding(false);
      // What was asked is answered: filed, or named in the line above with its Retry. Either way its tick is spent.
      setTicked((was) => new Set([...was].filter((id) => !ids.includes(id))));
      // The button he pressed goes with the last tick: the caret lands on the first task it filed, not on nothing.
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const filed = ids.map((id) => list.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"][data-task-state="filed"] [data-page-row]`)).find(Boolean);
        filed?.focus();
      });
    });
  };
  return (
    <section aria-label="To do" className="mt-6">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">To do</h2>
      {/* At the measure the notes and the brief read at (65ch of 14px): a tint the column's whole width would shout. */}
      <div ref={list} role="list" className="flex max-w-[65ch] flex-col gap-0.5 text-sm">
        {tasks.map((task) => {
          const line = suggestionLine(task);
          const words = (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-pretty text-foreground">{task.title}</span>
              {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
            </span>
          );
          // When it is due trails the row, as a task's does under Tasks.
          const due = task.due !== undefined ? <span className={TRAIL}>{formatDue(task.due, now)}</span> : null;
          return (
            <div key={task.id} role="listitem" data-task={task.id} data-task-state={task.state}>
              {task.state === "filed" ? (
                <ItemButton data-page-row="" size="xs" onClick={() => task.lifeosTaskId && onOpenTask(task.lifeosTaskId)} className={cn(ROW, ROW_PRESS, "items-start gap-2")}>
                  <Lifeos aria-label="In LifeOS" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {words}
                  {due}
                </ItemButton>
              ) : (
                // The tint an addition waits on; the whole row takes the pointer, the box the keyboard.
                <div className={cn("flex cursor-default items-start gap-2 border border-transparent bg-(--add-bg) px-2", ROW)} onClick={() => tick(task.id, !ticked.has(task.id))}>
                  <Checkbox
                    aria-label={task.title}
                    // On the tint the box's usual hairline is too faint to say "tick me": the muted ink, which reads on it.
                    className="mt-0.5 border-muted-foreground"
                    checked={ticked.has(task.id)}
                    disabled={adding}
                    onCheckedChange={(on) => tick(task.id, on === true)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {words}
                  {due}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {proposed.length ? (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="-ms-2" disabled={adding} onClick={() => setTicked(new Set(allTicked ? [] : proposed.map((t) => t.id)))}>
            {allTicked ? "Untick all" : "Tick all"}
          </Button>
          {picked.length ? (
            <Button size="sm" disabled={adding} onClick={add}>
              <BusyLabel busy={adding} label={addTasksLabel(picked.length)} />
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// People's `Section` and `PageRow` are private to it; these are the page's own, on the same measures.

function Section({ label, show = true, onOpenLabel, foot, children }: { label: string; show?: boolean; onOpenLabel?: () => void; foot?: ReactNode; children: ReactNode }) {
  if (!show) return null;
  return (
    <section aria-label={label} className="mt-6">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">
        {onOpenLabel ? (
          <button type="button" className="relative -mx-1 cursor-pointer rounded-sm px-1 transition-colors duration-(--dur-hover) after:absolute after:inset-x-0 after:-inset-y-1.5 hover:text-foreground" onClick={onOpenLabel}>
            {label}
          </button>
        ) : (
          label
        )}
      </h2>
      <div role="list">{children}</div>
      {foot}
    </section>
  );
}

// 13px on 20px lines (DESIGN.md "Type scale"): a row whose words wrap keeps the row's own leading.
const ROW = "-mx-2 min-h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-1.5 text-[13px] leading-5";
const TRAIL = "mt-0.5 shrink-0 self-start text-xs text-muted-foreground tabular-nums";

/** A row that opens something is a button; one that opens nothing is the same box, still. */
function RowBox({ onOpen, className, children }: { onOpen: (() => void) | undefined; className?: string; children: ReactNode }) {
  return (
    <div role="listitem">
      {onOpen ? (
        <ItemButton data-page-row="" size="xs" onClick={onOpen} className={cn(ROW, ROW_PRESS, className)}>
          {children}
        </ItemButton>
      ) : (
        // The button's own box (its 1px edge among it), so a still row's words sit where a pressable row's do.
        <div className={cn("flex items-center gap-2 border border-transparent px-2", ROW, className)}>{children}</div>
      )}
    </div>
  );
}

/** One line of the page: its words, a muted second line, a fact at the end. */
function LineRow({ text, line, trail, onOpen }: { text: string; line?: string | undefined; trail?: string | undefined; onOpen: (() => void) | undefined }) {
  return (
    <RowBox onOpen={onOpen}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-foreground", onOpen ? "truncate" : "text-pretty select-text")}>{text}</span>
        {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
      </span>
      {trail ? <span className={TRAIL}>{trail}</span> : null}
    </RowBox>
  );
}

function TaskRow({ task, line, now, onOpen }: { task: PrepTask; line: string | undefined; now: number; onOpen: () => void }) {
  return <LineRow text={task.title} line={line} trail={task.dueAt !== undefined ? formatDue(task.dueAt, now) : undefined} onOpen={onOpen} />;
}

/** Someone on the meeting: the face, the name over their newest mail's subject, its day (or "Declined") at the end. */
function PersonRow({ person, picture, now, onOpen }: { person: PrepPerson; picture: string | undefined; now: number; onOpen: (() => void) | undefined }) {
  const line = personLine(person);
  const trail = personTrail(person, now);
  return (
    <RowBox onOpen={onOpen} className="gap-2">
      {/* On the name's line: a 24px face beside 20px of text sits 2px high. */}
      <Face name={person.name} picture={picture} size="row" className={cn("self-start", line ? "-mt-0.5" : "-my-0.5")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("truncate text-foreground", person.mail?.unread && "font-medium")}>{person.name}</span>
        {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
      </span>
      {trail ? <span className={TRAIL}>{trail}</span> : null}
    </RowBox>
  );
}
