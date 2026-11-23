import type { FileEntry } from "@shared/work/files";
import { X } from "../../chrome/icons";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { shortcutFor } from "../../lib/settings";
import { KindGlyph } from "./KindGlyph";
import { FilePreviewPane } from "./Preview";
import type { PictureFrom } from "./previews";

/**
 * Quick Look (docs/DESIGN.md "The Files place"): Space on a selection. A layer over the page shows the file read
 * only: its pages, its picture or a player, with its name, where it is kept, and Open. The list under it keeps
 * the keyboard: the arrows walk it and the layer follows with no motion; Space or Escape closes, and so does a
 * press outside. It opens with one short scale and fade, never on the arrow keys, and mounts no editor.
 */
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
  return (
    <div data-files-quicklook className="fixed inset-0 z-(--layer-dialog) grid place-items-center p-12" onMouseDown={(event) => (event.target === event.currentTarget ? onClose() : undefined)}>
      <div
        role="dialog"
        aria-label={`Quick Look: ${entry.name}`}
        className={`flex h-full max-h-[760px] w-full max-w-[1000px] flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-overlay ring-1 ring-border ${still ? "" : "transition-[opacity,scale] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none starting:scale-[0.96] starting:opacity-0"}`}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border ps-3 pe-2">
          <KindGlyph kind={entry.kind} />
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{entry.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{where}</span>
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
