import { useEffect, useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { PrepFileRef, PrepLine, PrepPage, PrepPerson, PrepTask } from "@shared/contract-work-prep";
import type { ContextChip } from "@shared/work";
import { formatDue } from "work-kit/views/lib/format";
import { ArrowLeft, MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { defineChunk } from "../../lib/lazyChunk";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { Face } from "../mail/face";
import { faceMap, pictureOf, type FaceRow } from "../people/model";
import { sessionWaits, useLifeosQuery, type LifeosSession } from "../shell/lifeos";
import { shared, useShared } from "../tasks/store";
import type { WorkViewProps } from "../views/registry";
import { ViewStateLine } from "../views/ViewStateLine";
import { loadPrep, usePrep, usePrepHeld } from "./data";
import { fileWhere, lastLabel, moreWords, nobodyOn, personLine, personTrail, problemWords, taskLine, whenLine } from "./model";

/**
 * A meeting's page (docs/agents/work-prep.md): who is coming, the last mail
 * with each, the open tasks that touch them or the subject, the files in
 * play and what was agreed last time. It is a view of the workspace with no
 * row in the column: Agenda's Prepare opens it, and its header leads back.
 * Opening it reads facts and starts nothing.
 */

const dialogs = defineChunk("work-prep-dialogs", () => import("./PrepDialogs"));
const AddPeopleDialog = dialogs.surface("AddPeopleDialog");

/** What the header and the body share: the dialog that is open. */
const ui = shared<{ dialog: "people" | null }>({ dialog: null });

/** The meeting this workspace's page is on: the event the view was opened with. */
function useEventId(workspaceId: string): string | null {
  const open = useWorkView();
  return open?.workspaceId === workspaceId && open.view === "prep" && open.event ? open.event : null;
}

export const eventChip = (event: { id: string; title: string }): ContextChip => ({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event.id } });

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
  const eventId = useEventId(props.workspace.id);
  const { page } = usePrepHeld(props.workspace.id, eventId);
  if (!page) return null;
  return <PageVerbs onAddPeople={() => ui.set({ dialog: "people" })} onThread={() => props.startThread(eventChip(page.event))} />;
}

/** The header's end: More, which holds what the page can do beside its one verb. */
export function PageVerbs({ onAddPeople, onThread }: { onAddPeople: () => void; onThread: () => void }) {
  const rows: MenuRow[] = [
    { kind: "item", id: "people", label: "Add people…" },
    { kind: "item", id: "thread", label: "New thread about this" },
  ];
  return (
    <RowsMenu
      label="More"
      align="end"
      rows={rows}
      onPick={(id) => (id === "people" ? onAddPeople() : onThread())}
      tip={{ label: "More" }}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="More" {...dialogs.intent}>
          <MoreHorizontal />
        </Button>
      }
    />
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
  const { dialog } = useShared(ui);
  // A dialog left open goes with the page: the next meeting's never opens under it.
  useEffect(() => () => ui.set({ dialog: null }), []);
  // A session that cannot read is the frame's to say (its sign-in or its line), never a second banner here.
  if (!props.lifeos.client) return sessionWaits(props.lifeos) ? <PrepSkeleton /> : null;
  if (!eventId) return <EmptyState title="No meeting is open" action={{ label: "Back to Agenda", onClick: () => openWorkView({ workspaceId, view: "agenda" }) }} />;
  const retry = () => loadPrep(props.env, workspaceId, eventId);
  if (!page) return loaded && error ? <EmptyState title="This page did not load" line={error} action={{ label: "Retry", onClick: retry }} /> : <PrepSkeleton />;
  return (
    <>
      <PrepPageBody page={page} faces={faces} onRetry={retry} onAddPeople={() => ui.set({ dialog: "people" })} />
      {dialog === "people" ? <AddPeopleDialog env={props.env} lifeos={props.lifeos} page={page} faces={faces} onClose={() => ui.set({ dialog: null })} /> : null}
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
  /** reads the page again: what a part that did not load offers */
  onRetry: () => void | Promise<void>;
  onAddPeople: () => void;
}

/** The page over a `PrepPage`, holding no query: the preview and the tests draw it as the app does. */
export function PrepPageBody({ page, faces, now = Date.now(), onRetry, onAddPeople }: PrepBodyProps) {
  const { event, workspaceId } = page;
  const go = (view: string, target: Record<string, unknown>) => openWorkView({ workspaceId, view, ...target });
  const openLine = (line: PrepLine) => (line.ref ? () => openRef(workspaceId, line.ref!) : undefined);
  const problem = problemWords(page.problems);
  const more = moreWords(page.morePeople);
  return (
    <>
      {problem ? <ViewStateLine word={problem} onRetry={onRetry} /> : null}
      <div onKeyDown={moveBetweenRows} className="mx-auto w-full max-w-[720px] ps-7 pe-6 py-6">
        <header className="flex flex-col gap-0.5">
          <h1 className="text-base leading-6 font-semibold tracking-[-0.01em] text-pretty wrap-anywhere text-foreground select-text">{event.title || "Untitled meeting"}</h1>
          <p className="text-xs text-muted-foreground select-text">{whenLine(event, now)}</p>
        </header>

        {page.last ? (
          <Section
            label={lastLabel(page.last)}
            onOpenLabel={() => go("prep", { event: page.last!.eventId })}
          >
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

        <Section label="People">
          {page.people.map((person) => (
            <PersonRow key={person.address ?? person.name} person={person} picture={person.address ? pictureOf([person.address], faces) : undefined} now={now} onOpen={personOpener(workspaceId, person)} />
          ))}
          {more ? <p className="py-1.5 text-xs text-muted-foreground">{more}</p> : null}
          {nobodyOn(page) ? (
            <div className="flex min-h-8 items-center gap-2 text-[13px] text-muted-foreground">
              <span>No one is listed on this event</span>
              <Button variant="ghost" size="xs" onClick={onAddPeople} {...dialogs.intent}>
                Add people
              </Button>
            </div>
          ) : null}
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

// People's `Section` and `PageRow` are private to it; these are the page's own, on the same measures.

function Section({ label, show = true, onOpenLabel, children }: { label: string; show?: boolean; onOpenLabel?: () => void; children: ReactNode }) {
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
    </section>
  );
}

const ROW = "-mx-2 min-h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-1.5 text-[13px]";
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
