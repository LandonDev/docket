import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DOCUMENT_SCHEMA } from "work-kit/collab";
import { DOCUMENT_LADDER, DocumentEditor, EditorAdaptersProvider, EditorKitProvider, type DocumentPage, type DocumentStatus, type DocumentView, type EditorAdapters, type PageZoom } from "work-kit/editor";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { DOC_FONTS } from "@renderer/work/docs/fonts";
import { Comment } from "@renderer/work/icons";
import { openingView, openingZoom, PAGES_FROM } from "./opening";
import { commentLeft } from "./place";
import { OpenFailed, commentsOnPage, type Opened, type Session } from "./session";
import { guestThreads } from "./threads";

/**
 * A document on the hosted page: the owner's own editor (work-kit/editor),
 * on the link's socket. An edit link writes; a comment link reads and
 * comments on what it selects (the service marks the words); a view link
 * reads. What a link may not do is not drawn.
 *
 * A styled document is drawn as sheets of its paper where the page is 640px
 * wide or more as it opens (docs/DESIGN.md "Work editors: Document pages"),
 * and an Edit link's row holds the switch and the zoom. Under 640px it is
 * always Flow and the row has no switch (guest.css): a sheet fitted to a
 * phone is too small to read.
 */

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

export function DocPage({ session, opened, scheme, onGone }: { session: Session; opened: Opened; scheme: "light" | "dark"; onGone(): void }) {
  const doc = opened.doc!;
  const threads = useMemo(() => (opened.role === "view" ? null : guestThreads(session, doc)), [session, doc, opened.role]);
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
  const adapters = useMemo<Partial<EditorAdapters>>(
    () => ({
      // Every token the editor asks for (on connect, and every minute) asks the service again:
      // a link revoked or ended answers "gone" there, and the page says so.
      collab: { url: session.socketUrl(opened), getToken: () => fresh(), offline: false },
      threads: threads?.adapter ?? null,
      identity: {
        me: { id: opened.me, name: opened.name ?? "You", avatarUrl: null },
        get people() {
          return Object.entries(threads?.names() ?? {}).map(([id, name]) => ({ id, name, avatarUrl: null }));
        },
      },
    }),
    [session, opened, threads, fresh],
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
  const onEditor = useCallback((editor: unknown) => {
    if (!editor || read.current) return;
    read.current = true;
    setClassic(!styledNow.current);
  }, []);
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
  return (
    <EditorKitProvider value={{ theme: scheme, ladder: DOCUMENT_LADDER, fonts: DOC_FONTS }}>
      <EditorAdaptersProvider adapters={adapters}>
        {/* The format row's place: the page's first row under its header, held while the text scrolls under it, as in the app's pane. */}
        {opened.role === "edit" ? <div ref={setRowSlot} data-guest-row className="sticky top-0 z-10 w-full min-w-0 flex-none bg-background" /> : null}
        <div ref={frame} data-guest-document={opened.role} className={`group/doc relative mx-auto w-full max-w-(--doc-column) min-w-0 px-4 pt-6 pb-10 sm:px-8 ${IN_PAGES.column}`} style={{ "--doc-column": `${MEASURE + (side ? MARGIN : 0) + 64}px`, "--doc-margin": `${side ? MARGIN : 0}px` } as React.CSSProperties}>
          {status ? (
            <div role="status" className={`mb-3 flex h-8 max-w-[672px] items-center gap-2 border-b border-border text-[13px] ${IN_PAGES.status}`}>
              <span className="min-w-0 truncate text-muted-foreground">{status.message}</span>
              {status.retry ? (
                <Button variant="ghost" size="xs" className="ms-auto" onClick={status.retry}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className={`pr-(--doc-margin) [--link:var(--accent)] ${IN_PAGES.text}`}>
            <DocumentEditor
              documentName={doc}
              editable={opened.role === "edit"}
              canComment={commentsOnPage(session.mode.kind, opened.role)}
              threadMargin={threads && !sheets ? (side ? "side" : "under") : undefined}
              threadList={!!threads}
              onStatus={onStatus}
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
