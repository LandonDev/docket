import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DocMode, DocOpen, DocWritten } from "@shared/contract-work-docs";
import type { CanvasSource, Principal } from "@shared/work";
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
import { useColorScheme } from "../../hooks/useColorScheme";
import { dayTime } from "../../lib/duration";
import { addContextChip } from "../canvas/chips";
import type { CanvasBodyProps, CanvasShell, Presence } from "../canvas/kind";
import { mailSafeCopy } from "work-kit/formats/clipboard";
import { ExportDialog } from "../formats/ExportDialog";
import { DropImport, ImportBody } from "../formats/Import";
import { importsFirst } from "../formats/model";
import { Export } from "../icons";
import { historyActions, refreshHistory, useBranches } from "../history/store";
import { docHost, servedBy, type DocHost } from "./host";
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

/** The document's name in its title step, and the editor's bones while it opens. */
function Loading({ title }: { title: string | null }) {
  return (
    <div aria-busy className="flex flex-col gap-2.5" style={{ paddingLeft: GUTTER, maxWidth: GUTTER + MEASURE }}>
      {title ? <Title text={title} /> : <Skeleton className="h-3 w-1/3" />}
      <Skeleton className="mt-4 h-3 w-[92%]" />
      <Skeleton className="h-3 w-[78%]" />
      <Skeleton className="h-3 w-[44%]" />
    </div>
  );
}

const TITLE_STYLE = { fontSize: DOCUMENT_LADDER.title.size, lineHeight: `${DOCUMENT_LADDER.title.leading}px`, fontWeight: DOCUMENT_LADDER.title.weight };

function Title({ text }: { text: string }) {
  return (
    <h1 className="text-foreground [text-wrap:balance]" style={TITLE_STYLE}>
      {text}
    </h1>
  );
}

/** A LifeOS document's title, renamed in place: Enter or leaving the field keeps it, Escape puts it back. */
function TitleField({ text, rename }: { text: string; rename(title: string): Promise<void> }) {
  const [value, setValue] = useState(text);
  const [kept, setKept] = useState(text);
  const keep = async (): Promise<void> => {
    const next = value.trim();
    if (!next || next === kept) return setValue(kept);
    setKept(next);
    try {
      await rename(next);
    } catch {
      setKept(kept);
      setValue(kept);
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
      className="w-full truncate bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
      style={TITLE_STYLE}
    />
  );
}

/** The document's own tools on the kind's bar: Share (milestone 31). */
export function Bar({ item, source, env }: CanvasBodyProps<DocState>) {
  return <ShareButton env={env} source={source} title={item.title} />;
}

/** A Word, OpenDocument or RTF file becomes a `.tcdoc` first (work/formats, milestone 21); the rest open as they are. */
export function Body(props: CanvasBodyProps<DocState>) {
  return importsFirst(props.source) ? <ImportBody {...(props as CanvasBodyProps<unknown>)} /> : <DocBody {...props} />;
}

function DocBody({ item, source, env, state, setState, shell }: CanvasBodyProps<DocState>) {
  const [attempt, setAttempt] = useState(0);
  const opened = useOpened(env, source, attempt);
  useEffect(() => {
    shell.statusLine(opened && "error" in opened ? { tone: "failed", word: "Did not open", detail: opened.error, action: { label: "Retry", run: () => setAttempt((n) => n + 1) } } : null);
  }, [shell, opened]);
  return (
    <DropImport env={env} sessionId={item.sessionId} editor={null}>
      <Scroller scrollTop={state?.scrollTop ?? 0} onScroll={(scrollTop) => setState({ ...state, scrollTop })}>
        {(width) =>
          opened && "open" in opened ? (
            <Opened key={`${opened.host.env}|${opened.open.doc}`} host={opened.host} open={opened.open} shell={shell} width={width} sessionId={item.sessionId} />
          ) : (
            <Loading title={opened ? null : item.title} />
          )
        }
      </Scroller>
    </DropImport>
  );
}

/** The scrolling surface, its place kept in the item's state; the text column centred in it. */
export function Scroller({ scrollTop, onScroll, children }: { scrollTop: number; onScroll(top: number): void; children(width: number): ReactNode }) {
  const [ref, width] = useWidth();
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !ref.current) return;
    restored.current = true;
    ref.current.scrollTop = scrollTop;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div
      ref={ref}
      data-doc-scroller
      className="h-full overflow-x-hidden overflow-y-auto px-6 pt-8 pb-24"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onScroll(top), 250);
      }}
    >
      {children(width)}
    </div>
  );
}

/** The open document: the editor and everything it tells the pane. */
function Opened({ host, open, shell, width, sessionId }: { host: DocHost; open: DocOpen; shell: CanvasShell; width: number; sessionId: string }) {
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

  // The document's own verb in the pane's More: Export, a dialog with one choice (work/formats).
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    shell.more?.([{ id: "export", label: "Export…", icon: Export, run: () => setExporting(true) }]);
    return () => shell.more?.(null);
  }, [shell]);

  const onAsk = (selection: DocumentSelection): void => {
    const words = selection.text.replace(/\s+/g, " ").trim();
    addContextChip(sessionId, { kind: "selection", label: `“${words.length > 40 ? `${words.slice(0, 40)}…` : words}”, ${open.title}`, ref: open.source, quote: selection.text });
    window.getSelection()?.removeAllRanges();
    // The composer takes the caret, as the pane's own Ask does.
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-chat] [data-composer-input]")?.focus());
  };

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
      {exporting ? (
        <ExportDialog target={{ env: host.env, source: open.source, title: open.title, editor, suggestions: review.hooks?.count ?? 0 }} onClose={() => setExporting(false)} />
      ) : null}
    </div>
  );
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
function useDocReview(host: DocHost, open: DocOpen, shell: CanvasShell, editor: AnyEditor | null) {
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
    if (!latest.current.hooks) return shell.review(null);
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
  }, [shell, hooks?.index, hooks?.count, groupsKey]);
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
        <div className="mx-auto" style={{ maxWidth: GUTTER + MEASURE + (margin ? MARGIN : 0) }}>
          <div style={{ paddingLeft: GUTTER, maxWidth: GUTTER + MEASURE }} className="mb-4">
            {open.role === "edit" && open.source.at === "lifeos" ? <TitleField text={open.title} rename={doc.host.rename} /> : <Title text={open.title} />}
          </div>
          <div className="[--link:var(--accent)]" style={{ paddingLeft: GUTTER, paddingRight: margin ? MARGIN : 0 }}>
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
