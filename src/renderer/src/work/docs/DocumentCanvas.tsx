import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DOCUMENT_SCHEMA } from "work-kit/collab";
import { createPortal } from "react-dom";
import type { DocMode, DocOpen, DocWritten } from "@shared/contract-work-docs";
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
import type { Draft } from "@shared/work/drafts";
import { loadToast } from "../../components/ui/toaster";
import { itemJournal, type DraftJournal } from "../canvas/drafts";
import { notSavedWords, whenWords } from "../files/fileText";
import { useColorScheme } from "../../hooks/useColorScheme";
import { ItemBones, ItemSkeleton } from "../canvas/ItemBones";
import { OpenFailed } from "../canvas/FetchState";
import { BarHold } from "../canvas/barHold";
import { QuietLine } from "../canvas/QuietLine";
import { PAUSE_MS } from "../canvas/calm";
import { useSaving } from "../canvas/useCalm";
import { hostName } from "../../lib/threadResources";
import type { CanvasBodyProps, CanvasShell, MoreEntry, Presence, SavedLine, WrittenLine } from "../canvas/kind";
import { mailSafeCopy } from "work-kit/formats/clipboard";
import { dayTime } from "../../lib/duration";
import { copyText } from "../../lib/clipboard";
import { useWorkCommands } from "../formats/command";
import { registerFlush } from "../canvas/flush";
import { Preview } from "../formats/PreviewFrame";
import { DropImport, ImportBody, keepAsDocument, readAttachment } from "../formats/Import";
import { importsFirst, paperFor } from "../formats/model";
import { Doc, Export, Share } from "../icons";
import { historyActions, refreshHistory, useBranches } from "../history/store";
import { useGoogleDoc } from "../google/docMore";
import { DOC_FONTS } from "./fonts";
import { docHost, draftWords, savesOf, servedBy, type DocHost, type DocSaves } from "./host";
import { blockFacts, docDrops, docPreviewSource } from "./previewSource";
import { decided, editMovesMarks, markedBlocks, PAGE_CHANGE_ID, reviewOf } from "./review";
import { PageChangeSummary } from "../history/Compare";
import { docThreads, type DocThreads } from "./threads";
import { ShareButton } from "../guests/Share";
import { shareTargetOf } from "../guests/api";
import { openShare } from "../guests/sharePort";
import { useWorkspaceOf } from "../files/workspaceOf";
import { DocSaveControls } from "../files/DocLinks";
import { openSaveAs, tellDrops, useSaveAsAsk } from "../files/saveAsPort";

// Save as Word to…: the Files place's folder picker, loaded on his press.
const SaveAsDialog = lazy(() => import("../files/SaveAs").then((m) => ({ default: m.SaveAsDialog })));

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

/**
 * The editor's sentence for what is wrong, as the pane's one state line. Offline (and waiting to open, which is offline
 * too) asks nothing of him: it is not the pane's line but one quiet sentence laid over the text's top padding
 * (`offlineWords`, `OfflineLine`), so the text never moves when the link blinks.
 */
export function statusLineOf(status: DocumentStatus | null): Parameters<CanvasShell["statusLine"]>[0] {
  if (!status || status.kind === "offline" || status.kind === "waiting") return null;
  const word = { refused: "Read only", unreadable: "Did not open", seed: "Not set up" }[status.kind];
  return {
    tone: status.kind === "refused" ? "quiet" : "failed",
    word,
    detail: status.message,
    ...(status.retry ? { action: { label: "Retry", run: status.retry } } : {}),
  };
}

/** The offline line's words, naming the computer the document is on ("the box", "this Mac"); null while it is not offline. */
export function offlineWords(status: DocumentStatus | null, host: string): { word: string; detail: string } | null {
  if (status?.kind === "offline") return { word: "Offline.", detail: `Edits stay here until ${host} is back.` };
  if (status?.kind === "waiting") return { word: "Offline.", detail: `It opens for editing once ${host} is back.` };
  return null;
}

/**
 * The offline line, in the 32px over the text the scroller keeps as its top padding (`pt-8`): on the page's own ground
 * so text scrolled under it is covered, never pushed. The quiet line's look (docs/DESIGN.md "The state line").
 */
export function OfflineLine({ words }: { words: { word: string; detail: string } }) {
  return (
    <div data-doc-offline className="pointer-events-auto bg-background">
      <QuietLine word={words.word} detail={words.detail} />
    </div>
  );
}

type Opened = { host: DocHost; open: DocOpen } | { error: string } | null;

/** Opens the document on the host the item lives on, or on the host that serves it when that is another. */
/** `itemId`: the item that shows a mail's attachment, which the host finds the document by (host.ts `namedBy`). */
export function useOpened(env: string, source: CanvasSource, attempt: number, itemId?: string): Opened {
  const [opened, setOpened] = useState<Opened>(null);
  // Every canvas push hands a new copy of the item: the source's value, not its object, says it is another document,
  // so a push never reopens the editor under his hands (its caret, find, Preview and the frames it has yet to send).
  const key = JSON.stringify(source);
  const latest = useRef(source);
  latest.current = source;
  // What the last open was asked for: the same document asked again (his Retry) keeps its failure until the answer.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    const what = `${env}\n${key}\n${itemId ?? ""}`;
    const same = asked.current === what;
    asked.current = what;
    setOpened((was) => (same && was && "error" in was ? was : null));
    const tryOn = async (on: string, again: boolean): Promise<void> => {
      const host = docHost(on, latest.current, itemId);
      try {
        // The editor's socket and first token come with the open: the editor's first request is then its first frame.
        const open = await host.open({ schema: DOCUMENT_SCHEMA });
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
  }, [env, key, attempt, itemId]);
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
 * that becomes a document holds the bar's place empty (`BarHold`), never a
 * bone a failed import would leave: the item it becomes has the bar, so the
 * body does not drop 32px when it lands. In Pages, "Page 2 of 5" stands at
 * the bar's end, before History.
 */
export function Bar({ item, source, env }: CanvasBodyProps<DocState>) {
  const state = useOpenState(item.id);
  const workspace = useWorkspaceOf(env, item.workspaceId);
  // A Word file becoming a document has nothing yet, but the document it becomes has a bar.
  if (importsFirst(source) && source.at !== "mail") return <BarHold />;
  // A mail's attachment is read only and is not shared.
  if (source.at === "mail" || state === "failed") return null;
  if (state === "opening") return <Skeleton aria-hidden className="h-3 w-30" />;
  return (
    <>
      {workspace ? <DocSaveControls workspace={workspace} source={source} itemId={item.id} /> : null}
      <ShareButton env={env} source={source} kind="document" title={item.title} itemId={item.id} workspaceId={item.workspaceId} purdue={workspace?.sector === "purdue"} />
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
  const [read, setRead] = useState<{ source: CanvasSource } | { error: string } | null>(null);
  // The read in hand: the effect's, and his Retry's, which keeps the failure until it answers.
  const readNow = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    let live = true;
    setRead(null);
    // An item's source never changes, so its id is enough: a push that hands a new copy of the item reads nothing again.
    const ask = (): Promise<void> =>
      readAttachment(env, { id: item.id, source: item.source }).then(
        (a) => void (live && setRead({ source: a.source })),
        (err: unknown) => void (live && setRead({ error: err instanceof Error && err.message ? err.message : "It could not be read" })),
      );
    readNow.current = ask;
    void ask();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, item.id]);
  useLayoutEffect(() => {
    if (!read || "error" in read) shell.ready?.(false);
  }, [shell, read]);
  const { id, sessionId } = item;
  const keep = useMemo((): MoreEntry[] => [{ id: "keep", label: "Keep as document", icon: Doc, run: () => keepAsDocument(env, { id, sessionId }) }], [env, id, sessionId]);
  if (!read) return <ItemSkeleton />;
  if ("error" in read) return <OpenFailed kind="document" why={read.error} onRetry={() => readNow.current()} />;
  return <DocBody {...props} source={read.source} more={keep} />;
}

function DocBody({ item, source, env, state, setState, shell, more: own = NO_MORE }: CanvasBodyProps<DocState> & { more?: MoreEntry[] }) {
  const [attempt, setAttempt] = useState(0);
  const opened = useOpened(env, source, attempt, item.id);
  // A Google Doc's own verbs (work/google): Write to Google, Read again, Open in Google. Its promise settles once the
  // open it asked answers, so a Retry spins until then.
  const waiting = useRef<(() => void)[]>([]);
  const reopen = useCallback(
    (): Promise<void> =>
      new Promise<void>((done) => {
        waiting.current.push(done);
        setAttempt((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    for (const done of waiting.current.splice(0)) done();
  }, [opened]);
  const googleMore = useGoogleDoc(env, item, reopen);
  const google = useMemo(() => (own.length ? [...own, ...googleMore] : googleMore), [own, googleMore]);
  // Save As…: a document of a Work workspace, from the header, the pane's More and File → Save As… (⇧⌘S).
  const workspace = useWorkspaceOf(env, item.workspaceId);
  // One journal for the item's life (canvas/drafts.ts): its document's unapplied updates are kept under it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const journal = useMemo(() => itemJournal(env, item), [env, item.id]);
  const savingAs = useSaveAsAsk(item.id);
  const saveAs = useCallback(() => openSaveAs(item.id), [item.id]);
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
  const [lineSlot, setLineSlot] = useState<HTMLDivElement | null>(null);
  const [previewing, setPreviewing] = useState<PreviewOn>(false);
  // Each ask is counted: Print… pressed while Preview shows another format, however he got there, opens it on Print anew.
  const [asked, setAsked] = useState(0);
  const showPreview = useCallback((on: PreviewOn) => {
    setPreviewing(on);
    if (on) setAsked((n) => n + 1);
  }, []);
  // A failed open is said once, centred with Retry, in the body's place (`OpenFailed`).
  if (opened && "error" in opened) return <OpenFailed kind="document" why={opened.error} onRetry={reopen} />;
  return (
    <DropImport env={env} sessionId={item.sessionId} editor={null}>
      <div ref={root} className="relative flex h-full flex-col">
        <div ref={setSlot} data-doc-preview={previewing || undefined} className={previewing ? "absolute inset-0 z-10" : "hidden"} />
        {/* Its keys are the editor's own while focus is in it (⌘B in the size field is bold, not the sidebar). */}
        <div ref={setRowSlot} data-doc-row data-editor-keys="document" className={previewing ? "invisible flex-none" : "flex-none"} inert={previewing ? true : undefined} />
        <div className={previewing ? "invisible relative min-h-0 flex-1" : "relative min-h-0 flex-1"} inert={previewing ? true : undefined}>
          {/* Where the offline line is laid: over the scroller's top padding, out of the text's flow. */}
          <div ref={setLineSlot} className="pointer-events-none absolute inset-x-0 top-0 z-10" />
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
                  journal={journal}
                  root={root}
                  preview={{ slot, on: previewing, asked, set: showPreview }}
                  rowSlot={rowSlot}
                  lineSlot={lineSlot}
                  pages={pages}
                  {...(workspace ? { onSaveAs: saveAs } : {})}
                  shareable={!!shareTargetOf(source, "document")}
                />
              ) : null
            }
          </Scroller>
        </div>
        {savingAs && workspace ? (
          <Suspense fallback={null}>
            <SaveAsDialog workspace={workspace} source={source} title={item.title} itemId={item.id} format={savingAs.format} />
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
  journal,
  root,
  preview,
  rowSlot,
  lineSlot = null,
  pages,
  onSaveAs,
  shareable = false,
}: {
  host: DocHost;
  open: DocOpen;
  shell: CanvasShell;
  width: number;
  more?: MoreEntry[];
  itemId: string;
  /** where his updates the service has not applied are kept on this computer; null where there is no store */
  journal?: DraftJournal | null;
  root: React.RefObject<HTMLDivElement | null>;
  preview: PreviewSlot;
  rowSlot: HTMLElement | null;
  /** where the offline line is laid, over the text's top padding */
  lineSlot?: HTMLElement | null;
  pages?: PagesWiring;
  /** Save as Word to…: opens the folder picker; absent outside a Work workspace */
  onSaveAs?(): void;
  /** Share answers this document (its header's Share, More's Share… and File → Share… open one sheet) */
  shareable?: boolean;
}) {
  const doc = useDocument(host, open);
  const [offline, setOffline] = useState<{ word: string; detail: string } | null>(null);
  const offering = useDocDrafts(host, journal ?? null, shell);
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
    shell.written(w ? writtenLine(host, open.source, w) : null);
    return () => shell.written(null);
  }, [shell, doc.written, host, open.source]);

  const [editor, setEditor] = useState<AnyEditor | null>(null);
  const review = useDocReview(host, open, shell, editor);

  // Export… in the pane's More, File → Export… and ⇧⌘E all open Preview on the format he last used; File → Print… and
  // ⌘P open it on Print (work/formats/PreviewFrame.tsx).
  const showPreview = preview.set;
  useEffect(() => {
    shell.more?.([
      ...more,
      { id: "export", label: "Export…", icon: Export, run: () => showPreview("last") },
      ...(onSaveAs ? [{ id: "save-as", label: "Save As…", icon: Doc, run: onSaveAs }] : []),
      ...(shareable ? [{ id: "share", label: "Share…", icon: Share, run: () => openShare(itemId) }] : []),
    ]);
    return () => shell.more?.(null);
  }, [shell, more, showPreview, onSaveAs, shareable, itemId]);
  // Edit → Find… and ⌘F with the caret in the text open the editor's own find; Replace is in its bar where he may edit.
  const finder = useRef<FindHandle | null>(null);
  const onFind = useCallback((handle: FindHandle | null) => void (finder.current = handle), []);
  useWorkCommands(root, {
    export: () => showPreview("last"),
    print: () => showPreview("print"),
    find: () => finder.current?.open(),
    ...(onSaveAs ? { save_word: onSaveAs } : {}),
    ...(shareable ? { share: () => openShare(itemId) } : {}),
  });
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
        ...(canSet ? { sync: host.sync } : {}),
        styled: () => live.current.page,
        pages: () => {
          const handle = pagesHandle.current;
          if (!handle) return null;
          // A reader prints the pages he sees and sets nothing.
          return { pagesHtml: (options) => handle.pagesHtml(options), settled: () => pagesSettled(root.current), ...(canSet ? { setSetup: (patch) => handle.setSetup(patch) } : {}) };
        },
        // Threads, not marks: a thread over three lines is one comment. One with a second comment has a reply.
        review: (count) => ({
          comments: count(() => new Set(Array.from(live.current.editor?.domElement?.querySelectorAll(".bn-thread-mark") ?? [], (m) => m.getAttribute("data-bn-thread-id") ?? m.textContent)).size, 0),
          replied: count(() => (live.current.threads.adapter.rows(open.doc) ?? []).filter((row) => count(() => Array.isArray(row?.comments) && row.comments.length > 1, false)).length, 0),
          suggestions: live.current.suggestions,
        }),
      }),
    [host.env, open.source, open.title, open.doc, itemId, root, canSet],
  );
  // Save As…'s one line of what each format drops, counted as Preview counts it (previewSource.ts `docDrops`).
  useEffect(() => {
    tellDrops(itemId, (format) => {
      // A count is a hint: one that fails says nothing rather than stop the sheet.
      try {
        const review = {
          comments: new Set(Array.from(live.current.editor?.domElement?.querySelectorAll(".bn-thread-mark") ?? [], (m) => m.getAttribute("data-bn-thread-id") ?? m.textContent)).size,
          replied: (live.current.threads.adapter.rows(open.doc) ?? []).filter((row) => row.comments.length > 1).length,
          suggestions: live.current.suggestions,
        };
        return docDrops(format, { ...blockFacts((live.current.editor?.document ?? []) as readonly unknown[]), ...review });
      } catch {
        return [];
      }
    });
    return () => tellDrops(itemId, null);
  }, [itemId, open.doc]);
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
        onStatus={(status) => {
          shell.statusLine(statusLineOf(status));
          setOffline(offlineWords(status, hostName(host.env)));
        }}
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
      <DocSaved host={host} shell={shell} on={open.role === "edit" && !offering} />
      {offline && lineSlot ? createPortal(<OfflineLine words={offline} />, lineSlot) : null}
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
 * The bar's line for an agent's write. Its Undo asks the host, which restores the version before the write only while
 * the document is still what the write left (its `after` version), the check and the restore in one turn of the
 * document: once anyone has changed it since, restoring would take their words too, so the line goes and says so, and
 * History keeps every version for a choice of his own. A host that names no `after` is offered no Undo.
 */
export function writtenLine(host: Pick<DocHost, "env" | "undo">, source: CanvasSource, w: DocWritten): WrittenLine {
  const line = { text: `${w.text}, ${dayTime(w.at)}`, words: w.text, at: w.at };
  const after = w.after;
  return after ? { ...line, undo: () => undoWritten(host, source, after) } : line;
}

/** What Undo says when the document's host is a release behind and cannot undo it there. */
export const UNDO_ELSEWHERE = "Not undone here. Restore an earlier version from History.";

export async function undoWritten(host: Pick<DocHost, "env" | "undo">, source: CanvasSource, after: string): Promise<void> {
  const got = await host.undo(after);
  refreshHistory(host.env, source);
  if (got === "undone") return;
  const toast = await loadToast();
  toast.message(got === "unknown" ? UNDO_ELSEWHERE : CHANGED_SINCE);
}

/** A selection as the composer's chip: its first 40 characters in quotes, then the document's name. */
export function selectionChip(text: string, open: Pick<DocOpen, "title" | "source">): ContextChip {
  const words = text.replace(/\s+/g, " ").trim();
  return { kind: "selection", label: `“${words.length > 40 ? `${words.slice(0, 40)}…` : words}”, ${open.title}`, ref: open.source, quote: text };
}

/**
 * A document's drafts (docs/agents/work-files.md "Drafts survive a crash"): the updates the service has not said it
 * applied are kept on this computer as they are sent (host.ts `keepDrafts`), under this open's own base so an earlier
 * draft is never written over; as it opens, the newest unclaimed one is offered in the save line. Restore sends its
 * updates up the open socket as his edits go and lays them on the editor's document: Yjs merges them with what the file
 * holds now, so what changed since is kept beside them, never written over. Discard lets it go. A draft made on a
 * document that was made again since (its updates hang from text it no longer has) is not sent, where Yjs would hold
 * it unseen: its record stays, and the line offers Copy Edits, his typed words on the clipboard, beside Discard.
 */
export function useDocDrafts(host: DocHost, journal: DraftJournal | null, shell: CanvasShell): boolean {
  const [offer, setOffer] = useState<Draft | null>(null);
  // Restore found the document made again since the draft: it can only be copied out, or let go.
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!journal || !host.keepDrafts) return;
    let live = true;
    // This open's base: unique, so the draft offered below stays as it is while he edits.
    const base = `open-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    host.keepDrafts({ keep: (frames) => journal.keep(base, { kind: "document", frames: [...frames] }), clear: () => journal.clear() });
    void journal.offered("document").then((found) => live && setOffer(found[0] ?? null));
    return () => {
      live = false;
      host.keepDrafts?.(null);
      // Gone with updates the service has not applied: they are offered when the document opens again.
      journal.release();
    };
  }, [host, journal]);
  useEffect(() => {
    if (!offer || !shell.saved || offer.body.kind !== "document") return;
    const frames = offer.body.frames;
    const restore = {
      id: "restore",
      label: "Restore",
      run: () => {
        // Sent again, they are kept under this open's base until applied; the old record goes only once they are on their way.
        const got = host.replay?.(frames) ?? "later";
        if (got === "sent") {
          journal?.drop(offer);
          setOffer(null);
        } else if (got === "changed") setChanged(true);
        else void loadToast().then((toast) => toast.error("The document is not connected yet. Try Restore again in a moment"));
      },
    };
    const copy = { id: "copy", label: "Copy Edits", run: () => void copyText(draftWords(frames)) };
    shell.saved({
      state: "conflict",
      detail: changed ? `Edits from ${whenWords(offer.at)} were not saved. The document changed since` : `Edits from ${whenWords(offer.at)} were not saved`,
      actions: [changed ? copy : restore, { id: "discard", label: "Discard", run: () => (journal?.drop(offer), setOffer(null)) }],
    });
    return () => shell.saved?.(null);
  }, [offer, changed, shell, host, journal]);
  return offer?.body.kind === "document";
}

/**
 * A document's save line (docs/agents/work-docs.md "The save line"): Saved with the service's own time for its last
 * store that held every edit sent before it; saving while his edits wait for one; a store the service refused, in its
 * words, with Retry. Before he edits it says nothing, and the frame names where the file is kept.
 */
export function docSavedLine(saves: DocSaves, retry: () => void, saving = saves.edited !== null || saves.asked !== null): SavedLine | null {
  if (saves.failed) return { state: "conflict", detail: notSavedWords(saves.failed), actions: [{ id: "retry", label: "Retry", run: retry }] };
  if (saving) return { state: "saving" };
  return saves.storedAt !== null ? { state: "saved", at: saves.storedAt } : null;
}

/** Feeds the save line from the socket's save facts, where he edits and no kept draft is offered (that line is the draft's). */
/** The save line's feed as a part of its own that draws nothing: its facts move with every keystroke, and the text around it is not drawn again for them. */
export function DocSaved({ host, shell, on }: { host: Pick<DocHost, "socket">; shell: CanvasShell; on: boolean }): null {
  useDocSaved(host, shell, on);
  return null;
}

/** How finely a document's line tells the frame when he last edited (a Word file's pause reads it): twice a second at most. */
const EDITED_STEP_MS = 500;

export function useDocSaved(host: Pick<DocHost, "socket">, shell: CanvasShell, on: boolean): void {
  const saves = useMemo(() => savesOf(host.socket), [host.socket]);
  const facts = useSyncExternalStore(saves.listen, saves.now, saves.now);
  // Saving… once a store has been asked a while, or edits waited past the pause with none asked (canvas/calm.ts).
  const saving = useSaving({ edited: facts && facts.asked === null ? facts.edited : null, pause: PAUSE_MS.document, sent: facts?.asked ?? null });
  // When he last edited, for a Word file's own pause (FileTabView.tsx): told in half-second steps, not per keystroke.
  const edited = facts?.edited != null ? facts.edited - (facts.edited % EDITED_STEP_MS) : null;
  const present = facts !== null;
  const storedAt = facts?.storedAt ?? null;
  const failed = facts?.failed ?? null;
  // The line by value: the same facts told again say nothing new.
  const line = useMemo((): SavedLine | null => {
    if (!on || !present) return null;
    const said = docSavedLine({ edited: null, asked: null, storedAt, failed }, saves.retry, saving);
    return said && said.state !== "conflict" && edited !== null ? { ...said, edited } : said;
  }, [on, present, storedAt, failed, saving, edited, saves]);
  useEffect(() => {
    if (!on || !shell.saved) return;
    shell.saved(line);
    return () => shell.saved?.(null);
  }, [shell, on, line]);
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
  const branches = useBranches(host.env, open.source, host.itemId);
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
  // The changes are places in a block's words as the host last read them: asked again on the host's push
  // (useDocument), on his decision (historyActions), and once the text settles after an edit inside a marked block,
  // his own or another window's (an Accept there changes the block here). An edit elsewhere moves no mark, so a pause
  // in his typing is no round trip over the link.
  const pending = changes.length > 0;
  const marked = useMemo(() => markedBlocks(changes), [changes]);
  const onChange = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (_editor: unknown, context?: { getChanges?(): readonly { block: { id: string } }[] }) => {
      if (!editMovesMarks(context?.getChanges?.() ?? null, marked)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refreshHistory(host.env, open.source), 700);
    };
  }, [host.env, open.source, marked]);
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
