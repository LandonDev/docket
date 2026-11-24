import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DocMode, DocOpen, DocWritten } from "@shared/contract-work-docs";
import type { HistoryCompare } from "@shared/contract-work-history";
import type { CanvasSource, ContextChip, Principal } from "@shared/work";
import {
  DOCUMENT_LADDER,
  DocumentEditor,
  EditorAdaptersProvider,
  EditorKitProvider,
  useReview,
  type AnyEditor,
  type DocumentPresence,
  type DocumentSelection,
  type DocumentHandle as PagesHandle,
  type DocumentStatus,
  type DocumentView,
  type EditorAdapters,
  type PageZoom,
  type FindHandle,
  type ReviewChange,
} from "work-kit/editor";
import type { DocumentPage } from "work-kit/editor/page";
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { useColorScheme } from "../../hooks/useColorScheme";
import { registry } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { ItemBones, ItemSkeleton } from "../canvas/ItemBones";
import type { CanvasBodyProps, CanvasShell, MoreEntry, Presence } from "../canvas/kind";
import { mailSafeCopy } from "work-kit/formats/clipboard";
import { useWorkCommands } from "../formats/command";
import { registerFlush } from "../canvas/flush";
import { Preview } from "../formats/PreviewFrame";
import { DropImport, ImportBody, keepAsDocument, readAttachment } from "../formats/Import";
import { importsFirst, paperFor } from "../formats/model";
import { Doc, Export } from "../icons";
import { historyActions, refreshHistory, useBranches } from "../history/store";
import { useGoogleDoc } from "../google/docMore";
import { DOC_FONTS } from "./fonts";
import { docHost, servedBy, type DocHost } from "./host";
import { docPreviewSource } from "./previewSource";
import { decided, PAGE_CHANGE_ID, reviewOf } from "./review";
import { PageChangeSummary } from "../history/Compare";
import { docThreads, type DocThreads } from "./threads";
import { ShareButton } from "../guests/Share";
import { useWorkspaceOf } from "../files/workspaceOf";

// Save as Word to…: the Files place's folder picker, loaded on his press.
const SaveAsWordDialog = lazy(() => import("../files/SaveAsWordDialog").then((m) => ({ default: m.SaveAsWordDialog })));

/**
 * The document kind's body (docs/agents/work-docs.md; the approved
 * prototype, .temp-code/prototypes/work-workspaces-2/doc.html): the shared
 * block editor on a LifeOS document or a `.tcdoc`, live with everyone who
 * has it open. Suggestions are tinted in the text and stepped from the bar;
 * comment threads float at their words, and move to the margin once the
 * canvas has room for the text and 296px beside it (the thread folded). The
 * mode, presence, the state line and the agent's last write go to the pane.
 * A project's page draws the same surface with no pane around it.
 */

export interface DocState {
  scrollTop?: number;
  /** His own pick of Flow or Pages for this item; left out, the canvas's width at open decides (`openingView`). */
  view?: DocumentView;
  /** Pages' zoom as he last set it for this item. */
  zoom?: PageZoom;
}

/** The canvas width from which a styled document opens in Pages: narrower, a page is too small to type on (8px text beside a thread). */
export const PAGES_FROM = 640;
/** The canvas width that holds a US Letter sheet at true size (816px) inside the stage's 24px sides. */
export const TRUE_SIZE_FROM = 864;

/** The view an item opens in before he picks one: Pages on a canvas of 640px or more, Flow under it. A classic document is Flow whatever this says (the editor's own rule). */
export const openingView = (width: number): DocumentView => (width >= PAGES_FROM ? "pages" : "flow");

/** The zoom Pages opens at before he picks one: true size where a sheet fits at it, else fitted to the width (a sheet stretched over a wide window sets 11 pt text at 26px). */
export const openingZoom = (width: number): PageZoom => (width >= TRUE_SIZE_FROM ? 100 : "width");

/** The text's measure, the block handle's gutter, and the margin column (24px gap + 272px card). */
const MEASURE = 672;
const GUTTER = 52;

/**
 * What the column gives up while the editor draws sheets (its `.te-pages-stage` is in it): the
 * measure, the gutter and the title go, and a review's page summary keeps the stage's 24px side and
 * its 16px over the first sheet. In CSS, not state: the editor knows a frame before the pane is told.
 */
const IN_PAGES = {
  column: "has-[.te-pages-stage]:max-w-none",
  title: "group-has-[.te-pages-stage]/doc:hidden",
  text: "group-has-[.te-pages-stage]/doc:px-0",
  summary: "group-has-[.te-pages-stage]/doc:-mb-4 group-has-[.te-pages-stage]/doc:px-6",
} as const;
const MARGIN = 296;
/** The canvas width from which comment threads sit in the margin. */
export const MARGIN_FROM = 1104;

/** The pane's presence palette (`--presence-1` to `-8`), which is the editor's caret hues in the same order. */
function presencePalette(): string[] {
  if (typeof document === "undefined") return [];
  const style = getComputedStyle(document.documentElement);
  return Array.from({ length: 8 }, (_, i) => style.getPropertyValue(`--presence-${i + 1}`).trim().toLowerCase());
}

export function presenceOf(people: readonly DocumentPresence[], palette: readonly string[] = presencePalette()): Presence[] {
  return people.map((p) => {
    const at = p.color ? palette.indexOf(p.color.toLowerCase()) : -1;
    return { id: p.id, name: p.name, ...(at >= 0 ? { hue: (at + 1) as Presence["hue"] } : {}), ...(p.avatarUrl ? { image: p.avatarUrl } : {}) };
  });
}

/** The editor's sentence for what is wrong, as the pane's one state line. */
function statusLineOf(status: DocumentStatus | null): Parameters<CanvasShell["statusLine"]>[0] {
  if (!status) return null;
  const word = { offline: "Offline", waiting: "Waiting", refused: "Read only", unreadable: "Did not open", seed: "Not set up" }[status.kind];
  return {
    tone: status.kind === "unreadable" || status.kind === "seed" ? "failed" : "needs",
    word,
    detail: status.message,
    ...(status.retry ? { action: { label: "Retry", run: status.retry } } : {}),
  };
}

type Opened = { host: DocHost; open: DocOpen } | { error: string } | null;

/** Opens the document on the host the item lives on, or on the host that serves it when that is another. */
export function useOpened(env: string, source: CanvasSource, attempt: number): Opened {
  const [opened, setOpened] = useState<Opened>(null);
  // Every canvas push hands a new copy of the item: the source's value, not its object, says it is another document,
  // so a push never reopens the editor under his hands (its caret, find, Preview and the frames it has yet to send).
  const key = JSON.stringify(source);
  const latest = useRef(source);
  latest.current = source;
  useEffect(() => {
    let live = true;
    setOpened(null);
    const tryOn = async (on: string, again: boolean): Promise<void> => {
      const host = docHost(on, latest.current);
      try {
        const open = await host.open();
        if (live) setOpened({ host, open });
      } catch (err) {
        const other = servedBy(err);
        if (again && other && other !== on) return tryOn(other, false);
        if (live) setOpened({ error: err instanceof Error ? err.message : String(err) });
      }
    };
    void tryOn(env, true);
    return () => {
      live = false;
    };
  }, [env, key, attempt]);
  return opened;
}

/** The width the surface has. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const TITLE_STYLE = { fontSize: DOCUMENT_LADDER.title.size, lineHeight: `${DOCUMENT_LADDER.title.leading}px`, fontWeight: DOCUMENT_LADDER.title.weight };

function Title({ text }: { text: string }) {
  return (
    <h1 className="text-foreground [text-wrap:balance]" style={TITLE_STYLE}>
      {text}
    </h1>
  );
}

const plain = (words: string): string => words.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Whether the document opens with its own name (a Word file's Title line, a note's first heading):
 * the column's title above it would then say the name twice, under the pane's own line that has
 * said it once. Read from the first block alone, on each change.
 */
export function useNamesItself(editor: AnyEditor | null, title: string): boolean {
  const lead = useSyncExternalStore(
    useCallback((changed: () => void) => editor?.onChange(changed) ?? (() => undefined), [editor]),
    () => editor?.prosemirrorState?.doc.firstChild?.firstChild?.firstChild?.textContent ?? "",
  );
  return plain(lead) !== "" && plain(lead) === plain(title);
}

/** A LifeOS document's title, renamed in place: Enter or leaving the field keeps it, Escape puts it back. A refused rename puts it back and says why, once. */
export function TitleField({ text, rename }: { text: string; rename(title: string): Promise<void> }) {
  const [value, setValue] = useState(text);
  const [kept, setKept] = useState(text);
  const keep = async (): Promise<void> => {
    const next = value.trim();
    if (!next || next === kept) return setValue(kept);
    setKept(next);
    try {
      await rename(next);
    } catch (err) {
      setKept(kept);
      setValue(kept);
      const toast = await loadToast();
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't rename the document");
    }
  };
  return (
    <input
      aria-label="Title"
      value={value}
      maxLength={200}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void keep()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setValue(kept);
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
        }
      }}
      // The one focus ring, inside a 6px inset that hangs into the gutter, so the words stay on the text's edge.
      className="focus-ring -mx-1.5 w-full truncate rounded-md bg-transparent px-1.5 text-foreground outline-none placeholder:text-muted-foreground"
      style={TITLE_STYLE}
    />
  );
}

/** Where each item's document is: opening, open or failed. The bar's Share waits for open; its bone holds the bar's place while opening. */
type OpenState = "opening" | "open" | "failed";
const openStates = new Map<string, OpenState>();
const openWatchers = new Set<() => void>();

export function markOpen(itemId: string, state: OpenState | null): void {
  if ((openStates.get(itemId) ?? null) === state) return;
  if (state) openStates.set(itemId, state);
  else openStates.delete(itemId);
  for (const watcher of openWatchers) watcher();
}

function useOpenState(itemId: string): OpenState {
  return useSyncExternalStore(
    (watcher) => {
      openWatchers.add(watcher);
      return () => openWatchers.delete(watcher);
    },
    // The bar mounts with the body, before the body has said: that is opening.
    () => openStates.get(itemId) ?? "opening",
  );
}

/** Where each item's reader is in Pages, "Page 2 of 5": told by the editor as he scrolls, gone in Flow and while unknown. */
type PageAt = { page: number; count: number };
const pagesAt = new Map<string, PageAt>();
const pagesWatchers = new Set<() => void>();

export function tellPage(itemId: string, at: PageAt | null): void {
  const was = pagesAt.get(itemId);
  if (at ? was?.page === at.page && was?.count === at.count : !was) return;
  if (at) pagesAt.set(itemId, at);
  else pagesAt.delete(itemId);
  for (const watcher of pagesWatchers) watcher();
}

function usePageAt(itemId: string): PageAt | null {
  return useSyncExternalStore(
    (watcher) => {
      pagesWatchers.add(watcher);
      return () => pagesWatchers.delete(watcher);
    },
    () => pagesAt.get(itemId) ?? null,
  );
}

/** The bar's one fact in Pages: which sheet he is on, of how many. */
function PageFact({ itemId }: { itemId: string }) {
  const at = usePageAt(itemId);
  if (!at) return null;
  return (
    <span data-doc-page data-narrow-hide className="ms-auto shrink-0 px-1.5 text-xs text-muted-foreground tabular-nums">
      Page {at.page.toLocaleString("en-US")} of {at.count.toLocaleString("en-US")}
    </span>
  );
}

/**
 * The document's own tools on the kind's bar: Share (milestone 31), only on
 * what can be shared, once it has opened. While it opens, a bone holds the
 * bar's place, so the mode and Share arrive without the body moving; a
 * document that could not open draws nothing, and the bar goes. A Word file
 * that becomes a document draws nothing: the item it becomes has the bar. In
 * Pages, "Page 2 of 5" stands at the bar's end, before History.
 */
export function Bar({ item, source, env }: CanvasBodyProps<DocState>) {
  const state = useOpenState(item.id);
  // A mail's attachment is read only and is not shared; a Word file becoming a document has nothing yet.
  if (source.at === "mail" || importsFirst(source) || state === "failed") return null;
  if (state === "opening") return <Skeleton aria-hidden className="h-3 w-30" />;
  return (
    <>
      <ShareButton env={env} source={source} title={item.title} />
      <PageFact itemId={item.id} />
    </>
  );
}

/** A Word, OpenDocument or RTF file becomes a `.tcdoc` first (work/formats, milestone 21); the rest open as they are. */
export function Body(props: CanvasBodyProps<DocState>) {
  if (props.source.at === "mail") return <AttachmentBody {...props} />;
  return importsFirst(props.source) ? <ImportBody {...(props as CanvasBodyProps<unknown>)} /> : <DocBody {...props} />;
}

/**
 * A mail's attachment as a document (work-mail.md "Attachments"): read once into a `.tcdoc` beside the host's copy and
 * shown read only, the item staying the attachment (Download in the bar). Keep as document, in More, makes it his.
 */
function AttachmentBody(props: CanvasBodyProps<DocState>) {
  const { item, env, shell } = props;
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{ source: CanvasSource } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setRead(null);
    // An item's source never changes, so its id is enough: a push that hands a new copy of the item reads nothing again.
    readAttachment(env, { id: item.id, source: item.source }).then(
      (a) => live && setRead({ source: a.source }),
      (err: unknown) => live && setRead({ error: err instanceof Error && err.message ? err.message : "It could not be read" }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, item.id, attempt]);
  useEffect(() => {
    shell.statusLine(read && "error" in read ? { tone: "failed", word: "Couldn't open this document", detail: read.error, action: { label: "Retry", run: () => setAttempt((n) => n + 1) } } : null);
  }, [shell, read]);
  useLayoutEffect(() => {
    if (!read || "error" in read) shell.ready?.(false);
  }, [shell, read]);
  const { id, sessionId } = item;
  const keep = useMemo((): MoreEntry[] => [{ id: "keep", label: "Keep as document", icon: Doc, run: () => keepAsDocument(env, { id, sessionId }) }], [env, id, sessionId]);
  if (!read) return <ItemSkeleton />;
  if ("error" in read) return null;
  return <DocBody {...props} source={read.source} more={keep} />;
}

function DocBody({ item, source, env, state, setState, shell, more: own = NO_MORE }: CanvasBodyProps<DocState> & { more?: MoreEntry[] }) {
  const [attempt, setAttempt] = useState(0);
  const opened = useOpened(env, source, attempt);
  // A Google Doc's own verbs (work/google): Write to Google, Read again, Open in Google.
  const reopen = useCallback(() => setAttempt((n) => n + 1), []);
  const googleMore = useGoogleDoc(env, item, reopen);
  const google = useMemo(() => (own.length ? [...own, ...googleMore] : googleMore), [own, googleMore]);
  // Save as Word to… a folder of his places: a document of a Work workspace, from the pane's More and File → Save as Word to….
  const workspace = useWorkspaceOf(env, item.workspaceId);
  const [wordTo, setWordTo] = useState(false);
  const saveWord = useCallback(() => setWordTo(true), []);
  useEffect(() => {
    shell.statusLine(opened && "error" in opened ? { tone: "failed", word: "Couldn't open this document", detail: opened.error, action: { label: "Retry", run: () => setAttempt((n) => n + 1) } } : null);
  }, [shell, opened]);
  // Before paint, so History and the bone never show for a frame they should not.
  useLayoutEffect(() => {
    const now: OpenState = opened === null ? "opening" : "open" in opened ? "open" : "failed";
    markOpen(item.id, now);
    shell.ready?.(now === "open");
  }, [item.id, opened, shell]);
  useEffect(() => () => markOpen(item.id, null), [item.id]);
  const [root, canvasWidth] = useWidth();
  // Flow or Pages, and Pages' zoom: his own pick for this item, else what the canvas's width says as it opens (a later resize changes nothing).
  const [opens, setOpens] = useState<{ view: DocumentView; zoom: PageZoom } | null>(null);
  useLayoutEffect(() => {
    if (opens === null && canvasWidth > 0) setOpens({ view: openingView(canvasWidth), zoom: openingZoom(canvasWidth) });
  }, [opens, canvasWidth]);
  // A document that was classic when it opened stays in Flow when he styles it: the text never jumps onto sheets under his hands.
  const [classic, setClassic] = useState(false);
  const view = state?.view ?? (classic ? "flow" : (opens?.view ?? "flow"));
  const zoom = state?.zoom ?? opens?.zoom;
  const latestState = useRef(state);
  latestState.current = state;
  const pages = useMemo<PagesWiring>(
    () => ({
      view,
      ...(zoom !== undefined ? { zoom } : {}),
      onView: (next) => setState({ ...latestState.current, view: next }),
      onZoom: (next) => setState({ ...latestState.current, zoom: next }),
      onOpened: (styled) => setClassic(!styled),
    }),
    [view, zoom, setState],
  );
  // Preview is a state of the item: it takes the body, and the editor stays mounted under it, out of reach, with its place kept.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  // The format row is the body's first, unscrolled row (docs/DESIGN.md "Work editors"): the editor draws it into this place.
  const [rowSlot, setRowSlot] = useState<HTMLDivElement | null>(null);
  const [previewing, setPreviewing] = useState<PreviewOn>(false);
  // Each ask is counted: Print… pressed while Preview shows another format, however he got there, opens it on Print anew.
  const [asked, setAsked] = useState(0);
  const showPreview = useCallback((on: PreviewOn) => {
    setPreviewing(on);
    if (on) setAsked((n) => n + 1);
  }, []);
  // A failed open is said once, on the state line with Retry; the body under it stays empty rather than pulse.
  return (
    <DropImport env={env} sessionId={item.sessionId} editor={null}>
      <div ref={root} className="relative flex h-full flex-col">
        <div ref={setSlot} data-doc-preview={previewing || undefined} className={previewing ? "absolute inset-0 z-10" : "hidden"} />
        {/* Its keys are the editor's own while focus is in it (⌘B in the size field is bold, not the sidebar). */}
        <div ref={setRowSlot} data-doc-row data-editor-keys="document" className={previewing ? "invisible flex-none" : "flex-none"} inert={previewing ? true : undefined} />
        <div className={previewing ? "invisible min-h-0 flex-1" : "min-h-0 flex-1"} inert={previewing ? true : undefined}>
          <Scroller scrollTop={state?.scrollTop ?? 0} ready={opened !== null && "open" in opened} onScroll={(scrollTop) => setState({ ...latestState.current, scrollTop })}>
            {(width) =>
              opened === null ? (
                <ItemBones title={<Title text={item.title} />} />
              ) : "open" in opened ? (
                <Opened
                  key={`${opened.host.env}|${opened.open.doc}`}
                  host={opened.host}
                  open={opened.open}
                  shell={shell}
                  width={width}
                  more={google}
                  itemId={item.id}
                  root={root}
                  preview={{ slot, on: previewing, asked, set: showPreview }}
                  rowSlot={rowSlot}
                  pages={pages}
                  {...(workspace ? { onSaveWord: saveWord } : {})}
                />
              ) : null
            }
          </Scroller>
        </div>
        {wordTo && workspace ? (
          <Suspense fallback={null}>
            <SaveAsWordDialog workspace={workspace} source={source} name={item.title} onClose={() => setWordTo(false)} />
          </Suspense>
        ) : null}
      </div>
    </DropImport>
  );
}

/**
 * The scrolling surface, its place kept in the item's state; the text column centred in it, or in Pages the sheets' stage. The kept place comes back
 * once what it scrolls is open (`ready`) and has laid out tall enough to hold it: never over the bones, and never clamped
 * to a shorter page and saved so. A scroll of his own before then ends the wait.
 */
export function Scroller({
  scrollTop,
  ready = true,
  onScroll,
  children,
}: {
  scrollTop: number;
  ready?: boolean;
  onScroll(top: number): void;
  children(width: number): ReactNode;
}) {
  const [ref, width] = useWidth();
  const restored = useRef(scrollTop <= 0);
  const restoring = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (restored.current || !el || !ready) return;
    const restore = (): boolean => {
      if (restored.current) return true;
      if (el.scrollHeight - el.clientHeight < scrollTop) return false;
      restored.current = true;
      restoring.current = true;
      el.scrollTop = scrollTop;
      return true;
    };
    if (restore() || typeof ResizeObserver === "undefined") return;
    // The editor lays out after it mounts: wait for what it draws to grow tall enough.
    const observer = new ResizeObserver(() => {
      if (restore()) observer.disconnect();
    });
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
    // The kept place is read once; later saves of it are his own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div
      ref={ref}
      data-doc-scroller
      // In Pages the sheets' stage fills it edge to edge, on the stage's own ground and padding: said in CSS, so the frame that draws the sheets is the frame that makes room.
      className="h-full overflow-x-hidden overflow-y-auto px-6 pt-8 pb-24 has-[.te-pages-stage]:bg-(--stage) has-[.te-pages-stage]:p-0"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        // A scroll of his own while the kept place waits for room: his place wins.
        if (!restoring.current) restored.current = true;
        restoring.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onScroll(top), 250);
      }}
    >
      {children(width)}
    </div>
  );
}

const NO_MORE: MoreEntry[] = [];

/** Where the body draws Preview, and whether it is up: on the format he last used, or on Print. */
type PreviewOn = false | "last" | "print";
interface PreviewSlot {
  slot: HTMLElement | null;
  on: PreviewOn;
  /** how many times it was asked for: a new ask is a new frame */
  asked: number;
  set(on: PreviewOn): void;
}

/** What the body hands the editor for Pages, and what it hears back. */
export interface PagesWiring {
  view: DocumentView;
  zoom?: PageZoom;
  onView(view: DocumentView): void;
  onZoom(zoom: PageZoom): void;
  /** Told once, when the document has been read: whether it is a styled one (only a styled document is ever drawn in Pages). */
  onOpened(styled: boolean): void;
}

/**
 * Until Pages has gone three frames without laying out again (`data-settles` on the frame,
 * pages/flow.ts), or a second at most: a set-up just changed is drawn before it is printed.
 */
export async function pagesSettled(scope: HTMLElement | null, frames = 3, capMs = 1000): Promise<void> {
  if (typeof requestAnimationFrame === "undefined") return;
  const start = performance.now();
  let last: string | null = null;
  for (let still = 0; still < frames && performance.now() - start < capMs; ) {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    const now = scope?.querySelector<HTMLElement>(".te-pages")?.dataset.settles ?? "";
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

/** The open document: the editor and everything it tells the pane. */
function Opened({
  host,
  open,
  shell,
  width,
  more = NO_MORE,
  itemId,
  root,
  preview,
  rowSlot,
  pages,
  onSaveWord,
}: {
  host: DocHost;
  open: DocOpen;
  shell: CanvasShell;
  width: number;
  more?: MoreEntry[];
  itemId: string;
  root: React.RefObject<HTMLDivElement | null>;
  preview: PreviewSlot;
  rowSlot: HTMLElement | null;
  pages?: PagesWiring;
  /** Save as Word to…: opens the folder picker; absent outside a Work workspace */
  onSaveWord?(): void;
}) {
  const doc = useDocument(host, open);
  const margin = width >= MARGIN_FROM;
  // A tab's close waits until the host has stored what he typed (canvas/flush.ts): a Word file's document is judged by its file next.
  // A send or a store that fails is said, and fails the flush: the close is never told the file holds it.
  const title = open.title;
  useEffect(
    () =>
      registerFlush(itemId, () =>
        host.flush().catch(async (err: unknown) => {
          const toast = await loadToast();
          toast.error(`Couldn't save your last edits to ${title}`);
          throw err;
        }),
      ),
    [itemId, host, title],
  );
  // The editor's handle on a styled document's pages: print writes them, Preview's Page section sets them.
  const pagesHandle = useRef<PagesHandle | null>(null);
  const onDocumentHandle = useCallback((handle: PagesHandle | null) => void (pagesHandle.current = handle), []);

  useEffect(() => {
    shell.mode(
      open.role === "view"
        ? null
        : {
            value: doc.mode,
            ...(open.shared ? { note: "Others can edit this, so changes wait for you" } : { set: (v: DocMode) => void doc.setMode(v) }),
          },
    );
    return () => shell.mode(null);
  }, [shell, open.role, open.shared, doc.mode, doc.setMode]);

  useEffect(() => {
    const w = doc.written;
    shell.written(w ? { text: `${w.text}, ${dayTime(w.at)}`, undo: () => undoWritten(host, open.source, w) } : null);
    return () => shell.written(null);
  }, [shell, doc.written, host, open.source]);

  const [editor, setEditor] = useState<AnyEditor | null>(null);
  const review = useDocReview(host, open, shell, editor);

  // Export… in the pane's More, File → Export… and ⇧⌘E all open Preview on the format he last used; File → Print… and
  // ⌘P open it on Print (work/formats/PreviewFrame.tsx).
  const showPreview = preview.set;
  useEffect(() => {
    shell.more?.([...more, { id: "export", label: "Export…", icon: Export, run: () => showPreview("last") }, ...(onSaveWord ? [{ id: "save-word", label: "Save as Word to…", icon: Doc, run: onSaveWord }] : [])]);
    return () => shell.more?.(null);
  }, [shell, more, showPreview, onSaveWord]);
  // Edit → Find… and ⌘F with the caret in the text open the editor's own find; Replace is in its bar where he may edit.
  const finder = useRef<FindHandle | null>(null);
  const onFind = useCallback((handle: FindHandle | null) => void (finder.current = handle), []);
  useWorkCommands(root, { export: () => showPreview("last"), print: () => showPreview("print"), find: () => finder.current?.open(), ...(onSaveWord ? { save_word: onSaveWord } : {}) });
  // The document went (a tab closed, another opened in its place): its Preview goes with it.
  useEffect(() => () => showPreview(false), [showPreview]);
  // Under Preview the editor draws the document and nothing else: find's tints go here, and the changes in review below.
  // The sheets it holds are what a PDF and a print are made of, and neither carries a mark of the editor's own.
  const previewing = preview.on !== false;
  useEffect(() => {
    if (previewing) finder.current?.close();
  }, [previewing]);

  // What Preview draws: one source for as long as this document is open, reading the editor and the counts as they stand.
  // The document's styles, theme and page set-up as the editor reads them; null for a classic document.
  const [page, setPage] = useState<DocumentPage | null>(null);
  // The editor is handed over once the document is read, its page with it.
  const onOpened = pages?.onOpened;
  const toldOpened = useRef(false);
  useEffect(() => {
    if (!editor || toldOpened.current) return;
    toldOpened.current = true;
    onOpened?.(page !== null);
  }, [editor, page, onOpened]);
  // Drawn as sheets: the bar's fact follows the editor, and goes with the sheets.
  const sheets = pages?.view === "pages" && page !== null;
  const onPages = useCallback((at: PageAt) => tellPage(itemId, at), [itemId]);
  useEffect(() => {
    if (!sheets) tellPage(itemId, null);
  }, [sheets, itemId]);
  useEffect(() => () => tellPage(itemId, null), [itemId]);
  const canSet = open.role === "edit";
  const live = useRef({ editor, suggestions: review.hooks?.count ?? 0, threads: doc.threads, page });
  live.current = { editor, suggestions: review.hooks?.count ?? 0, threads: doc.threads, page };
  const source = useMemo(
    () =>
      docPreviewSource({
        env: host.env,
        source: open.source,
        itemId,
        title: open.title,
        editor: () => live.current.editor,
        styled: () => live.current.page,
        pages: () => {
          const handle = pagesHandle.current;
          if (!handle) return null;
          // A reader prints the pages he sees and sets nothing.
          return { pagesHtml: (options) => handle.pagesHtml(options), settled: () => pagesSettled(root.current), ...(canSet ? { setSetup: (patch) => handle.setSetup(patch) } : {}) };
        },
        // Threads, not marks: a thread over three lines is one comment. One with a second comment has a reply.
        review: () => ({
          comments: new Set(Array.from(live.current.editor?.domElement?.querySelectorAll(".bn-thread-mark") ?? [], (m) => m.getAttribute("data-bn-thread-id") ?? m.textContent)).size,
          replied: (live.current.threads.adapter.rows(open.doc) ?? []).filter((row) => row.comments.length > 1).length,
          suggestions: live.current.suggestions,
        }),
      }),
    [host.env, open.source, open.title, open.doc, itemId, root, canSet],
  );
  const closePreview = (): void => {
    showPreview(false);
    // Back to the words, where the caret was.
    requestAnimationFrame(() => editor?.focus());
  };

  // Through the frame, as the pane's own Ask: the chip goes in, a folded thread unfolds and its composer takes the caret.
  const onAsk = (selection: DocumentSelection): void => shell.ask?.(selectionChip(selection.text, open));

  return (
    // A copy is written as mail clients and sheets read it, after the editor wrote its own (work-kit/formats/clipboard).
    <div onCopy={(e) => mailSafeCopy(e.nativeEvent)} onCut={(e) => mailSafeCopy(e.nativeEvent)}>
      <DocumentFrame
        doc={doc}
        open={open}
        margin={margin}
        onStatus={(status) => shell.statusLine(statusLineOf(status))}
        onPresence={(people) => shell.presence(presenceOf(people))}
        onAsk={onAsk}
        review={previewing ? null : review.state}
        {...(review.pageWords && !previewing ? { pageReview: review.pageWords } : {})}
        onReviewPick={review.pick}
        onEditor={setEditor}
        row={{ into: rowSlot, onPreview: () => showPreview("last"), onPage: setPage }}
        onFind={onFind}
        {...(pages ? { pages: { view: pages.view, ...(pages.zoom !== undefined ? { zoom: pages.zoom } : {}), onView: pages.onView, onZoom: pages.onZoom, onPages, onDocumentHandle, sheets } } : {})}
      />
      {preview.on && preview.slot
        ? createPortal(
            // Print… asked for while it is up on another format moves it to Print: a new frame on that format.
            <Preview key={preview.asked} source={source} title={open.title} kind="document" {...(preview.on === "print" ? { initial: "print" } : {})} readOnly={open.role !== "edit"} onClose={closePreview} />,
            preview.slot,
          )
        : null}
    </div>
  );
}

/** What Undo of an agent's write says when the document changed since: restoring would take those changes too. */
export const CHANGED_SINCE = "Not undone: the document has changed since. Restore an earlier version from History.";

/**
 * The bar's Undo of an agent's write: the version before it is restored only while the live text is still what the
 * write left (its `after` version); once anyone has changed it since, restoring would take their words too, so the
 * line goes and says so, and History keeps every version for a choice of his own.
 */
export async function undoWritten(host: Pick<DocHost, "env" | "dismiss">, source: CanvasSource, w: DocWritten): Promise<void> {
  if (w.after) {
    const { diff } = await registry.linkOf(host.env).request<HistoryCompare>("work.history.compare", { source, from: w.after, to: "live" });
    const { added, removed, changed, moved } = diff.stats;
    if (added + removed + changed + moved > 0 || diff.page?.length) {
      await host.dismiss();
      const toast = await loadToast();
      toast.message(CHANGED_SINCE);
      return;
    }
  }
  await historyActions(host.env, source).restore(w.versionId);
  await host.dismiss();
}

/** A selection as the composer's chip: its first 40 characters in quotes, then the document's name. */
export function selectionChip(text: string, open: Pick<DocOpen, "title" | "source">): ContextChip {
  const words = text.replace(/\s+/g, " ").trim();
  return { kind: "selection", label: `“${words.length > 40 ? `${words.slice(0, 40)}…` : words}”, ${open.title}`, ref: open.source, quote: text };
}

export interface DocumentHandle {
  host: DocHost;
  threads: DocThreads;
  adapters: EditorAdapters;
  mode: DocMode;
  setMode(mode: DocMode): Promise<void>;
  written: DocWritten | null;
}

/** The adapters the shared editor runs on for this document, and what the host pushes about it. */
export function useDocument(host: DocHost, open: DocOpen): DocumentHandle {
  const threads = useMemo(() => docThreads(host, open.doc), [host, open.doc]);
  const [mode, setModeState] = useState<DocMode>(open.mode);
  const [written, setWritten] = useState<DocWritten | null>(open.written);
  const adapters = useMemo<EditorAdapters>(() => {
    const me = { id: open.me, name: open.names[open.me] ?? "You", avatarUrl: null };
    return {
      collab: {
        // The relay ignores the address: the host opens its own service's socket.
        url: `ws://work-docs.invalid/w/doc/${encodeURIComponent(open.doc)}`,
        getToken: () => host.token(),
        offline: `tempcode:${host.env}`,
        socket: host.socket,
      },
      uploads: null,
      threads: threads.adapter,
      identity: {
        me,
        get people() {
          return Object.entries(threads.names()).map(([id, name]) => ({ id, name, avatarUrl: null }));
        },
      },
      links: null,
    };
  }, [host, open.doc, open.me, open.names, threads]);
  useEffect(
    () =>
      host.onPush(open.doc, (push) => {
        if (push.threads) threads.refresh();
        if (push.branches) refreshHistory(host.env, open.source);
        if (push.written !== undefined) setWritten(push.written);
        if (push.mode) setModeState(push.mode);
      }),
    [host, open.doc, open.source, threads],
  );
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const setMode = useMemo(
    () => async (next: DocMode) => {
      // A change the host refused puts back the mode he had before the press, not the one the document opened with.
      const was = modeNow.current;
      setModeState(next);
      try {
        setModeState((await host.mode(next)).mode);
      } catch {
        setModeState(was);
      }
    },
    [host],
  );
  return { host, threads, adapters, mode: open.shared ? "suggests" : mode, setMode, written };
}

/** Pending suggestions, drawn in the text and stepped from the pane's bar. */
export function useDocReview(host: DocHost, open: DocOpen, shell: CanvasShell, editor: AnyEditor | null) {
  const branches = useBranches(host.env, open.source);
  const value = branches.value;
  const { changes, groups } = useMemo(() => reviewOf(value?.branches ?? [], value?.names ?? {}), [value]);
  const actions = useMemo(() => historyActions(host.env, open.source), [host.env, open.source]);
  const decide = (accept: boolean) => async (chosen: ReviewChange[]) => {
    const byBranch = new Map<string, string[]>();
    for (const change of chosen) {
      const { branchId, which } = decided(change);
      byBranch.set(branchId, [...(byBranch.get(branchId) ?? []), which]);
    }
    for (const [branchId, which] of byBranch) await actions.decide(branchId, which, accept, value?.branches.find((b) => b.id === branchId)?.editedAt);
  };
  const review = useReview({ changes, groups, accept: decide(true), reject: decide(false) });
  // The changes are places in the text as it was when they were worked out: asked again once the text
  // settles after a change, which is also how a decision made in another window reaches this one.
  const pending = changes.length > 0;
  const onChange = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refreshHistory(host.env, open.source), 700);
    };
  }, [host.env, open.source]);
  const latest = useRef(review);
  latest.current = review;
  const hooks = review.hooks;
  const groupsKey = hooks?.groups.map((g) => `${g.id}:${g.count}`).join(",") ?? "";
  useEffect(() => {
    // A document he may only view (a mail's attachment, a read-only key) offers nothing to decide: its changes stay tinted in the text.
    if (!latest.current.hooks || open.role === "view") return shell.review(null);
    const h = latest.current.hooks;
    shell.review({
      groups: h.groups.map((g) => ({ id: g.id, label: g.label, by: g.by as Principal, count: g.count })),
      index: h.index,
      count: h.count,
      step: (to) => {
        latest.current.hooks?.step(to);
        // At once: stepping is done many times in a row.
        requestAnimationFrame(() => document.querySelector('[data-page-change="true"], .te-change-current')?.scrollIntoView({ block: "center", behavior: "instant" }));
      },
      accept: (which) => latest.current.hooks?.accept(which) ?? Promise.resolve(),
      reject: (which) => latest.current.hooks?.reject(which) ?? Promise.resolve(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, hooks?.index, hooks?.count, groupsKey, open.role]);
  useEffect(() => () => shell.review(null), [shell]);
  useEffect(() => (editor && pending ? editor.onChange(onChange) : undefined), [editor, pending, onChange]);
  const selected = changes.find((change) => change.id === review.state.current);
  const selectedId = selected ? decided(selected) : null;
  const pageWords = selectedId?.which === PAGE_CHANGE_ID ? value?.branches.find((b) => b.id === selectedId.branchId)?.diff.page : undefined;
  return { ...review, pageWords };
}

/** The text column: its title, then the editor, with the gutter for the block handle and room for the margin. */
export function DocumentFrame({
  doc,
  open,
  margin,
  onStatus,
  onPresence,
  onAsk,
  review,
  pageReview,
  onReviewPick,
  onEditor,
  row,
  onFind,
  pages,
}: {
  doc: DocumentHandle;
  open: DocOpen;
  margin: boolean;
  onStatus?(status: DocumentStatus | null): void;
  onPresence?(people: DocumentPresence[]): void;
  onAsk?(selection: DocumentSelection): void;
  review?: ReturnType<typeof useReview>["state"] | null;
  pageReview?: readonly string[];
  onReviewPick?(id: string): void;
  onEditor?(editor: AnyEditor | null): void;
  /**
   * The format row, on a document he may edit: where the body draws it, its way to Preview, and
   * the document's page for whoever needs it. Left out (the Docs view, a mail's attachment), there
   * is no row; the text is still drawn in the document's own styles.
   */
  row?: { into: HTMLElement | null; onPreview(): void; onPage?(page: DocumentPage | null): void };
  /** Given, the editor has find (and Replace where he may edit) and hands its way to open it; left out, ⌘F stays the app's. */
  onFind?(handle: FindHandle | null): void;
  /**
   * Flow or Pages, held by the body (docs/DESIGN.md "Work editors: Document pages"). `sheets` is
   * the document drawn as sheets: threads then open at their words, not in a margin. Left out, the
   * editor holds its own view.
   */
  pages?: Omit<PagesWiring, "onOpened"> & { sheets: boolean; onPages?(at: PageAt): void; onDocumentHandle?(handle: PagesHandle | null): void };
}) {
  const scheme = useColorScheme();
  const [own, setOwn] = useState<AnyEditor | null>(null);
  const up = useRef(onEditor);
  up.current = onEditor;
  const editorCame = useCallback((editor: AnyEditor | null) => {
    setOwn(editor);
    up.current?.(editor);
  }, []);
  const namesItself = useNamesItself(own, open.title);
  // In Pages the stage is the editor's, edge to edge: no title over the sheets, no 672px measure, no gutter (IN_PAGES, in CSS), and threads at their words.
  const side = margin && !(pages?.sheets ?? false);
  const { view, zoom, onView, onZoom, onPages, onDocumentHandle } = pages ?? {};
  return (
    <EditorKitProvider value={{ theme: scheme, ladder: DOCUMENT_LADDER, fonts: DOC_FONTS }}>
      <EditorAdaptersProvider adapters={doc.adapters}>
        {/* The editor's keys are its own while the caret is here (docs/agents/work-editors.md "Who hears a key"): ⌘B is bold, ⌘K a link. */}
        <div
          data-editor-keys={open.role === "edit" ? "document" : "read"}
          className={`group/doc mx-auto max-w-(--doc-column) ${IN_PAGES.column}`}
          style={{ "--doc-column": `${GUTTER + MEASURE + (side ? MARGIN : 0)}px`, "--doc-gutter": `${GUTTER}px`, "--doc-margin": `${side ? MARGIN : 0}px` } as React.CSSProperties}
        >
          {/* A LifeOS document's title is where he renames it, so it stays; a file's name is not said again over a first line that is that name. */}
          {open.role === "edit" && open.source.at === "lifeos" ? (
            <div style={{ paddingLeft: GUTTER, maxWidth: GUTTER + MEASURE }} className={`mb-4 ${IN_PAGES.title}`}>
              <TitleField text={open.title} rename={doc.host.rename} />
            </div>
          ) : namesItself ? null : (
            <div style={{ paddingLeft: GUTTER, maxWidth: GUTTER + MEASURE }} className={`mb-4 ${IN_PAGES.title}`}>
              <Title text={open.title} />
            </div>
          )}
          <div className={`pr-(--doc-margin) pl-(--doc-gutter) ${IN_PAGES.text}`}>
            {pageReview?.length ? (
              <div className={IN_PAGES.summary}>
                <PageChangeSummary words={pageReview} current />
              </div>
            ) : null}
            <DocumentEditor
              documentName={open.doc}
              editable={open.role === "edit"}
              threadMargin={side ? "side" : undefined}
              // What the serving host can keep: the editor offers nothing of a newer schema (work-docs.md "The schema gate").
              hostSchema={open.schema ?? 0}
              {...(row && open.role === "edit" ? { formatRow: true, formatRowInto: row.into, onPreview: row.onPreview, paper: paperFor(navigator.language) } : {})}
              {...(row?.onPage ? { onPage: row.onPage } : {})}
              {...(onStatus ? { onStatus } : {})}
              {...(onPresence ? { onPresence } : {})}
              {...(onAsk ? { onAsk } : {})}
              review={review ?? null}
              {...(onReviewPick ? { onReviewPick } : {})}
              onEditor={editorCame}
              {...(onFind ? { find: true, onFind } : {})}
              {...(view ? { view } : {})}
              {...(zoom !== undefined ? { zoom } : {})}
              {...(onView ? { onView } : {})}
              {...(onZoom ? { onZoom } : {})}
              {...(onPages ? { onPages } : {})}
              {...(onDocumentHandle ? { onDocumentHandle } : {})}
              title={open.title}
              locale={navigator.language}
            />
          </div>
        </div>
      </EditorAdaptersProvider>
    </EditorKitProvider>
  );
}
