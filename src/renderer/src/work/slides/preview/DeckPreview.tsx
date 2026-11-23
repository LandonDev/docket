import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DeckFacts, DeckReach } from "@shared/contract-work-slides";
import { registry } from "../../../lib/connection";
import type { CanvasShell } from "../../canvas/kind";
import { useWorkCommands } from "../../formats/command";
import { paperFor } from "../../formats/model";
import { MARGIN_PRESETS, PAPERS, type PaperName, type PreviewFormat } from "../../formats/preview";
import { PageMenuRow, PageSwitchRow, Preview } from "../../formats/PreviewFrame";
import { Export } from "../../icons";
import { deckStoreOf, useDeck } from "../deck";
import { feedMore } from "../more";
import { onPreviewAsk, PreviewOpener, type PreviewOn } from "./ask";
import { deckPreviewSource, type DeckLayout, type DeckOptions } from "./source";

/**
 * The deck's Preview (docs/agents/work-slides.md "Preview and export"; the look is docs/DESIGN.md "Work editors:
 * Preview"): a state of the item over the deck, which stays mounted under it, unseen and out of reach. Export… in
 * the pane's More, File → Export… and the Present menu's Preview open it on the format he last used; File → Print…
 * and ⌘P open it on Print.
 */

type Request = <T>(env: string, method: string, params: unknown) => Promise<T>;

export const defaultOptions = (locale: string): DeckOptions => ({
  layout: "slides",
  hidden: false,
  common: { paper: paperFor(locale), orientation: "portrait", margins: { ...MARGIN_PRESETS.Narrow }, header: false, footer: true },
  picture: { type: "png", width: 1920 },
  video: { seconds: 5, height: 1080, by: "tempcode" },
});

/** A layout's name, as the Layout row says it. */
const LAYOUTS: Array<{ id: string; label: string; layout: DeckLayout }> = [
  { id: "slides", label: "Slides", layout: "slides" },
  { id: "notes", label: "Notes pages", layout: "notes" },
  ...([2, 3, 4, 6] as const).map((n) => ({ id: `h${n}`, label: `Handouts, ${n} a page`, layout: { handouts: n } as DeckLayout })),
];
const layoutLabel = (layout: DeckLayout): string => LAYOUTS.find((l) => JSON.stringify(l.layout) === JSON.stringify(layout))?.label ?? "Slides";
const PAPER_ROWS = PAPERS.map((id) => ({ id, label: id }));
const TYPES = [
  { id: "png", label: "PNG" },
  { id: "jpeg", label: "JPEG" },
] as const;
const WIDTHS = [1280, 1920, 3840] as const;
const SECONDS = [3, 5, 10] as const;
const HEIGHTS = [720, 1080] as const;
const MAKERS = [
  { id: "tempcode", label: "TempCode" },
  { id: "powerpoint", label: "PowerPoint" },
] as const;

/**
 * The rows of a format, as the column draws them: Layout, Paper for paper, and Hidden slides for a PDF or Print;
 * Type and Size for pictures; Each slide, Quality and who makes it for a video. A row that would change nothing is
 * left out: Paper while the PDF is the slides themselves, Hidden slides on a deck with none, PowerPoint's video
 * where PowerPoint is out of reach.
 */
export function deckRows(
  format: PreviewFormat,
  o: { options: DeckOptions; set(next: Partial<DeckOptions>): void; hidden: number; aspect: number; reach: DeckReach | null },
): { page: ReactNode | null; own?: ReactNode } {
  const { options, set } = o;
  const hidden = o.hidden > 0 ? <PageSwitchRow label="Hidden slides" checked={options.hidden} onChange={(on) => set({ hidden: on })} /> : null;
  if (format.id === "pdf" || format.id === "print") {
    return {
      page: (
        <>
          <PageMenuRow label="Layout" value={layoutLabel(options.layout)} options={LAYOUTS} onPick={(id) => set({ layout: LAYOUTS.find((l) => l.id === id)!.layout })} />
          {options.layout === "slides" ? null : <PageMenuRow<PaperName> label="Paper" value={options.common.paper} options={PAPER_ROWS} onPick={(paper) => set({ common: { ...options.common, paper } })} />}
          {hidden}
        </>
      ),
    };
  }
  if (format.id === "pics") {
    const size = (w: number): string => `${w.toLocaleString("en-US")} by ${Math.round(w / o.aspect).toLocaleString("en-US")}`;
    return {
      page: null,
      own: (
        <>
          <PageMenuRow label="Type" value={options.picture.type === "jpeg" ? "JPEG" : "PNG"} options={TYPES} onPick={(type) => set({ picture: { ...options.picture, type } })} />
          <PageMenuRow label="Size" value={size(options.picture.width)} options={WIDTHS.map((w) => ({ id: String(w), label: size(w) }))} onPick={(w) => set({ picture: { ...options.picture, width: Number(w) as (typeof WIDTHS)[number] } })} />
          {hidden}
        </>
      ),
    };
  }
  if (format.id === "video") {
    const powerpoint = o.reach?.video === "ready" || o.reach?.video === "asleep";
    return {
      page: null,
      own: (
        <>
          <PageMenuRow label="Each slide" value={`${options.video.seconds} seconds`} options={SECONDS.map((s) => ({ id: String(s), label: `${s} seconds` }))} onPick={(s) => set({ video: { ...options.video, seconds: Number(s) as (typeof SECONDS)[number] } })} />
          <PageMenuRow label="Quality" value={`${options.video.height}p`} options={HEIGHTS.map((h) => ({ id: String(h), label: `${h}p` }))} onPick={(h) => set({ video: { ...options.video, height: Number(h) as (typeof HEIGHTS)[number] } })} />
          {powerpoint ? <PageMenuRow label="Made by" value={options.video.by === "powerpoint" ? "PowerPoint" : "TempCode"} options={MAKERS} onPick={(by) => set({ video: { ...options.video, by } })} /> : null}
          {hidden}
        </>
      ),
    };
  }
  return { page: null };
}

const linkRequest: Request = (env, method, params) => registry.linkOf(env).request(method, params);

/**
 * Wraps the deck's Body: answers Export… and Print…, puts Export… in the pane's More, hears the Present menu's
 * Preview, and draws Preview over the deck while it is up.
 */
export function DeckPreviewLayer({ env, itemId, shell, request = linkRequest, children }: { env: string; itemId: string; shell: CanvasShell; request?: Request; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const { view } = useDeck(deckStoreOf(itemId));
  const [on, setOn] = useState<PreviewOn | false>(false);
  // Each ask is a frame of its own: Print… while Preview shows another format opens it on Print anew.
  const [asked, setAsked] = useState(0);
  const show = useCallback((next: PreviewOn | false) => {
    setOn(next);
    if (next) setAsked((n) => n + 1);
  }, []);
  useEffect(() => onPreviewAsk(itemId, show), [itemId, show]);
  const ready = !!view;
  useEffect(() => {
    if (!ready) return;
    feedMore(shell, "export", [{ id: "export", label: "Export…", icon: Export, run: () => show("last") }]);
    return () => feedMore(shell, "export", null);
  }, [shell, ready, show]);
  useWorkCommands(root, ready ? { export: () => show("last"), print: () => show("print") } : {});
  const open = useCallback(() => show("last"), [show]);

  // What he picked stays for as long as the deck is open, so a second look opens where the first left off.
  const [options, setOptionsState] = useState<DeckOptions>(() => defaultOptions(globalThis.navigator?.language ?? "en-US"));
  const setOptions = useCallback((next: Partial<DeckOptions>) => setOptionsState((was) => ({ ...was, ...next })), []);
  const [facts, setFacts] = useState<DeckFacts | null>(null);
  const [reach, setReach] = useState<DeckReach | null>(null);
  // Whether PowerPoint is in reach: asked once each time Preview opens, since a machine wakes and sleeps meanwhile.
  const reachAsk = useMemo(() => (on ? request<DeckReach>(env, "work.slides.reach", { itemId }) : null), [on, asked, env, itemId, request]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    void reachAsk?.then(
      (r) => live && setReach(r),
      () => live && setReach(null),
    );
    return () => {
      live = false;
    };
  }, [reachAsk]);
  const rev = view?.rev;
  const source = useMemo(
    () =>
      deckPreviewSource({
        env,
        itemId,
        options,
        setOptions,
        reach: () => reachAsk ?? Promise.resolve({ pdf: "none", video: "none" }),
        onFacts: setFacts,
        request: (e, method, params) => request(e, method, params),
      }),
    // A new file (its rev) or a new choice is a new source: the frame draws it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env, itemId, rev, options, reachAsk, request],
  );
  const aspect = view?.size && view.size.height > 0 ? view.size.width / view.size.height : 16 / 9;
  const rowsFor = (format: PreviewFormat): { page: ReactNode | null; own?: ReactNode } => deckRows(format, { options, set: setOptions, hidden: facts?.hidden ?? view?.slides.filter((sl) => sl.hidden && sl.number !== null).length ?? 0, aspect, reach });

  const close = (): void => {
    setOn(false);
    // Back to the deck, where the keyboard was: the slide on the strip.
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-slides-strip] [tabindex="0"]')?.focus());
  };

  return (
    <PreviewOpener.Provider value={ready ? open : null}>
      <div ref={root} data-deck-preview={on || undefined} data-editor-keys="read" className="relative flex min-h-0 min-w-0 flex-1">
        <div className={`flex min-h-0 min-w-0 flex-1 ${on ? "invisible" : ""}`} inert={on ? true : undefined}>
          {children}
        </div>
        {on && view ? (
          <div className="absolute inset-0 z-10 flex min-h-0 flex-col">
            <Preview key={asked} source={source} title={view.name.replace(/\.pptx$/i, "")} kind="deck" {...(on === "print" ? { initial: "print" } : {})} onClose={close} rowsFor={rowsFor} />
          </div>
        ) : null}
      </div>
    </PreviewOpener.Provider>
  );
}
