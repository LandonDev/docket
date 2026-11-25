import { useEffect, useState } from "react";
import { DOCUMENT_LADDER, DocumentEditor, EditorKitProvider, type DocumentView, type FindHandle } from "work-kit/editor";
import type { MenuRow } from "../../chrome/menuRows";
import type { SavedLine } from "../canvas/kind";
import { FileHeader } from "../files/FileTabView";
import { notSavedWords } from "../files/fileText";
import { DOC_FONTS } from "./fonts";
import { OfflineLine, offlineWords } from "./DocumentCanvas";

/*
 * The document editor as a Files tab draws it, with no host: the header and its save line, the format row, the find bar,
 * and the offline line laid over the text's top padding. The editor runs on its own text (no collaboration).
 */

const noop = (): void => undefined;
const NOW = new Date(2026, 10, 25, 14, 5).getTime();
const menu: MenuRow[] = [{ kind: "item", id: "close", label: "Close Tab" }];
const idle = { disabled: false, pressed: false, run: noop };
const TEXT = `# Run of show

Doors open at 9:00 AM. Check-in runs at the North Ballroom desk until 10:30 AM.

## Morning

- 9:00 AM: doors and check-in
- 10:30 AM: opening match on the main stage
- 12:00 PM: lunch for players and staff

Bring the keys for the equipment room. The stage plot is in the Events folder.`;

function Editor({ view, find, offline }: { view: DocumentView; find?: boolean; offline?: boolean }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [handle, setHandle] = useState<FindHandle | null>(null);
  useEffect(() => void (find && handle?.open(true)), [find, handle]);
  const words = offline ? offlineWords({ kind: "offline", message: "", retry: null }, "the box") : null;
  return (
    <EditorKitProvider value={{ theme: "light", ladder: DOCUMENT_LADDER, fonts: DOC_FONTS }}>
      <div className="relative flex h-full flex-col">
        <div ref={setRow} data-doc-row className="flex-none" />
        <div className="relative min-h-0 flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10">{words ? <OfflineLine words={words} /> : null}</div>
          <div className="h-full overflow-x-hidden overflow-y-auto px-6 pt-8 pb-24 has-[.te-pages-stage]:bg-(--stage) has-[.te-pages-stage]:p-0">
            <div className="mx-auto max-w-[724px] pl-[52px]">
              <DocumentEditor documentName={`preview-${view}-${find ? "find" : "plain"}`} initialMarkdown={TEXT} editable formatRow formatRowInto={row} onPreview={noop} view={view} {...(find ? { find: true, onFind: setHandle } : {})} />
            </div>
          </div>
        </div>
      </div>
    </EditorKitProvider>
  );
}

function Tab({ line, children, height = 520 }: { line: SavedLine | null; children: React.ReactNode; height?: number }) {
  return (
    <div style={{ maxWidth: 864, height }} className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background">
      <FileHeader name="Run of show.tcdoc" line={line} where="Events" running={null} onRun={noop} onShowFolder={noop} rows={menu} onPick={noop} ask={idle} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** A document in a Files tab, saved: its format row and its text. */
export function DocumentSaved() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Tab line={{ state: "saved", at: NOW - 60_000 }}>
        <Editor view="flow" />
      </Tab>
    </div>
  );
}

/** Offline: the quiet line over the text's top padding, the text where it was; the save line keeps its last time. */
export function DocumentOffline() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Tab line={{ state: "saved", at: NOW - 60_000 }}>
        <Editor view="flow" offline />
      </Tab>
    </div>
  );
}

/**
 * Find with Replace open while a save is out, and a store the service refused. Pages is not drawn here: the editor
 * breaks a styled document's sheets by measuring lines, which this page's static render cannot (DocumentPages.dom.test.tsx
 * holds its frame).
 */
export function DocumentFind() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Tab line={{ state: "saving" }}>
        <Editor view="flow" find />
      </Tab>
      <Tab line={{ state: "conflict", detail: notSavedWords("the document was not stored: the disk is full"), actions: [{ id: "retry", label: "Retry", run: noop }] }} height={640}>
        <Editor view="flow" />
      </Tab>
    </div>
  );
}
