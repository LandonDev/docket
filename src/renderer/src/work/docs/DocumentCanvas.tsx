import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  type DocumentStatus,
  type EditorAdapters,
  type ReviewChange,
} from "work-kit/editor";
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { useColorScheme } from "../../hooks/useColorScheme";
import { dayTime } from "../../lib/duration";
import { ItemBones, ItemSkeleton } from "../canvas/ItemBones";
import type { CanvasBodyProps, CanvasShell, MoreEntry, Presence } from "../canvas/kind";
import { mailSafeCopy } from "work-kit/formats/clipboard";
import { useWorkCommands } from "../formats/command";
import { Preview } from "../formats/PreviewFrame";
import { DropImport, ImportBody, keepAsDocument, readAttachment } from "../formats/Import";
import { importsFirst } from "../formats/model";
import { Doc, Export } from "../icons";
import { historyActions, refreshHistory, useBranches } from "../history/store";
import { useGoogleDoc } from "../google/docMore";
import { docHost, servedBy, type DocHost } from "./host";
import { docPreviewSource } from "./previewSource";
import { decided, reviewOf } from "./review";
import { docThreads, type DocThreads } from "./threads";
import { ShareButton } from "../guests/Share";

/**
 * The document kind's body (docs/agents/work-docs.md; the approved
 * prototype, .temp-code/prototypes/work-workspaces-2/doc.html): the shared
 * block editor on a LifeOS document or a `.tcdoc`, live with everyone who
 * has it open. Suggestions are tinted in the text and stepped from the bar;
 * comment threads float at their words, and move to the margin once the
 * canvas has room for the text and 296px beside it (the thread folded). The
 * mode, presence, the state line and the agent's last write go to the pane.
 * The Docs view draws the same surface with no pane around it.
 */

export interface DocState {
  scrollTop?: number;
}

/** The text's measure, the block handle's gutter, and the margin column (24px gap + 272px card). */
const MEASURE = 672;
const GUTTER = 52;
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
  useEffect(() => {
    let live = true;
    setOpened(null);
    const tryOn = async (on: string, again: boolean): Promise<void> => {
      const host = docHost(on, source);
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
  }, [env, source, attempt]);
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

/**
 * The document's own tools on the kind's bar: Share (milestone 31), only on
 * what can be shared, once it has opened. While it opens, a bone holds the
 * bar's place, so the mode and Share arrive without the body moving; a
 * document that could not open draws nothing, and the bar goes. A Word file
 * that becomes a document draws nothing: the item it becomes has the bar.
 */
export function Bar({ item, source, env }: CanvasBodyProps<DocState>) {
  const state = useOpenState(item.id);
  // A mail's attachment is read only and is not shared; a Word file becoming a document has nothing yet.
  if (source.at === "mail" || importsFirst(source) || state === "failed") return null;
  if (state === "opening") return <Skeleton aria-hidden className="h-3 w-30" />;
  return <ShareButton env={env} source={source} title={item.title} />;
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
  // Preview is a state of the item: it takes the body, and the editor stays mounted under it, out of reach, with its place kept.
  const root = useRef<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
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
      <div ref={root} className="relative h-full">
        <div ref={setSlot} data-doc-preview={previewing || undefined} className={previewing ? "absolute inset-0 z-10" : "hidden"} />
        <div className={previewing ? "invisible h-full" : "h-full"} inert={previewing ? true : undefined}>
          <Scroller scrollTop={state?.scrollTop ?? 0} ready={opened !== null && "open" in opened} onScroll={(scrollTop) => setState({ ...state, scrollTop })}>
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
                />
              ) : null
            }
          </Scroller>
        </div>
      </div>
    </DropImport>
  );
}

/**
 * The scrolling surface, its place kept in the item's state; the text column centred in it. The kept place comes back
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
      className="h-full overflow-x-hidden overflow-y-auto px-6 pt-8 pb-24"
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
}: {
  host: DocHost;
  open: DocOpen;
  shell: CanvasShell;
  width: number;
  more?: MoreEntry[];
  itemId: string;
  root: React.RefObject<HTMLDivElement | null>;
  preview: PreviewSlot;
}) {
  const doc = useDocument(host, open);
  const margin = width >= MARGIN_FROM;

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
    shell.written(
      w
        ? {
            text: `${w.text}, ${dayTime(w.at)}`,
            undo: async () => {
              await historyActions(host.env, open.source).restore(w.versionId);
              await host.dismiss();
            },
          }
        : null,
    );
    return () => shell.written(null);
  }, [shell, doc.written, host, open.source]);

  const [editor, setEditor] = useState<AnyEditor | null>(null);
  const review = useDocReview(host, open, shell, editor);

  // Export… in the pane's More, File → Export… and ⇧⌘E all open Preview on the format he last used; File → Print… and
  // ⌘P open it on Print (work/formats/PreviewFrame.tsx).
  const showPreview = preview.set;
  useEffect(() => {
    shell.more?.([...more, { id: "export", label: "Export…", icon: Export, run: () => showPreview("last") }]);
    return () => shell.more?.(null);
  }, [shell, more, showPreview]);
  useWorkCommands(root, { export: () => showPreview("last"), print: () => showPreview("print") });
  // The document went (a tab closed, another opened in its place): its Preview goes with it.
  useEffect(() => () => showPreview(false), [showPreview]);

  // What Preview draws: one source for as long as this document is open, reading the editor and the counts as they stand.
  const live = useRef({ editor, suggestions: review.hooks?.count ?? 0, threads: doc.threads });
  live.current = { editor, suggestions: review.hooks?.count ?? 0, threads: doc.threads };
  const source = useMemo(
    () =>
      docPreviewSource({
        env: host.env,
        source: open.source,
        itemId,
        title: open.title,
        editor: () => live.current.editor,
        // Threads, not marks: a thread over three lines is one comment. One with a second comment has a reply.
        review: () => ({
          comments: new Set(Array.from(live.current.editor?.domElement?.querySelectorAll(".bn-thread-mark") ?? [], (m) => m.getAttribute("data-bn-thread-id") ?? m.textContent)).size,
          replied: (live.current.threads.adapter.rows(open.doc) ?? []).filter((row) => row.comments.length > 1).length,
          suggestions: live.current.suggestions,
        }),
      }),
    [host.env, open.source, open.title, open.doc, itemId],
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
        review={review.state}
        onReviewPick={review.pick}
        onEditor={setEditor}
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
  const setMode = useMemo(
    () => async (next: DocMode) => {
      setModeState(next);
      try {
        setModeState((await host.mode(next)).mode);
      } catch {
        setModeState(open.mode);
      }
    },
    [host, open.mode],
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
    for (const [branchId, which] of byBranch) await actions.decide(branchId, which, accept);
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
        requestAnimationFrame(() => document.querySelector(".te-change-current")?.scrollIntoView({ block: "center", behavior: "instant" }));
      },
      accept: (which) => latest.current.hooks?.accept(which) ?? Promise.resolve(),
      reject: (which) => latest.current.hooks?.reject(which) ?? Promise.resolve(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, hooks?.index, hooks?.count, groupsKey, open.role]);
  useEffect(() => () => shell.review(null), [shell]);
  useEffect(() => (editor && pending ? editor.onChange(onChange) : undefined), [editor, pending, onChange]);
  return review;
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
  onReviewPick,
  onEditor,
}: {
  doc: DocumentHandle;
  open: DocOpen;
  margin: boolean;
  onStatus?(status: DocumentStatus | null): void;
  onPresence?(people: DocumentPresence[]): void;
  onAsk?(selection: DocumentSelection): void;
  review?: ReturnType<typeof useReview>["state"] | null;
  onReviewPick?(id: string): void;
  onEditor?(editor: AnyEditor | null): void;
}) {
  const scheme = useColorScheme();
  return (
    <EditorKitProvider value={{ theme: scheme, ladder: DOCUMENT_LADDER }}>
      <EditorAdaptersProvider adapters={doc.adapters}>
        {/* The editor's keys are its own while the caret is here (docs/agents/work-editors.md "Who hears a key"): ⌘B is bold, ⌘K a link. */}
        <div data-editor-keys={open.role === "edit" ? "document" : "read"} className="mx-auto" style={{ maxWidth: GUTTER + MEASURE + (margin ? MARGIN : 0) }}>
          <div style={{ paddingLeft: GUTTER, maxWidth: GUTTER + MEASURE }} className="mb-4">
            {open.role === "edit" && open.source.at === "lifeos" ? <TitleField text={open.title} rename={doc.host.rename} /> : <Title text={open.title} />}
          </div>
          <div style={{ paddingLeft: GUTTER, paddingRight: margin ? MARGIN : 0 }}>
            <DocumentEditor
              documentName={open.doc}
              editable={open.role === "edit"}
              threadMargin={margin ? "side" : undefined}
              {...(onStatus ? { onStatus } : {})}
              {...(onPresence ? { onPresence } : {})}
              {...(onAsk ? { onAsk } : {})}
              review={review ?? null}
              {...(onReviewPick ? { onReviewPick } : {})}
              {...(onEditor ? { onEditor } : {})}
            />
          </div>
        </div>
      </EditorAdaptersProvider>
    </EditorKitProvider>
  );
}
