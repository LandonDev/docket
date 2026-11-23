import { useCallback, useContext, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { ChevronDown, Play } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { bareKey, chordKey, keyHint, modOrCtrl } from "../../lib/keys";
import { sayError } from "../canvas/frame";
import type { ShowMode } from "@shared/slidesShow";
import type { ShowNative } from "./show/Show";
import { PreviewOpener } from "./preview/ask";

/**
 * Present (docs/DESIGN.md "The show"): a secondary split button at the end
 * of the deck's bar. The press starts the show from the slide on the stage;
 * the menu has the other ways in. The show itself is a chunk of its own,
 * loaded when the pointer first reaches the button.
 */

export type PresentAsk = { from: "start" | "here"; mode: ShowMode; display?: number };

const loadShow = (): Promise<typeof import("./show/Show")> => import("./show/Show");

/** Main's side of a show's windows; absent in a browser, where the slideshow takes the page's own full screen. */
const nativeShow = (): ShowNative | null => (typeof window === "undefined" ? null : (window.tcShow ?? null));

/** The keys that start a show while the keyboard is in the deck (shared.md "Keys": PowerPoint's own, and a clicker's F5). */
export function presentKey(event: Parameters<typeof bareKey>[0] & { key: string }): PresentAsk | null {
  if (event.key === "F5" && !chordKey(event)) return { from: event.shiftKey ? "here" : "start", mode: "full" };
  if (event.key !== "Enter" || !modOrCtrl(event)) return null;
  if (event.altKey) return event.shiftKey ? null : { from: "here", mode: "presenter" };
  return { from: event.shiftKey ? "start" : "here", mode: "full" };
}

const DISPLAY_KEY = "tc.show.display";

/**
 * The ways to present, as menu rows, and what a pick of one asks: shared by the button in the bar and the format
 * row's way out. Which display takes the slideshow is asked only where there is a choice; the one he picked is kept
 * for this window's session, so the main press goes where he last sent the slideshow, menu opened or not.
 */
export function usePresentMenu(onPresent: (ask: PresentAsk) => void, native: ShowNative | null = nativeShow()): { rows: MenuRow[]; onPick(id: string): void; present(): void; readDisplays(): void } {
  const [displays, setDisplays] = useState<Awaited<ReturnType<ShowNative["displays"]>>>([]);
  const [picked, setPicked] = useState<number | null>(null);
  // The deck's Preview, where its Body or bar gives one (preview/ask.ts): the deck as a PDF, handouts, pictures or a video.
  const preview = useContext(PreviewOpener);
  const readDisplays = useCallback(() => {
    void native?.displays().then(setDisplays, () => setDisplays([]));
  }, [native]);
  useEffect(() => {
    try {
      const raw = Number(sessionStorage.getItem(DISPLAY_KEY));
      if (raw) setPicked(raw);
    } catch {
      /* no storage: the other display, as by default */
    }
    readDisplays();
  }, [readDisplays]);
  const others = displays.filter((d) => !d.own);
  const display = displays.find((d) => d.id === picked)?.id ?? others[0]?.id;
  const ask = (from: PresentAsk["from"], mode: ShowMode): void => onPresent({ from, mode, ...(display !== undefined && mode !== "windowed" ? { display } : {}) });
  const rows: MenuRow[] = [
    { kind: "item", id: "start", label: "From the start", shortcut: keyHint("shift+mod+return") },
    { kind: "item", id: "here", label: "From this slide", shortcut: keyHint("mod+return") },
    { kind: "item", id: "presenter", label: "Presenter view", shortcut: keyHint("alt+mod+return") },
    ...(native ? ([{ kind: "item", id: "windowed", label: "In a window" }] satisfies MenuRow[]) : []),
    ...(preview ? ([{ kind: "sep" }, { kind: "item", id: "preview", label: "Preview" }] satisfies MenuRow[]) : []),
    ...(displays.length > 1
      ? ([{ kind: "sep" }, { kind: "label", label: "Slideshow on" }, ...displays.map((d) => ({ kind: "item" as const, id: `display:${d.id}`, label: d.label, checked: d.id === display, keepOpen: true }))] satisfies MenuRow[])
      : []),
  ];
  const onPick = (id: string): void => {
    if (id === "start") ask("start", "full");
    else if (id === "here") ask("here", "full");
    else if (id === "presenter") ask("here", "presenter");
    else if (id === "windowed") ask("here", "windowed");
    else if (id === "preview") preview?.();
    else if (id.startsWith("display:")) {
      const next = Number(id.slice(8));
      setPicked(next);
      try {
        sessionStorage.setItem(DISPLAY_KEY, String(next));
      } catch {
        /* kept for this menu alone */
      }
    }
  };
  return { rows, onPick, present: () => ask("here", "full"), readDisplays };
}

/** The show's own chunk, loaded when the pointer first reaches a way to present. */
export const warmShow = (): void => void loadShow().catch(() => undefined);

export function PresentButton({ onPresent, native = nativeShow() }: { onPresent(ask: PresentAsk): void; native?: ShowNative | null }) {
  const { rows, onPick, present, readDisplays } = usePresentMenu(onPresent, native);
  return (
    <div data-present className="ms-auto flex shrink-0 items-center gap-px" onPointerEnter={warmShow} onFocus={warmShow}>
      <Button variant="secondary" size="xs" className="rounded-e-none" aria-label="Present" onClick={present}>
        <Play className="size-2.5 fill-current" />
        <span className="@max-[560px]/bar:sr-only">Present</span>
      </Button>
      <RowsMenu
        label="Present"
        align="end"
        className="min-w-60"
        rows={rows}
        onPick={onPick}
        onOpenChange={(open) => open && readDisplays()}
        trigger={
          <Button variant="secondary" size="icon-xs" className="w-5 rounded-s-none" aria-label="Ways to present">
            <ChevronDown />
          </Button>
        }
      />
    </div>
  );
}

/** Starts the show for a press or a key; a show that cannot start says why once. */
export function present(run: (show: typeof import("./show/Show")) => Promise<unknown>): void {
  void loadShow()
    .then(run)
    .catch((error: unknown) => sayError(error, "Couldn't start the show"));
}
