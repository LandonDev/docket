import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PdfCite, PdfField, PdfSignature, PdfView } from "@shared/contract-work-pdf";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search, X } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { GroupInput, Input, InputGroup } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { dayTime } from "../../lib/duration";
import { modOrCtrl } from "../../lib/keys";
import { useShutsBar } from "../canvas/barHold";
import { FailedHost, OpenFailed } from "../canvas/FetchState";
import { Tip } from "../../components/tip";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, MoreEntry, ReviewAdapter } from "../canvas/kind";
import { Download, ZoomIn } from "../icons";
import { onCite } from "./cite";
import { Column } from "./Column";
import { pdfjsEngine, type PdfEngine } from "./engine";
import { SignaturePad } from "./Fields";
import { onItemsGone } from "../canvas/gone";
import { linkHost, usePdfItem, type PdfHost } from "./item";
import { ZOOMS, type Zoom } from "./layout";
import { navOf, useNav, type PdfNav } from "./nav";

/**
 * The PDF kind (docs/agents/work-pdf.md; the approved page is
 * .temp-code/prototypes/work-workspaces-2/pdf.html, "The page, and ask"):
 * the file as written in one column, his marks on it, and nothing of the
 * agent's reading. The bar holds the pager, the zoom and Find; the pane
 * draws the mode and the stepper from what the body feeds it.
 */

export type PdfState = undefined;

/** A test or a preview hands in its own host and engine; the app uses the link and pdf.js. */
export interface PdfDeps {
  host?: PdfHost;
  engine?: PdfEngine;
  /** A preview's or a test's fixed size: jsdom lays nothing out. */
  width?: number;
  height?: number;
}

const hosts = new Map<string, PdfHost>();
// A closed item's host goes with it.
onItemsGone((ids) => {
  for (const key of [...hosts.keys()]) if (ids.includes(key.slice(key.indexOf("\n") + 1))) hosts.delete(key);
});
function hostFor(env: string, itemId: string): PdfHost {
  const key = `${env}\n${itemId}`;
  let host = hosts.get(key);
  if (!host) {
    host = linkHost(env, itemId);
    hosts.set(key, host);
  }
  return host;
}

/** The order the stepper walks: page by page, top to bottom. */
export function pending(fields: readonly PdfField[]): PdfField[] {
  return fields.filter((f) => f.state === "proposed").sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

export function Body(props: CanvasBodyProps<PdfState> & PdfDeps) {
  const host = props.host ?? hostFor(props.env, props.item.id);
  const item = usePdfItem(host, props.engine ?? pdfjsEngine, `${props.env}\n${props.item.id}`);
  return <PdfBody {...props} host={host} pdf={item} />;
}

export function PdfBody({ item: canvasItem, source, shell, host, pdf: item, width, height }: CanvasBodyProps<PdfState> & { host: PdfHost; pdf: ReturnType<typeof usePdfItem>; width?: number; height?: number }) {
  const { view, viewError, doc, setView } = item;
  const nav = navOf(canvasItem.id);
  const [current, setCurrent] = useState(0);
  const [cite, setCite] = useState<PdfCite | null>(null);
  const [signature, setSignature] = useState<PdfSignature | null>(null);
  const [pad, setPad] = useState(false);

  useEffect(() => nav.attach(doc.phase === "ready" ? doc.doc : null), [nav, doc]);
  useEffect(() => onCite(canvasItem.id, setCite), [canvasItem.id]);
  const hasSignature = view?.hasSignature ?? false;
  useEffect(() => {
    if (!hasSignature) return setSignature(null);
    let live = true;
    host.signature().then(
      (got) => live && setSignature(got),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host, hasSignature]);

  const proposed = useMemo(() => pending(view?.fields ?? []), [view?.fields]);
  const at = Math.min(current, proposed.length - 1);
  // The computer the pane's file is on (`FailedHost`): every failure here names it.
  const env = useContext(FailedHost);
  const run = useCallback((work: Promise<PdfView>, fallback: string): Promise<void> => work.then(setView, (error: unknown) => sayError(error, fallback, env)), [setView, env]);

  useEffect(() => nav.review(proposed.length > 0), [nav, proposed.length]);
  // A file that did not open (or waits for its password) has no pages for the bar: it drops its bone.
  const shut = !!viewError || doc.phase === "failed" || doc.phase === "password";
  useEffect(() => nav.shut(shut), [nav, shut]);
  useFeeds(shell, doc.phase === "ready" ? view : null, proposed, at, setCurrent, nav, host, run);
  useMore(shell, nav, host, doc.phase === "ready" && !!view, env);

  // With a saved signature the press signs at once, and Sign spins until the host has placed it.
  const sign = (): Promise<void> | void => {
    if (!view) return;
    if (view.hasSignature) return run(host.sign(true), "Couldn't sign");
    setPad(true);
  };

  if (viewError) return <OpenFailed kind="pdf" why={viewError} onRetry={item.retry} />;
  if (!view || doc.phase === "loading") return <PageSkeleton />;
  if (doc.phase === "password") return <Locked wrong={doc.wrong} onOpen={item.unlock} />;
  if (doc.phase === "failed") return <OpenFailed kind="pdf" why={doc.message} onRetry={item.retry} />;
  return (
    <>
      <Column
        doc={doc.doc}
        nav={nav}
        itemId={canvasItem.id}
        title={view.name}
        source={source}
        // The pages first: no field or mark is drawn or made until the file's form is read (`formPending`).
        fields={view.formPending ? [] : view.fields}
        marks={view.formPending ? [] : view.marks}
        marking={!view.formPending}
        current={proposed[at]?.key ?? null}
        signature={signature}
        cite={cite}
        onClearCite={() => setCite(null)}
        shell={shell}
        width={width}
        height={height}
        actions={{
          setField: (key, value) => fieldWrite(host, host.setField(key, value)).then(setView),
          sign,
          unsign: () => host.sign(false).then(setView),
          mark: (page, quads, text) => run(host.mark(page, quads, text), "Couldn't highlight"),
          unmark: (markId) => run(host.unmark(markId), "Couldn't remove the highlight"),
        }}
      />
      {pad ? (
        <SignaturePad
          onClose={() => setPad(false)}
          onSave={async (drawn) => {
            await host.setSignature(drawn);
            setSignature(drawn);
            setView(await host.sign(true));
          }}
        />
      ) : null}
    </>
  );
}

/** What the body tells the pane: the mode, the stepper over the agent's values, the line after a direct write, a moved file. */
function useFeeds(
  shell: CanvasShell,
  view: PdfView | null,
  proposed: PdfField[],
  at: number,
  setCurrent: (n: number) => void,
  nav: PdfNav,
  host: PdfHost,
  run: (work: Promise<PdfView>, fallback: string) => Promise<void>,
): void {
  const mode = view?.mode;
  const missing = view?.missing;
  const name = view?.name;
  useEffect(() => {
    // A moved file is read only: there is nothing for the agent to do to it.
    if (!mode || missing) return shell.mode(null);
    shell.mode({ value: mode, set: (next) => void run(host.mode(next), "Couldn't change what the agent does") });
    return () => shell.mode(null);
  }, [shell, host, mode, missing, run]);

  useEffect(() => {
    if (!view) return shell.statusLine(null);
    // A moved file shows the copy the host kept: the line says which, by its time.
    if (view.missing) shell.statusLine({ tone: "quiet", word: "Moved.", detail: `The copy from ${dayTime(view.missing.asOf)}` });
    // A form only Adobe's apps fill asks nothing of him here: the quiet line, as read only is, never the red of a failure.
    // One sentence says both that it cannot be filled here and why.
    else if (view.xfaOnly) shell.statusLine({ tone: "quiet", word: "Only Adobe's apps fill this form" });
    else shell.statusLine(null);
    return () => shell.statusLine(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, missing?.asOf, view?.xfaOnly, name]);

  const written = view?.written;
  useEffect(() => {
    if (!written || proposed.length > 0) return shell.written(null);
    shell.written({ text: `${written.text}, ${dayTime(written.at)}`, undo: () => run(host.undo(written.id), "Couldn't undo") });
    return () => shell.written(null);
  }, [shell, host, written, proposed.length, run]);

  const keys = proposed.map((f) => f.key).join("\n");
  useEffect(() => {
    if (proposed.length === 0) return shell.review(null);
    const step = (to: number): void => {
      const field = proposed[to];
      if (!field) return;
      setCurrent(to);
      nav.scrollTo?.(field.page, field.bbox);
    };
    const which = (w: number | { group: string } | "all"): string[] | "all" => (w === "all" || typeof w !== "number" ? "all" : [proposed[w]?.key].filter(Boolean));
    const review: ReviewAdapter = {
      groups: [{ id: "fields", label: "Fields", by: proposed[0].by ?? "owner", count: proposed.length }],
      index: at,
      count: proposed.length,
      step,
      accept: (w) => run(host.review(which(w), "accept"), "Couldn't accept the value"),
      reject: (w) => run(host.review(which(w), "reject"), "Couldn't reject the value"),
    };
    shell.review(review);
    return () => shell.review(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, host, keys, at, run]);
}

/** What the bar gives way (`barFits`) reaches the pane's More, so a narrow pane still zooms, finds and saves a copy. */
function useMore(shell: CanvasShell, nav: PdfNav, host: PdfHost, open: boolean, env: string | null): void {
  const state = useNav(nav);
  const fits = barFits(state.width, state.reviewing, state.find.open);
  const zoom = !fits.zoom && open ? state.zoom : null;
  const find = !fits.find && open;
  const save = !fits.save && open;
  useEffect(() => {
    const entries: MoreEntry[] = [
      ...(zoom !== null
        ? ZOOMS.map<MoreEntry>((z) => ({ id: `zoom-${z}`, label: `Zoom: ${ZOOM_WORDS[String(z)]}`, icon: z === zoom ? Check : ZoomIn, disabled: z === zoom, run: () => nav.zoom(z) }))
        : []),
      ...(find ? [{ id: "find", label: "Find", icon: Search, run: () => nav.openFind() }] : []),
      ...(save ? [{ id: "save-copy", label: "Save a Copy", icon: Download, run: () => saveCopy(host).catch((error: unknown) => sayError(error, "Couldn't save a copy", env)) }] : []),
    ];
    shell.more?.(entries.length ? entries : null);
    return () => shell.more?.(null);
  }, [shell, nav, host, zoom, find, save, env]);
}

/** Loading: the page's own shape, on the card step, on the paper's own side inset (layout.ts `sideInset`: 24px, 12px under 640px). */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="@container flex min-h-0 flex-1 bg-(--stage)">
      <div data-pdf-bones className="flex min-w-0 flex-1 justify-center px-6 pt-4 @max-[640px]:px-3">
        <div className="flex aspect-[440/569] w-[440px] max-w-full flex-col gap-2.5 self-start rounded-[2px] bg-card px-10 py-8 outline-1 outline-border">
          <Skeleton className="mb-2 h-3 w-[38%] self-center" />
          {[92, 88, 96, 60, 0, 90, 94, 72, 0, 86, 90, 54].map((w, i) => (w ? <Skeleton key={i} className="h-2" style={{ width: `${w}%` }} /> : <span key={i} className="h-1" />))}
        </div>
      </div>
    </div>
  );
}

/** An encrypted file: one field and Open. The bar has nothing for it until it opens: its hold lets go. */
function Locked({ wrong, onOpen }: { wrong: boolean; onOpen(password: string): void }) {
  const [password, setPassword] = useState("");
  useShutsBar();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This file needs a password</EmptyTitle>
        {wrong ? <EmptyDescription className="text-destructive">That password didn't open it</EmptyDescription> : null}
      </EmptyHeader>
      <form
        className="flex w-[280px] max-w-full gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (password) onOpen(password);
        }}
      >
        <Input type="password" placeholder="Password" aria-label="Password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        <Button type="submit" variant="secondary" disabled={!password}>
          Open
        </Button>
      </form>
    </Empty>
  );
}

// ── the bar ──────────────────────────────────────────────────────────

const ZOOM_WORDS: Record<string, string> = { fit: "Fit width", 1: "100%", 1.25: "125%", 1.5: "150%" };

/**
 * What fits beside the mode and the stepper, as the prototype gives way at
 * each width: the zoom and Save go first, then (while the stepper is there)
 * Find and the pager, whose count would sit beside the stepper's. Width 0
 * is a static page, which shows all.
 */
export function barFits(width: number, reviewing: boolean, finding: boolean): { pager: boolean; arrows: boolean; zoom: boolean; find: boolean; save: boolean } {
  const w = width === 0 ? Infinity : width;
  // Under 560px while the stepper is there, its count is the one fraction in the bar: the pager goes.
  const pager = !reviewing || w >= 560;
  if (finding) return { pager: pager && w >= 460, arrows: w >= 560, zoom: false, find: true, save: false };
  return { pager, arrows: !reviewing || w >= 560, zoom: reviewing ? w >= 700 : w >= 460, find: !reviewing || w >= 560, save: reviewing ? w >= 760 : w >= 520 };
}

/** The kind's tools in the bar: the pager, the zoom, Find, and a copy to keep. */
export function Bar({ item, env, host: given }: CanvasBodyProps<PdfState> & PdfDeps) {
  const nav = navOf(item.id);
  const state = useNav(nav);
  const host = given ?? hostFor(env, item.id);
  // Escape and Close find give the focus back to Find, or to the page when the narrow bar holds no Find: never to the body.
  const findButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const findOpen = state.find.open;
  useLayoutEffect(() => {
    if (findOpen || !refocus.current) return;
    refocus.current = false;
    const target = findButton.current ?? document.querySelector<HTMLElement>(`[data-pdf-column="${CSS.escape(item.id)}"]`);
    target?.focus({ preventScroll: true });
  }, [findOpen, item.id]);
  const closeFind = useCallback(() => {
    refocus.current = true;
    nav.closeFind();
  }, [nav]);
  // While the file opens the bar holds a bone where the pager will be, so the body does not move when it lands.
  if (state.pages === 0) return state.shut ? null : <Skeleton data-pdf-bar-bone className="h-3 w-30" />;
  const fits = barFits(state.width, state.reviewing, state.find.open);
  return (
    <>
      {fits.pager ? <Pager nav={nav} page={state.page} pages={state.pages} arrows={fits.arrows} /> : null}
      {fits.zoom ? <ZoomMenu nav={nav} zoom={state.zoom} /> : null}
      {state.find.open ? (
        <FindField nav={nav} onClose={closeFind} />
      ) : fits.find ? (
        <Tip label="Find">
          <Button ref={findButton} variant="ghost" size="icon-xs" aria-label="Find" onClick={() => nav.openFind()}>
            <Search />
          </Button>
        </Tip>
      ) : null}
      {fits.save ? <SaveCopy host={host} /> : null}
      <FindKeys nav={nav} itemId={item.id} />
    </>
  );
}

function Pager({ nav, page, pages, arrows }: { nav: PdfNav; page: number; pages: number; arrows: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {arrows ? (
        <Tip label="Previous page">
          <Button variant="ghost" size="icon-xs" aria-label="Previous page" disabled={page <= 1} onClick={() => nav.goTo(page - 1)}>
            <ChevronLeft />
          </Button>
        </Tip>
      ) : null}
      <span data-pdf-pager className="min-w-[52px] text-center text-foreground tabular-nums">
        {page}/{pages}
      </span>
      {arrows ? (
        <Tip label="Next page">
          <Button variant="ghost" size="icon-xs" aria-label="Next page" disabled={page >= pages} onClick={() => nav.goTo(page + 1)}>
            <ChevronRight />
          </Button>
        </Tip>
      ) : null}
    </div>
  );
}

function ZoomMenu({ nav, zoom }: { nav: PdfNav; zoom: Zoom }) {
  const rows: MenuRow[] = ZOOMS.map((z) => ({ kind: "item", id: String(z), label: ZOOM_WORDS[String(z)], checked: z === zoom }));
  return (
    <RowsMenu
      label="Zoom"
      align="start"
      rows={rows}
      onPick={(id) => {
        const z = ZOOMS.find((value) => String(value) === id);
        if (z !== undefined) nav.zoom(z);
      }}
      trigger={
        <Button variant="ghost" size="xs" className="shrink-0 font-normal text-muted-foreground">
          {ZOOM_WORDS[String(zoom)]}
          <ChevronDown />
        </Button>
      }
    />
  );
}

function FindField({ nav, onClose }: { nav: PdfNav; onClose(): void }) {
  const { find } = useNav(nav);
  const [text, setText] = useState(find.query);
  const input = useRef<HTMLInputElement>(null);
  // The field follows a query set from elsewhere, and searches what he types once he pauses.
  useEffect(() => setText(find.query), [find.query]);
  useEffect(() => {
    // Checked when the pause ends: an Enter in between has searched it already.
    const wait = setTimeout(() => text !== nav.get().find.query && nav.query(text), 150);
    return () => clearTimeout(wait);
  }, [nav, text]);
  const count = find.query.trim() ? (find.hits.length === 0 ? (find.searching ? "" : "None") : `${find.current + 1}/${find.hits.length}`) : "";
  return (
    // 28px with 24px presses: each is a whole hit area. Escape from anywhere in it (the field or a press Tab reached) closes it.
    <InputGroup
      role="search"
      className="h-7 w-[236px] shrink gap-0.5 rounded-md ps-2 pe-0.5 [&_svg:not([class*='size-'])]:size-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      leading={<Search />}
      trailing={
        <>
          <Tip label="Previous match">
            <Button variant="ghost" size="icon-xs" aria-label="Previous match" disabled={find.hits.length === 0} onClick={() => nav.step(-1)}>
              <ChevronUp />
            </Button>
          </Tip>
          <Tip label="Next match">
            <Button variant="ghost" size="icon-xs" aria-label="Next match" disabled={find.hits.length === 0} onClick={() => nav.step(1)}>
              <ChevronDown />
            </Button>
          </Tip>
          <Tip label="Close find">
            <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={onClose}>
              <X />
            </Button>
          </Tip>
        </>
      }
    >
      <GroupInput
        ref={input}
        autoFocus
        aria-label="Find"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            // A new query searches; the same one steps to the next match.
            if (text.trim() !== find.query.trim()) nav.query(text);
            else nav.step(event.shiftKey ? -1 : 1);
          }
        }}
        className="px-0.5 text-xs text-foreground"
      />
      <span data-pdf-find-count aria-live="polite" className="inline-flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground tabular-nums">
        {count}
        {/* Still reading pages: the count may grow, so it is not yet final. */}
        {find.searching ? <Spinner data-pdf-find-reading aria-label="Still reading" className="size-3" /> : null}
      </span>
    </InputGroup>
  );
}

/** ⌘F (Ctrl+F off macOS) opens Find while the PDF has the focus or the pointer. */
function FindKeys({ nav, itemId }: { nav: PdfNav; itemId: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "f" || !modOrCtrl(event) || event.altKey || event.shiftKey) return;
      // Its own pane only: with two PDFs on screen (a board), the one with the focus or the pointer finds.
      const pane = document.querySelector(`[data-pdf-column="${CSS.escape(itemId)}"]`)?.closest("[data-canvas-pane]");
      if (!pane || !(pane.contains(document.activeElement) || pane.matches(":hover"))) return;
      event.preventDefault();
      nav.openFind();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  return null;
}

/** A copy with his values, highlights and signature in it, flattened, saved where he chooses. */
function SaveCopy({ host }: { host: PdfHost }) {
  const [busy, setBusy] = useState(false);
  const env = useContext(FailedHost);
  return (
    <Tip label="Save a copy">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Save a copy"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          saveCopy(host)
            .catch((error: unknown) => sayError(error, "Couldn't save a copy", env))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <BusyLabel busy label="" /> : <Download />}
      </Button>
    </Tip>
  );
}

/** Field writes still out, per item's host: the tick shows at his press, before the host has written it. */
const writing = new WeakMap<PdfHost, Set<Promise<unknown>>>();

/** A field write, counted until the host answers it. */
function fieldWrite<T>(host: PdfHost, work: Promise<T>): Promise<T> {
  let out = writing.get(host);
  if (!out) writing.set(host, (out = new Set()));
  const set = out;
  set.add(work);
  const done = (): void => void set.delete(work);
  work.then(done, done);
  return work;
}

/** Every field write out now and any begun while they land; a refused one stops the copy, as the page no longer shows it. */
async function fieldsWritten(host: PdfHost): Promise<void> {
  for (let out = [...(writing.get(host) ?? [])]; out.length; out = [...(writing.get(host) ?? [])]) {
    const answers = await Promise.allSettled(out);
    if (answers.some((a) => a.status === "rejected")) throw new Error("A field did not change, so the copy would not match the page.");
  }
}

async function saveCopy(host: PdfHost): Promise<void> {
  // The copy holds every tick he sees: a write still out is waited for first.
  await fieldsWritten(host);
  const made = await host.export(true);
  const parts: Uint8Array[] = [];
  // Each read names this copy's revision: a second Save a Copy made meanwhile never lends it its bytes.
  for (let at = 0; at < made.size; at += 4 * 1024 * 1024) parts.push(await host.read("export", at, Math.min(4 * 1024 * 1024, made.size - at), made.rev));
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = made.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (made.warnings.length) void loadToast().then((toast) => toast.error(made.warnings.join(" ")));
}
