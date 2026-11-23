import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Pause, Play, SlidersHorizontal } from "../../chrome/icons";
import { LazyPopover, RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { loadToast } from "../../components/ui/toaster";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { PdfEngine } from "../pdf/engine";
import { FOLD, PAGED_ZOOMS, PagedSkeleton, PagedView, ZOOM_WORDS, type PagedZoom } from "./PagedView";
import { MARGIN_PRESETS, marginPresetOf, NotInReach, PAPER_POINTS, PAPERS, type CommonSetup, type Drawn, type MarginPreset, type OfficeApp, type PaperName, type PreviewFormat, type PreviewPicture, type PreviewSource } from "./preview";

/**
 * Preview (docs/DESIGN.md "Work editors: Preview"; docs/agents/work-editors.md
 * "Preview"): a state of an item, the same for a document, a sheet and a
 * deck. Its bar takes the format row's place and the body becomes the file
 * as the chosen format will hold it, drawn by the program that will read it,
 * with what the format drops in plain words beside it and one verb.
 *
 * The frame knows nothing of a kind: it lists the source's formats, asks it
 * to draw one, shows the picture and asks it to export. A kind hands it a
 * `PreviewSource` (preview.ts) that stays the same object while the file it
 * names is the same: a new source is a new file to draw.
 */

export interface PreviewProps {
  source: PreviewSource;
  /** The item's name, for the picture's accessible name: "Run of show". */
  title: string;
  /** One word per kind, so the format he last used there is the one offered next: "document". */
  kind: string;
  /** The format to open on (Print… opens on its own); else the last used, else the first. */
  initial?: string | undefined;
  /** A file he cannot edit: the way out reads Back. */
  readOnly?: boolean;
  onClose(): void;
  /** The kind's own rows of the Page section, after the ones every kind shares (`PageMenuRow`, `PageSwitchRow`). */
  pageRows?: ReactNode;
  /** A test or a static preview hands in its own engine and sizes: jsdom lays nothing out. */
  engine?: PdfEngine;
  width?: number;
  height?: number;
  tight?: boolean;
}

/** Canvas widths: under the first the column folds into the bar; under the second Edit is its glyph and the zoom goes. */
export const PREVIEW_FOLD = FOLD;
export const PREVIEW_TINY = 440;

const lastKey = (kind: string): string => `work.preview.format.${kind}`;

/** The format to open on: the one asked for, else the one he last used for this kind, else the first. */
export function openingFormat(formats: readonly PreviewFormat[], kind: string, initial?: string): string {
  const has = (id: string | null | undefined): id is string => !!id && formats.some((f) => f.id === id);
  if (has(initial)) return initial;
  let kept: string | null = null;
  try {
    kept = globalThis.localStorage?.getItem(lastKey(kind)) ?? null;
  } catch {
    kept = null;
  }
  return has(kept) ? kept : (formats[0]?.id ?? "");
}

/** Who drew a picture, as the line over the first sheet says it; null for a picture that is the file's own text or files. */
export function drawnByLine(picture: PreviewPicture, format: PreviewFormat | undefined): string | null {
  if (picture.kind !== "paged") return null;
  if (picture.drawnBy === "tempcode") return format?.verb === "Print…" ? "As it will print" : "The file itself";
  return `As ${{ libreoffice: "LibreOffice", word: "Word", excel: "Excel", powerpoint: "PowerPoint" }[picture.drawnBy]} draws it`;
}

/** "Page 2 of 5", "Slide 1 of 12", or the place in a whole of which only part was drawn. */
export function countLine(page: number, pages: number, picture: PreviewPicture, format: PreviewFormat | undefined): string {
  const shown = picture.kind === "paged" ? picture.shown : undefined;
  const at = shown ? shown.from + page - 1 : page;
  const of = shown ? shown.of : pages;
  return `${format?.unit === "slide" ? "Slide" : "Page"} ${at.toLocaleString("en-US")} of ${of.toLocaleString("en-US")}`;
}

type Draw = { status: "drawing" } | { status: "drawn"; drawn: Drawn } | { status: "failed"; message: string };

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

export function Preview({ source, title, kind, initial, readOnly, onClose, pageRows, engine, width, height, tight: tightProp }: PreviewProps) {
  const [format, setFormat] = useState(() => openingFormat(source.formats, kind, initial));
  const [run, setRun] = useState(0);
  const [draw, setDraw] = useState<Draw>({ status: "drawing" });
  const [zoom, setZoom] = useState<PagedZoom>("width");
  const [place, setPlace] = useState<{ page: number; pages: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [all, setAll] = useState(false);
  // The real Office app's own picture, asked for by his press alone.
  const [office, setOffice] = useState<{ app: OfficeApp; state: "ready" | "asleep" | "not open" | "none" } | null>(null);
  const [checking, setChecking] = useState<"waking" | "drawing" | null>(null);
  // How many pages this format held when last drawn here: what "Drawing 5 pages" can say.
  const known = useRef(new Map<string, number>());
  // A draw he asked for by a press (Check in Word, another sheet): dropped when he moves on or the frame goes.
  const pressed = useRef<AbortController | null>(null);
  // A render that went under the pages (drawn again elsewhere) is drawn once more by itself, once.
  const redrawn = useRef<string | null>(null);

  const current = source.formats.find((f) => f.id === format) ?? source.formats[0];
  const formatId = current?.id ?? "";

  // The frame's own width: the column folds and the bar thins by it, not by the window's.
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(width ?? 0);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el || width) return;
    const read = (): void => setFrameWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  const folded = frameWidth > 0 && frameWidth < PREVIEW_FOLD;
  const tiny = frameWidth > 0 && frameWidth < PREVIEW_TINY;

  // One draw per format, per source and per Retry; a draw that is overtaken is dropped.
  useEffect(() => {
    if (!formatId) return;
    const job = new AbortController();
    pressed.current?.abort();
    pressed.current = null;
    setDraw({ status: "drawing" });
    setPlace(null);
    setChecking(null);
    Promise.resolve()
      .then(() => source.draw(formatId, { signal: job.signal, ...(all ? { pages: [1, Number.MAX_SAFE_INTEGER] as [number, number] } : {}) }))
      .then(
        (drawn) => {
          if (job.signal.aborted) return;
          if (drawn.picture.kind === "paged") known.current.set(formatId, drawn.picture.shown?.of ?? drawn.picture.pages);
          setDraw({ status: "drawn", drawn });
        },
        (error: unknown) => !job.signal.aborted && setDraw({ status: "failed", message: messageOf(error, "It could not be drawn") }),
      );
    return () => {
      job.abort();
      pressed.current?.abort();
    };
  }, [source, formatId, run, all]);

  // Whether the real app can be asked: read once per format, since a machine wakes and sleeps while he looks.
  const paged = current?.paged ?? false;
  useEffect(() => {
    setOffice(null);
    if (!source.office || !paged) return;
    let live = true;
    source.office().then(
      (got) => live && setOffice(got),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [source, formatId, paged]);

  const pick = (id: string): void => {
    if (id === formatId) return;
    setAll(false);
    setFormat(id);
  };

  const checkInOffice = (): void => {
    if (!office || !formatId || checking) return;
    const job = new AbortController();
    pressed.current = job;
    setChecking(office.state === "asleep" ? "waking" : "drawing");
    source.draw(formatId, { by: "office", signal: job.signal }).then(
      (drawn) => {
        // He moved to another format while Word drew: its picture is not this format's.
        if (job.signal.aborted) return;
        setChecking(null);
        setDraw({ status: "drawn", drawn });
      },
      (error: unknown) => {
        if (job.signal.aborted) return;
        setChecking(null);
        // LibreOffice's picture stays; why Word's did not come is said once.
        const words = error instanceof NotInReach ? `${error.app} is not in reach` : messageOf(error, `${office.app} could not draw it`);
        void loadToast().then((toast) => toast.error(words));
      },
    );
  };

  const runExport = async (): Promise<void> => {
    if (!formatId || exporting) return;
    setExporting(true);
    try {
      const made = await source.export(formatId);
      try {
        globalThis.localStorage?.setItem(lastKey(kind), formatId);
      } catch {
        // private mode / quota
      }
      // The system's own save or print dialog is the answer, unless the source says where the file went.
      if (made.where) void loadToast().then((toast) => toast(`Saved ${made.name} to ${made.where}`));
    } catch (error) {
      void loadToast().then((toast) => toast.error(messageOf(error, current?.verb === "Print…" ? "It could not be printed" : "It could not be exported")));
    } finally {
      setExporting(false);
    }
  };

  const setup = source.setup;
  const change = useCallback(
    (next: Partial<CommonSetup>): void => {
      if (!setup) return;
      void setup.set({ common: { ...setup.common, ...next } }).then(
        () => setRun((n) => n + 1),
        (error: unknown) => void loadToast().then((toast) => toast.error(messageOf(error, "The page set-up could not be changed"))),
      );
    },
    [setup],
  );

  const picture = draw.status === "drawn" ? draw.drawn.picture : null;
  const drops = draw.status === "drawn" ? draw.drawn.drops : [];
  const pageSection = setup && paged ? <PageSection setup={setup.common} onChange={change} rows={pageRows} /> : null;
  const hasColumn = !!pageSection || drops.length > 0;

  // The column beside the paper: Page, then what this format drops. Nothing when there is neither.
  const column = hasColumn ? (
    <div data-preview-column className="flex min-w-0 flex-col">
      {pageSection}
      {drops.length > 0 ? (
        <>
          <ColumnHeading first={!pageSection}>In this format</ColumnHeading>
          {drops.map((line) => (
            <div key={line} className="text-[13px] leading-5 text-pretty not-first:mt-1">
              {line}
            </div>
          ))}
        </>
      ) : null}
    </div>
  ) : null;

  const by = picture ? drawnByLine(picture, current) : null;
  const officeName = office?.app;
  const canCheck = !!office && (office.state === "ready" || office.state === "asleep") && picture?.kind === "paged" && picture.drawnBy !== office.app.toLowerCase() && !checking;
  const part = picture?.kind === "paged" && picture.shown && picture.shown.to < picture.shown.of ? picture.shown : null;

  /** The line over the first sheet: who drew it, or what is happening to it; under it, folded, what the format drops. */
  const head = (line: ReactNode, action?: ReactNode): ReactNode => (
    <div data-preview-head className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
        {line}
        {action ? <span className="ms-auto shrink-0">{action}</span> : null}
      </div>
      {folded && drops.length > 0 ? (
        <div data-preview-drops className="flex flex-col text-xs leading-4 text-muted-foreground">
          {drops.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
      ) : null}
    </div>
  );

  const pagedHead = (): ReactNode => {
    if (checking)
      return head(
        <>
          <Spinner className="size-3" aria-hidden="true" />
          <span className="min-w-0 truncate">{checking === "waking" ? "Waking Windows" : `Drawing in ${officeName}`}</span>
        </>,
      );
    if (part)
      return head(
        <span className="min-w-0 truncate">The first {part.to.toLocaleString("en-US")} pages</span>,
        <Button variant="ghost" size="xs" onClick={() => setAll(true)}>
          Draw all {part.of.toLocaleString("en-US")}
        </Button>,
      );
    return head(
      <span className="min-w-0 truncate">{by}</span>,
      canCheck ? (
        <Button variant="ghost" size="xs" onClick={checkInOffice}>
          Check in {officeName}
        </Button>
      ) : undefined,
    );
  };

  let body: ReactNode;
  if (draw.status === "failed") {
    body = (
      <div data-preview-failed className="flex min-h-0 min-w-0 flex-1 justify-center gap-4 overflow-auto bg-(--stage) px-6 pt-4 pb-6">
        <div className="flex min-h-[360px] w-[440px] max-w-full">
          <EmptyState title="Can't draw this format here" line={`${sentence(draw.message)} Exporting still works.`} action={{ label: "Retry", onClick: () => setRun((n) => n + 1) }} />
        </div>
        {/* The page set-up is still his to change; what the format drops is not known without a picture. */}
        {pageSection && !folded ? (
          <div data-preview-column className="flex w-[232px] shrink-0 flex-col pt-0.5">
            {pageSection}
          </div>
        ) : null}
      </div>
    );
  } else if (draw.status === "drawing" || !picture) {
    const pages = known.current.get(formatId);
    const waiting = (
      <>
        <Spinner className="size-3" aria-hidden="true" />
        <span className="min-w-0 truncate">{paged ? (pages ? `Drawing ${pages.toLocaleString("en-US")} ${pages === 1 ? "page" : "pages"}` : "Drawing the pages") : "Drawing the file"}</span>
      </>
    );
    body = paged ? (
      <PagedSkeleton
        head={head(waiting)}
        side={pageSection ? <div data-preview-column className="flex min-w-0 flex-col">{pageSection}</div> : undefined}
        wide={current?.unit === "slide"}
        {...(setup ? { aspect: paperAspect(setup.common) } : {})}
        width={width}
      />
    ) : (
      <Plain>
        <div role="status" className="flex min-h-6 items-center gap-2 text-xs leading-4 text-muted-foreground">
          {waiting}
        </div>
      </Plain>
    );
  } else if (picture.kind === "paged") {
    body = (
      <PagedView
        // A new render is a new file: its place and its pages start again.
        key={picture.pdf.rev}
        bytes={picture.pdf}
        zoom={zoom}
        label={`${title} as ${current?.label ?? "pages"}`}
        onPage={(page, pages) => setPlace({ page, pages })}
        onFail={(message) => {
          // The host no longer has this render (the document was drawn again elsewhere): draw it once more, and say so only if that fails too.
          const rev = picture.pdf.rev;
          if (redrawn.current !== rev) {
            redrawn.current = rev;
            setRun((n) => n + 1);
          } else setDraw({ status: "failed", message });
        }}
        head={pagedHead()}
        side={column && !folded ? column : undefined}
        dim={!!checking}
        wide={current?.unit === "slide"}
        {...(engine ? { engine } : {})}
        {...(width ? { width } : {})}
        {...(height ? { height } : {})}
      />
    );
  } else {
    body = <Unpaged picture={picture} title={title} frameWidth={frameWidth} drops={drops} folded={folded} column={column} onDraw={(sheet) => void redrawSheet(sheet)} />;
  }

  /** A table's other sheet (CSV holds one): drawn again for that sheet. */
  async function redrawSheet(sheet: string): Promise<void> {
    pressed.current?.abort();
    const job = new AbortController();
    pressed.current = job;
    try {
      const drawn = await source.draw(formatId, { sheet, signal: job.signal });
      if (!job.signal.aborted) setDraw({ status: "drawn", drawn });
    } catch (error) {
      if (!job.signal.aborted) setDraw({ status: "failed", message: messageOf(error, "It could not be drawn") });
    }
  }

  // Opening takes the keys: the editor under the frame is out of reach, so the way back holds the focus first.
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus({ preventScroll: true }), []);

  const verb = current?.verb ?? "Export";
  return (
    <div
      ref={frame}
      data-preview={formatId}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      onKeyDown={(event) => {
        // Escape goes back to the words, unless a menu or the Page popover (drawn outside the frame) had it first.
        if (event.key !== "Escape" || event.defaultPrevented || !frame.current?.contains(event.target as Node)) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div role="toolbar" aria-label="Preview" className="relative z-5 flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-background px-3">
        {tiny ? (
          <Tip label={readOnly ? "Back" : "Edit"}>
            <Button ref={back} variant="ghost" size="icon-sm" aria-label={readOnly ? "Back" : "Edit"} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={onClose}>
              <ChevronLeft />
            </Button>
          </Tip>
        ) : (
          <Button ref={back} variant="ghost" size="sm" className="shrink-0 gap-0.5 ps-1 pe-2 font-medium text-muted-foreground hover:text-foreground" onClick={onClose}>
            <ChevronLeft className="size-4" />
            {readOnly ? "Back" : "Edit"}
          </Button>
        )}
        <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-border" />
        <FormatControl formats={source.formats} value={formatId} onPick={pick} tight={tightProp} />
        {paged && !tiny ? <ZoomMenu zoom={zoom} onZoom={setZoom} /> : null}
        {picture?.kind === "paged" && place ? (
          <span data-preview-count aria-live="off" className="shrink-0 px-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {countLine(place.page, place.pages, picture, current)}
          </span>
        ) : null}
        <div data-bar-end className="ms-auto flex shrink-0 items-center gap-0.5 ps-2">
          {folded && pageSection ? (
            <LazyPopover
              label="Page"
              align="end"
              className="w-[264px] px-3 pt-2 pb-3"
              tip={{ label: "Page" }}
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label="Page" className="text-muted-foreground hover:text-foreground">
                  <SlidersHorizontal />
                </Button>
              }
            >
              {pageSection}
            </LazyPopover>
          ) : null}
          <Button size="sm" className="ms-1.5" disabled={!formatId} onClick={() => void runExport()}>
            <BusyLabel busy={exporting} label={verb} />
          </Button>
        </div>
      </div>
      {body}
    </div>
  );
}

/** A reason as one sentence: capital first, one full stop. */
/** A paper's shape as its width over its height, for the loading shape. */
const paperAspect = (setup: CommonSetup): number => {
  const { width: w, height: h } = PAPER_POINTS[setup.paper];
  return setup.orientation === "landscape" ? h / w : w / h;
};

const sentence = (text: string): string => {
  const t = text.trim().replace(/\.+$/, "");
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : "";
};

/**
 * The format: a segmented control while it fits the bar, a menu button when
 * it does not. "Fits" is measured, the bar's room against the control's own
 * width, never a breakpoint: the labels and the bar's other controls differ
 * by kind and by machine.
 */
function FormatControl({ formats, value, onPick, tight }: { formats: readonly PreviewFormat[]; value: string; onPick(id: string): void; tight?: boolean | undefined }) {
  const slot = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(tight === undefined ? true : !tight);
  useLayoutEffect(() => {
    if (tight !== undefined) return setFits(!tight);
    const el = slot.current;
    const bar = el?.parentElement;
    const measure = ruler.current;
    if (!el || !bar || !measure) return;
    const read = (): void => {
      // What the bar's other controls take, and what is left for this one.
      let others = 0;
      for (const child of Array.from(bar.children)) {
        if (child === el) continue;
        const style = getComputedStyle(child);
        // The end group's margin is `auto`: it resolves to whatever room is free, which is the very room being measured.
        const end = (child as HTMLElement).dataset.barEnd !== undefined;
        others += (child as HTMLElement).offsetWidth + (end ? 0 : parseFloat(style.marginInlineStart || "0")) + parseFloat(style.marginInlineEnd || "0");
      }
      const style = getComputedStyle(bar);
      const gaps = (bar.children.length - 1) * (parseFloat(style.columnGap) || 0);
      const room = bar.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd) - others - gaps;
      setFits(measure.offsetWidth <= room);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(bar);
    for (const child of Array.from(bar.children)) if (child !== el) observer.observe(child);
    return () => observer.disconnect();
  }, [tight, formats]);

  const current = formats.find((f) => f.id === value);
  const segment = (hidden: boolean): ReactNode => (
    <Tabs value={value} onValueChange={(id) => onPick(String(id))} className="shrink-0 gap-0" {...(hidden ? { "aria-hidden": true, inert: true } : {})}>
      <TabsList aria-label="Format" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-7">
        <TabsIndicator />
        {formats.map((f) => (
          <TabsTrigger key={f.id} value={f.id} className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
            {f.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
  const rows: MenuRow[] = formats.map((f) => ({ kind: "item", id: f.id, label: f.label, checked: f.id === value, ...(f.ext ? { hint: `.${f.ext}` } : {}) }));
  return (
    <div ref={slot} data-preview-format={fits ? "segment" : "menu"} className="relative flex min-w-0 shrink-0 items-center">
      {/* The control at its own width, off screen, so the choice never depends on which of the two is showing. */}
      {tight === undefined ? (
        <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute top-0 left-0 w-max">
          {segment(true)}
        </div>
      ) : null}
      {fits ? (
        segment(false)
      ) : (
        <RowsMenu
          label="Format"
          align="start"
          rows={rows}
          onPick={onPick}
          trigger={
            <Button variant="ghost" size="sm" aria-label={`Format: ${current?.label ?? ""}`} className="shrink-0 px-2 font-medium">
              {current?.label ?? "Format"}
              <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
          }
        />
      )}
    </div>
  );
}

function ZoomMenu({ zoom, onZoom }: { zoom: PagedZoom; onZoom(zoom: PagedZoom): void }) {
  const rows: MenuRow[] = PAGED_ZOOMS.map((z) => ({ kind: "item", id: String(z), label: ZOOM_WORDS[String(z)]!, checked: z === zoom }));
  return (
    <RowsMenu
      label="Zoom"
      align="start"
      rows={rows}
      onPick={(id) => {
        const z = PAGED_ZOOMS.find((value) => String(value) === id);
        if (z !== undefined) onZoom(z);
      }}
      trigger={
        <Button variant="ghost" size="sm" aria-label={`Zoom: ${ZOOM_WORDS[String(zoom)]}`} className="shrink-0 px-2 font-normal text-muted-foreground">
          {ZOOM_WORDS[String(zoom)]}
          <ChevronDown className="size-3" />
        </Button>
      }
    />
  );
}

/** A section's name in the column: 12/16 medium muted, 20px after the section before it. */
function ColumnHeading({ children, first }: { children: ReactNode; first?: boolean }) {
  return <div className={`py-1 text-xs leading-4 font-medium text-muted-foreground ${first ? "" : "mt-5"}`}>{children}</div>;
}

/** One row of the Page section: its name, and a quiet menu of its values at the row's end. */
export function PageMenuRow<T extends string>({ label, value, options, onPick, disabled }: { label: string; value: string; options: readonly { id: T; label: string }[]; onPick(id: T): void; disabled?: boolean }) {
  const rows: MenuRow[] = options.map((o) => ({ kind: "item", id: o.id, label: o.label, checked: o.label === value }));
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5">{label}</span>
      <RowsMenu
        label={label}
        align="end"
        rows={rows}
        onPick={(id) => onPick(id as T)}
        trigger={
          <Button variant="ghost" size="xs" disabled={disabled} aria-label={`${label}: ${value}`} className="-me-2 max-w-[156px] shrink-0 font-normal text-muted-foreground">
            <span className="min-w-0 truncate">{value}</span>
            <ChevronDown />
          </Button>
        }
      />
    </div>
  );
}

/** One row of the Page section that is on or off. */
export function PageSwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }) {
  const id = useId();
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      <span id={id} className="min-w-0 flex-1 truncate text-[13px] leading-5">
        {label}
      </span>
      <Switch aria-labelledby={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const ORIENTATIONS = [
  { id: "portrait", label: "Portrait" },
  { id: "landscape", label: "Landscape" },
] as const;
const MARGINS = (Object.keys(MARGIN_PRESETS) as MarginPreset[]).map((id) => ({ id, label: id }));
const PAPER_ROWS = PAPERS.map((id) => ({ id, label: id }));

/** The Page section: what every kind's page set-up shares, then the kind's own rows. */
function PageSection({ setup, onChange, rows }: { setup: CommonSetup; onChange(next: Partial<CommonSetup>): void; rows?: ReactNode }) {
  return (
    <div data-preview-page className="flex min-w-0 flex-col">
      <ColumnHeading first>Page</ColumnHeading>
      <PageMenuRow<PaperName> label="Paper" value={setup.paper} options={PAPER_ROWS} onPick={(paper) => onChange({ paper })} />
      <PageMenuRow label="Orientation" value={setup.orientation === "landscape" ? "Landscape" : "Portrait"} options={ORIENTATIONS} onPick={(orientation) => onChange({ orientation })} />
      <PageMenuRow<MarginPreset> label="Margins" value={marginPresetOf(setup.margins) ?? "Custom"} options={MARGINS} onPick={(preset) => onChange({ margins: { ...MARGIN_PRESETS[preset] } })} />
      <PageSwitchRow label="Headers and footers" checked={setup.header || setup.footer} onChange={(on) => onChange({ header: on, footer: on })} />
      {rows}
    </div>
  );
}

/** The body for a file that is its own text or files: on `background`, at most 624px of measure. */
function Plain({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-background">
      <div className="mx-auto flex max-w-[672px] min-w-0 flex-col gap-2 px-6 pt-4 pb-8">{children}</div>
    </div>
  );
}

const WEB_WIDTHS = [
  { id: "phone", label: "Phone", px: 390 },
  { id: "tablet", label: "Tablet", px: 768 },
  { id: "desktop", label: "Desktop", px: 1280 },
] as const;

/**
 * A web page for its own frame: no script runs in it (the frame's sandbox),
 * nothing it names is fetched (the policy, first thing in the head, before
 * anything the page itself says), and a link in it opens nothing (a new
 * window is its target, and the sandbox allows none). A picture the page
 * names on the web is blank here and loads when the saved file is opened.
 */
export function sealedPage(html: string): string {
  const seal = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">`;
  // `<head>` itself, never `<header>`; a page with no head is given one, since a policy in the body is ignored.
  const head = /<head(\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (tag) => `${tag}${seal}`) : `<head>${seal}</head>${html}`;
}

function Unpaged({ picture, title, frameWidth, drops, folded, column, onDraw }: { picture: Exclude<PreviewPicture, { kind: "paged" }>; title: string; frameWidth: number; drops: readonly string[]; folded: boolean; column: ReactNode; onDraw(sheet: string): void }) {
  const [web, setWeb] = useState<(typeof WEB_WIDTHS)[number]["id"]>("desktop");
  // The losses of a file with no paper to sit beside: 12px lines over it when the column is folded, else the column.
  const losses =
    folded && drops.length > 0 ? (
      <div data-preview-drops className="flex flex-col text-xs leading-4 text-muted-foreground">
        {drops.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
    ) : null;
  const beside = column && !folded ? <div className="sticky top-4 w-[232px] shrink-0 self-start pt-0.5">{column}</div> : null;

  if (picture.kind === "html") {
    const chosen = WEB_WIDTHS.find((w) => w.id === web)!;
    const inset = folded ? 12 : 24;
    const room = Math.max(0, (frameWidth || chosen.px + inset * 2) - inset * 2 - (beside ? 232 + 16 : 0));
    // Zoomed down to fit, never up: a phone's page is a phone's size.
    const scale = Math.min(1, room / chosen.px);
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-(--stage)">
        <div className="flex w-max min-w-full justify-center gap-4 pt-4 pb-6" style={{ paddingInline: inset }}>
          <div className="flex min-w-0 flex-col gap-2" style={{ width: Math.round(chosen.px * scale) }}>
            <div className="flex min-h-6 items-center">
              <Tabs value={web} onValueChange={(id) => setWeb(id as typeof web)} className="gap-0">
                <TabsList aria-label="Width" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
                  <TabsIndicator />
                  {WEB_WIDTHS.map((w) => (
                    <TabsTrigger key={w.id} value={w.id} className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
                      {w.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            {losses}
            <div className="overflow-hidden rounded-lg bg-(--paper) outline-1 outline-(--image-outline)" style={{ width: Math.round(chosen.px * scale), height: Math.round(WEB_HEIGHT * scale) }}>
              <iframe
                title={`${title} as a web page`}
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={sealedPage(picture.html)}
                className="block origin-top-left border-0"
                style={{ width: chosen.px, height: WEB_HEIGHT, transform: `scale(${scale})` }}
              />
            </div>
          </div>
          {beside}
        </div>
      </div>
    );
  }

  const inner =
    picture.kind === "text" ? (
      <pre data-preview-text tabIndex={0} className="focus-ring m-0 rounded-xl bg-card px-5 py-4 font-mono text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap outline-1 outline-border select-text">
        {picture.text}
      </pre>
    ) : picture.kind === "table" ? (
      <TablePicture picture={picture} onDraw={onDraw} />
    ) : picture.kind === "files" ? (
      <div data-preview-files className="grid grid-cols-2 gap-x-3 gap-y-4 @min-[640px]/preview:grid-cols-3">
        {picture.files.map((file) => (
          <figure key={file.name} className="m-0 flex min-w-0 flex-col gap-1">
            <img src={file.thumb} alt="" className="block aspect-video w-full rounded-[3px] object-cover outline-1 outline-(--image-outline)" />
            <figcaption className="truncate text-xs leading-4 text-muted-foreground">{file.name}</figcaption>
          </figure>
        ))}
      </div>
    ) : (
      <VideoPicture picture={picture} title={title} />
    );
  return (
    <div className="@container/preview min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-background">
      <div className="flex w-full justify-center gap-4 px-6 pt-4 pb-8">
        <div className={`flex min-w-0 flex-1 flex-col gap-2 ${picture.kind === "text" ? "max-w-[624px]" : "max-w-[640px]"}`}>
          {losses}
          {inner}
        </div>
        {beside}
      </div>
    </div>
  );
}

/** The height a web page's frame is given before its own scroll takes over. */
const WEB_HEIGHT = 900;

/** A table as a file of plain values holds it (CSV): the sheet it is of, then the raw cells. */
function TablePicture({ picture, onDraw }: { picture: Extract<PreviewPicture, { kind: "table" }>; onDraw(sheet: string): void }) {
  const sheets = picture.sheets ?? [];
  return (
    <div data-preview-table className="flex min-w-0 flex-col gap-2">
      {sheets.length > 1 ? (
        <PageMenuRow label="Sheet" value={picture.name} options={sheets.map((s) => ({ id: s, label: s }))} onPick={onDraw} />
      ) : null}
      <div className="overflow-x-auto">
        <table className="border-collapse text-[13px] leading-5 tabular-nums">
          <tbody>
            {picture.rows.map((row, r) => (
              <tr key={r} className="border-b border-border">
                {row.map((cell, c) => (
                  <td key={c} className="h-8 px-3 whitespace-nowrap first:ps-0 last:pe-0">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** A video as a file: its first frame, and the film itself once he presses Play (its bytes are read then, not before). */
function VideoPicture({ picture, title }: { picture: Extract<PreviewPicture, { kind: "video" }>; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const facts = useMemo(() => `${clock(picture.seconds)}, ${picture.size}`, [picture.seconds, picture.size]);

  const toggle = async (): Promise<void> => {
    if (url) {
      const el = video.current;
      if (el) void (el.paused ? el.play() : el.pause());
      return;
    }
    setLoading(true);
    try {
      const parts: BlobPart[] = [];
      const step = 4 * 1024 * 1024;
      for (let offset = 0; offset < picture.video.size; offset += step) parts.push((await picture.video.read(offset, Math.min(step, picture.video.size - offset))) as Uint8Array<ArrayBuffer>);
      setUrl(URL.createObjectURL(new Blob(parts, { type: "video/mp4" })));
    } catch (error) {
      void loadToast().then((toast) => toast.error(messageOf(error, "The video could not be read")));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-preview-video className="flex max-w-[640px] min-w-0 flex-col gap-2">
      <div className="relative overflow-hidden rounded-lg bg-(--matte) outline-1 outline-(--image-outline)">
        {url ? (
          <video ref={video} src={url} poster={picture.poster} autoPlay aria-label={title} className="block w-full" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} />
        ) : (
          <img src={picture.poster} alt="" className="block w-full" />
        )}
      </div>
      <div className="flex h-8 items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label={playing ? "Pause" : "Play"} disabled={loading} onClick={() => void toggle()}>
          {loading ? <BusyLabel busy label="" /> : playing ? <Pause /> : <Play />}
        </Button>
        <span className="text-[13px] leading-5 tabular-nums">{clock(at)}</span>
        <span className="ms-auto text-xs whitespace-nowrap text-muted-foreground tabular-nums">{facts}</span>
      </div>
    </div>
  );
}
