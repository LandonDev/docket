import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DOCUMENT_SCHEMA } from "work-kit/collab";
import { DOCUMENT_LADDER, DocumentEditor, EditorAdaptersProvider, EditorKitProvider, type DocumentPage, type DocumentPresence, type DocumentStatus, type DocumentView, type EditorAdapters, type PageZoom } from "work-kit/editor";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { DOC_FONTS } from "@renderer/work/docs/fonts";
import { Comment } from "@renderer/work/icons";
import { openingView, openingZoom, PAGES_FROM } from "./opening";
import { afterRevoked, watchedSocket } from "./ending";
import { offlinePrefix, wipeOffline } from "./offline";
import { commentLeft } from "./place";
import { OpenFailed, commentsOnPage, type Opened, type Session } from "./session";
import { guestThreads } from "./threads";

/**
 * A document on the hosted page: the owner's own editor (work-kit/editor),
 * on the link's socket. An edit link writes; a comment link reads and
 * comments on what it selects (the service marks the words); a view link
 * reads. What a link may not do is not drawn.
 *
 * An Edit link's page keeps the document on the guest's own device (offline.ts), so words typed while the line is
 * down outlive a closed tab. One line under the format row says when what is typed is not saved yet: within two
 * seconds of a line that dropped, in the editor's own muted status, never as a warning. An update the host cut as
 * too large is said once, with Reload, in place of the text: sent again it would be cut again.
 *
 * A styled document is drawn as sheets of its paper where the page is 640px
 * wide or more as it opens (docs/DESIGN.md "Work editors: Document pages"),
 * and an Edit link's row holds the switch and the zoom. Under 640px it is
 * always Flow and the row has no switch (guest.css): a sheet fitted to a
 * phone is too small to read.
 */

/** How fast the document's socket comes back: 1 s, growing a tenth a try, 5 s at most (about 30 s to reach it), with no jitter to wait on. */
export const RECONNECT = { delayMs: 1000, factor: 1.1, maxDelayMs: 5000, jitter: false } as const;

/** Set once this tab let go of a copy the host refused, so a second refusal ends as any other and never reloads again. */
const WIPED = "tc-guest-wiped";

const MEASURE = 672;
const MARGIN = 296;

/**
 * What the column gives up while the editor draws sheets (its `.te-pages-stage` is in it): its
 * measure and its padding, so the stage runs edge to edge under the header. Said in CSS, as in the
 * app's pane: the frame that draws the sheets is the frame that makes room.
 */
const IN_PAGES = {
  column: "has-[.te-pages-stage]:max-w-none has-[.te-pages-stage]:p-0",
  status: "group-has-[.te-pages-stage]/doc:mb-0 group-has-[.te-pages-stage]/doc:max-w-none group-has-[.te-pages-stage]/doc:bg-background group-has-[.te-pages-stage]/doc:px-4",
  text: "group-has-[.te-pages-stage]/doc:pr-0",
};

/** What the offline line says, by what holds the words typed meanwhile: this device (an Edit link's copy), this tab, or nothing to hold (a reader). */
export const OFFLINE_WORDS = {
  device: "Offline. Your edits are kept on this device until the connection is back.",
  tab: "Offline. Your edits are kept in this tab until the connection is back.",
  reader: "Offline. Changes will show when the connection is back.",
} as const;
export const TOO_BIG_WORDS = "That is too much to add at once. It was not saved.";
export const TOO_MUCH_WORDS = "Too much at once. Your edits are kept and will send in a minute.";
export const FULL_WORDS = "This document is as large as a guest can make it. Your last edit was not saved.";

/** Whether this load of the page is a reload of it. */
const reloaded = (): boolean => (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";

export function DocPage({
  session,
  opened,
  scheme,
  onGone,
  onPeople,
}: {
  session: Session;
  opened: Opened;
  scheme: "light" | "dark";
  onGone(): void;
  /** who else has the document open, as their carets come and go: the page's line draws their faces */
  onPeople?(people: DocumentPresence[]): void;
}) {
  const doc = opened.doc!;
  const linkId = session.mode.kind === "guest" ? session.mode.id : null;
  // The copy on this device is an Edit link's alone: a reader has nothing to keep, and the owner's page is his own app's.
  const kept = linkId !== null && opened.role === "edit";
  const [quiet, setQuiet] = useState(false);
  // What stopped the page for good until a reload: an update too large to send, or a document a guest may add no more to.
  const [stopped, setStopped] = useState<"big" | "full" | null>(null);
  // The link is waiting out its budget: the host lets it back in about a minute, and its next word takes the line away.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    // The browser knows it is offline before any socket does. Back online says nothing yet: the host's next word does.
    const off = (): void => setQuiet(true);
    window.addEventListener("offline", off);
    return () => window.removeEventListener("offline", off);
  }, []);
  const threads = useMemo(() => (opened.role === "view" || opened.comments === false ? null : guestThreads(session, doc)), [session, doc, opened.role, opened.comments]);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const fresh = useMemo(
    () => async () => {
      try {
        const o = await session.refresh();
        return { token: o.token, expiresAt: o.tokenExp };
      } catch (err) {
        if (err instanceof OpenFailed && err.why === "gone") goneRef.current();
        throw err;
      }
    },
    [session],
  );
  // The host closes the socket of a link it revoked: asked once, a link that is gone ends the page at once and takes
  // the document off the screen, for a reader too, whose editor shows no trouble once the text is in.
  // A role he changed opens the page again as that role; the editor brings its own socket back otherwise.
  const socket = useMemo(
    () =>
      watchedSocket({
        revoked: () => void afterRevoked(() => session.refresh(), opened.role, { gone: () => goneRef.current(), reopen: () => window.location.reload(), again: () => {} }),
        quiet: (q) => {
          setQuiet(q);
          if (!q) setHeld(false);
        },
        // The update is in this device's copy too: left there, the next open would send it again and be cut again.
        tooBig: () => void (linkId !== null ? wipeOffline(linkId, doc) : Promise.resolve()).then(() => setStopped("big")),
        full: () => void (linkId !== null ? wipeOffline(linkId, doc) : Promise.resolve()).then(() => setStopped("full")),
        tooMuch: () => setHeld(true),
        // What the copy holds was written under another name than this link's: it is let go and the document read afresh, once.
        ...(kept
          ? {
              refusedCopy: () => {
                if (sessionStorage.getItem(WIPED) === doc) return void afterRevoked(() => session.refresh(), opened.role, { gone: () => goneRef.current(), reopen: () => window.location.reload(), again: () => {} });
                sessionStorage.setItem(WIPED, doc);
                void wipeOffline(linkId, doc).then(() => window.location.reload());
              },
            }
          : {}),
      }),
    [session, opened.role, linkId, kept, doc],
  );
  const adapters = useMemo<Partial<EditorAdapters>>(
    () => ({
      // Every token the editor asks for (on connect, and every minute) asks the service again:
      // a link revoked or ended answers "gone" there, and the page says so.
      // A line that dropped, or a host that restarted, is tried again about every second for the first half minute, then every five.
      collab: { url: session.socketUrl(opened), getToken: () => fresh(), offline: kept ? offlinePrefix(linkId) : false, socket, reconnect: RECONNECT },
      threads: threads?.adapter ?? null,
      identity: {
        // The owner's own page says his name: a guest reads it on his caret (the host hands it over with his pass).
        me: { id: opened.me, name: opened.name ?? opened.self ?? "You", avatarUrl: null },
        get people() {
          return Object.entries(threads?.names() ?? {}).map(([id, name]) => ({ id, name, avatarUrl: null }));
        },
      },
    }),
    [session, opened, threads, fresh, socket, kept, linkId],
  );
  const wide = useWide(MEASURE + MARGIN + 64);
  // Flow or Pages, and Pages' zoom: what the page's width says as it opens, then his own pick in the row. A later resize changes nothing.
  const [opens] = useState(() => ({ view: openingView(window.innerWidth), zoom: openingZoom(window.innerWidth) }));
  const [picked, setPicked] = useState<{ view?: DocumentView; zoom?: PageZoom }>({});
  const onView = useCallback((view: DocumentView) => setPicked((was) => ({ ...was, view })), []);
  const onZoom = useCallback((zoom: PageZoom) => setPicked((was) => ({ ...was, zoom })), []);
  // Only a styled document is ever drawn as sheets, and one that was classic when it opened stays in Flow when he styles it:
  // the text never jumps onto sheets under his hands.
  const [styled, setStyled] = useState(false);
  const [classic, setClassic] = useState(false);
  const styledNow = useRef(false);
  const onPage = useCallback((page: DocumentPage | null) => {
    styledNow.current = page !== null;
    setStyled(page !== null);
  }, []);
  const read = useRef(false);
  const onEditor = useCallback(
    (editor: unknown) => {
      if (!editor || read.current) return;
      read.current = true;
      setClassic(!styledNow.current);
      // A reload puts the caret back in the text, at its start: no place is kept, and the keys go somewhere.
      if (opened.role !== "edit" || !reloaded()) return;
      const e = editor as { document?: unknown[]; setTextCursorPosition?(block: unknown, at: "start"): void; focus?(): void };
      try {
        if (e.document?.[0]) e.setTextCursorPosition?.(e.document[0], "start");
        e.focus?.();
      } catch {
        // An editor with no block to stand in keeps no caret.
      }
    },
    [opened.role],
  );
  // Sheets need 640px now, too: a tablet turned narrow, or a phone turned back upright, reads Flow until there is room again.
  const room = useWide(PAGES_FROM);
  const view = room ? (picked.view ?? (classic ? "flow" : opens.view)) : "flow";
  const sheets = styled && view === "pages";
  // On sheets a comment opens at its words: there is no margin beside a sheet, and no list under the last one.
  const side = wide && !!threads && !sheets;
  const frame = useRef<HTMLDivElement>(null);
  const [rowSlot, setRowSlot] = useState<HTMLDivElement | null>(null);
  // Anything wrong with the socket may be a link that went: the page asks once, and shows the end if it is gone.
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const onStatus = (next: DocumentStatus | null): void => {
    setStatus(next);
    if (next) void session.refresh().catch((err: unknown) => err instanceof OpenFailed && err.why === "gone" && goneRef.current());
  };
  const offlineWords = kept ? OFFLINE_WORDS.device : opened.role === "edit" ? OFFLINE_WORDS.tab : OFFLINE_WORDS.reader;
  // One line: the editor's own trouble, in this page's words where it is the line being down; else a line that went quiet.
  const line: { message: string; retry: (() => void) | null } | null = held
    ? { message: TOO_MUCH_WORDS, retry: null }
    : status
      ? status.kind === "offline"
        ? { message: offlineWords, retry: null }
        : status
      : quiet
        ? { message: offlineWords, retry: null }
        : null;
  if (stopped)
    return (
      <div data-guest-document={opened.role} className="mx-auto w-full max-w-[736px] px-4 pt-6 sm:px-8">
        <div role="alert" className="flex min-h-8 items-center gap-2 border-b border-border text-[13px]">
          <span className="min-w-0 text-muted-foreground">{stopped === "big" ? TOO_BIG_WORDS : FULL_WORDS}</span>
          <Button variant="ghost" size="xs" className="ms-auto shrink-0" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  return (
    <EditorKitProvider value={{ theme: scheme, ladder: DOCUMENT_LADDER, fonts: DOC_FONTS }}>
      <EditorAdaptersProvider adapters={adapters}>
        {/* The format row's place: the page's first row under its header, held while the text scrolls under it, as in the app's pane. */}
        {opened.role === "edit" ? <div ref={setRowSlot} data-guest-row className="sticky top-0 z-10 w-full min-w-0 flex-none bg-background" /> : null}
        <div ref={frame} data-guest-document={opened.role} className={`group/doc relative mx-auto w-full max-w-(--doc-column) min-w-0 px-4 pt-6 pb-10 sm:px-8 ${IN_PAGES.column}`} style={{ "--doc-column": `${MEASURE + (side ? MARGIN : 0) + 64}px`, "--doc-margin": `${side ? MARGIN : 0}px` } as React.CSSProperties}>
          {line ? (
            <div role="status" data-guest-status className={`mb-3 flex min-h-8 max-w-[672px] items-center gap-2 border-b border-border py-1 text-[13px] leading-5 ${IN_PAGES.status}`}>
              <span className="min-w-0 text-muted-foreground">{line.message}</span>
              {line.retry ? (
                <Button variant="ghost" size="xs" className="ms-auto shrink-0" onClick={line.retry}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className={`pr-(--doc-margin) [--link:var(--accent)] ${IN_PAGES.text}`}>
            <DocumentEditor
              documentName={doc}
              editable={opened.role === "edit"}
              canComment={commentsOnPage(session.mode.kind, opened.role) && opened.comments !== false}
              threadMargin={threads && !sheets ? (side ? "side" : "under") : undefined}
              threadList={!!threads}
              onStatus={onStatus}
              {...(onPeople ? { onPresence: onPeople } : {})}
              // An Edit link gets the format row; Comment and View get none. The page is built with the service it is
              // served by, so the schema it knows is the service's: it says so, and asks the service to raise a document.
              formatRow={opened.role === "edit"}
              formatRowInto={rowSlot}
              hostSchema={DOCUMENT_SCHEMA}
              view={view}
              zoom={picked.zoom ?? opens.zoom}
              onView={onView}
              onZoom={onZoom}
              onPage={onPage}
              onEditor={onEditor}
              title={opened.title}
              locale={navigator.language}
            />
          </div>
          {opened.role === "comment" ? <SelectionComment session={session} frame={frame} onMade={() => threads?.refresh()} /> : null}
        </div>
      </EditorAdaptersProvider>
    </EditorKitProvider>
  );
}

/** The comment field's width: 320px, or the page's width on a narrow phone. */
const COMMENT_WIDTH = 320;

function useWide(px: number): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= px);
  useEffect(() => {
    const q = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [px]);
  return wide;
}

/**
 * A comment link's own selection bar: the editor draws none on a text that
 * can only be read. Comment over the selected words, then a field; the
 * words go to the service, which makes the thread and marks them.
 */
function SelectionComment({ session, frame, onMade }: { session: Session; frame: React.RefObject<HTMLDivElement | null>; onMade(): void }) {
  const [at, setAt] = useState<{ quote: string; x: number; y: number; bottom: number } | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (writing) return;
    const on = (): void => {
      const sel = document.getSelection();
      const root = frame.current?.querySelector(".ProseMirror");
      if (!sel || sel.isCollapsed || !root || !sel.anchorNode || !root.contains(sel.anchorNode) || !sel.focusNode || !root.contains(sel.focusNode)) return setAt(null);
      const quote = sel.toString().trim();
      if (!quote || quote.length > 2000) return setAt(null);
      const box = sel.getRangeAt(0).getBoundingClientRect();
      const host = frame.current!.getBoundingClientRect();
      setAt({ quote, x: box.left - host.left, y: box.top - host.top, bottom: box.bottom - host.top });
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [frame, writing]);

  if (!at) return null;
  const close = (): void => {
    setWriting(false);
    setText("");
    setError(null);
    setAt(null);
  };
  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.comment({ quote: at.quote, text: text.trim() });
      onMade();
      document.getSelection()?.removeAllRanges();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  // The field stays inside the page: as wide as it may be, and moved left of the selection near the right edge.
  const frameWidth = frame.current?.clientWidth ?? COMMENT_WIDTH;
  const width = writing ? Math.min(COMMENT_WIDTH, frameWidth) : undefined;
  return (
    <div
      className="absolute z-(--layer-popover) rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay"
      // The bar sits over the words; the field opens under them, so it never runs off the top.
      style={{ left: commentLeft(at.x, width ?? 120, frameWidth), top: writing ? at.bottom + 8 : Math.max(0, at.y - 40), width }}
      onMouseDown={(e) => {
        // The selection stays while the bar is pressed.
        if (!writing) e.preventDefault();
      }}
    >
      {writing ? (
        <form
          className="flex flex-col gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Textarea
            autoFocus
            rows={3}
            value={text}
            maxLength={4000}
            placeholder="Comment"
            aria-label="Comment"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!text.trim() || busy}>
              <BusyLabel busy={busy} label="Comment" />
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="ghost" size="xs" onClick={() => setWriting(true)}>
          <Comment />
          Comment
        </Button>
      )}
    </div>
  );
}
