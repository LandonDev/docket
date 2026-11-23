import { useEffect, useRef, type KeyboardEvent } from "react";
import type { FileEntry } from "@shared/work/files";
import { X } from "../../chrome/icons";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { chordKey } from "../../lib/keys";
import { shortcutFor } from "../../lib/settings";
import { KindGlyph } from "./KindGlyph";
import { FilePreviewPane } from "./Preview";
import type { PictureFrom } from "./previews";

/**
 * Quick Look (docs/DESIGN.md "The Files place"): Space on a selection. A layer over the page shows the file read
 * only: its pages, its picture or a player, with its name, where it is kept, and Open. The list under it keeps
 * the keyboard: the arrows walk it and the layer follows with no motion; Space or Escape closes, and so does a
 * press outside. It opens with one short scale and fade, never on the arrow keys, and mounts no editor. Tab stays
 * on its own controls (the arrows still walk the list from them), and closing gives the list its focus back.
 */

/** What Tab stops on inside the layer. */
const STOPS = "button:not([disabled]), a[href], video[controls], audio[controls], [tabindex]:not([tabindex='-1'])";
/** The keys the list under the layer walks with, heard on the layer's own controls too. */
const WALK = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
export function QuickLook({
  entry,
  where,
  from,
  onOpen,
  onClose,
  onFetch,
  still = false,
}: {
  entry: FileEntry;
  /** where it is kept, in words */
  where: string;
  from: PictureFrom | null;
  onOpen(entry: FileEntry): void;
  onClose(): void;
  onFetch?(entry: FileEntry): Promise<void>;
  /** drawn open from the first paint (a preview page): it does not play its entrance */
  still?: boolean;
}) {
  const layer = useRef<HTMLDivElement | null>(null);
  // The element that had focus when the layer opened: the list, which keeps the keyboard.
  const list = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    list.current = back;
    const onTab = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Tab" || !layer.current) return;
      const stops = [...layer.current.querySelectorAll<HTMLElement>(STOPS)];
      if (!stops.length) return;
      event.preventDefault();
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
      stops[next]!.focus();
    };
    document.addEventListener("keydown", onTab, true);
    return () => {
      document.removeEventListener("keydown", onTab, true);
      // Closed with focus on its own controls (now gone): the list has it again.
      const now = document.activeElement;
      if (back?.isConnected && (!now || now === document.body || layer.current?.contains(now))) back.focus({ preventScroll: true });
    };
  }, []);
  // An arrow on one of the layer's controls walks the list, as it does from the list itself.
  const walk = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = list.current;
    if (!WALK.has(event.key) || chordKey(event) || !target?.isConnected || (event.target as HTMLElement).closest("video, audio, input")) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: event.key, shiftKey: event.shiftKey, bubbles: true, cancelable: true }));
  };
  // Where the place is kept: cut only at a word, so a narrow layer shows its first word whole or none of it.
  const space = where.indexOf(" ");
  const first = space < 0 ? where : where.slice(0, space);
  const rest = space < 0 ? "" : where.slice(space);
  return (
    <div data-files-quicklook className="fixed inset-0 z-(--layer-dialog) grid place-items-center p-12" onMouseDown={(event) => (event.target === event.currentTarget ? onClose() : undefined)}>
      <div
        ref={layer}
        onKeyDown={walk}
        role="dialog"
        aria-label={`Quick Look: ${entry.name}`}
        className={`flex h-full max-h-[760px] w-full max-w-[1000px] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-overlay ring-1 ring-border ${still ? "" : "transition-[opacity,scale] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none starting:scale-[0.96] starting:opacity-0"}`}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border ps-3 pe-2">
          <KindGlyph kind={entry.kind} />
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{entry.name}</span>
          {/* One line tall: the first word goes to a hidden second line when it does not fit beside the name. */}
          <span data-files-quicklook-where className="flex h-4 min-w-0 flex-1 flex-wrap overflow-hidden text-xs leading-4 text-muted-foreground">
            <span className="sr-only">{where}</span>
            <span aria-hidden className="h-4 w-0" />
            <span aria-hidden className="shrink-0 whitespace-pre">{first}</span>
            {rest ? (
              <span aria-hidden className="min-w-0 grow basis-0 truncate whitespace-pre">
                {rest}
              </span>
            ) : null}
          </span>
          {/* The list keeps the keyboard, so these never take focus on a press: Return still opens what the arrows rest on. */}
          <Button variant="secondary" size="sm" data-files-quicklook-open className="shrink-0" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpen(entry)}>
            {entry.folder ? "Open Folder" : "Open"}
          </Button>
          <Tip label="Close" shortcut={shortcutFor("Files (Work)", "Quick Look")}>
            <Button variant="ghost" size="icon-sm" aria-label="Close Quick Look" className="shrink-0 text-muted-foreground" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
              <X />
            </Button>
          </Tip>
        </div>
        <FilePreviewPane from={from} entry={entry} {...(onFetch ? { onFetch } : {})} />
      </div>
    </div>
  );
}
