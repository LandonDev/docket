// bun run ui:preview src/renderer/src/chrome/PickerDialog.fixtures.tsx#PickerGallery --shot --fresh
// Export PickerGallery. The frame holds a chosen row without pointer or keyboard events.
import { useRef, type ReactNode } from "react";
import { FileList } from "./FilePicker";
import { PickerFrame, PickerNote } from "./PickerDialog";
import { SymbolList } from "./SymbolPicker";

const noop = () => {};
const files = [
  { path: "/guide/src/routes.ts", relative: "src/routes.ts", name: "routes.ts", positions: [], score: 0 },
  { path: "/guide/docs/routes.md", relative: "docs/routes.md", name: "routes.md", positions: [], score: 0 },
  { path: "/guide/README.md", relative: "README.md", name: "README.md", positions: [], score: 0 },
];
const range = { startLineNumber: 12, startColumn: 1, endLineNumber: 12, endColumn: 8 };
const symbols = [
  { uri: "file:///guide/src/routes.ts", name: "routeFor", kind: 11, containerName: "Router", range },
  { uri: "file:///guide/src/routes.ts", name: "Route", kind: 25, containerName: "RouteMap", range },
];

function Frame({ label, query = "", children }: { label: string; query?: string; children: ReactNode }) {
  const search = useRef<HTMLInputElement>(null);
  return (
    <div className="min-w-0 rounded-2xl bg-popover p-1 text-popover-foreground ring-1 ring-border">
      <PickerFrame label={label} search={search} query={query} onQuery={noop} onSearchKey={noop}>{children}</PickerFrame>
    </div>
  );
}

export function PickerGallery() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Frame label="Go to file"><FileList id="preview-files" files={files} active={1} query="" onActive={noop} onPick={noop} /></Frame>
      <Frame label="Go to symbol" query="route"><SymbolList id="preview-symbols" rows={symbols} active={0} onActive={noop} onPick={noop} /></Frame>
      {["Indexing files…", "Searching symbols…", "No matching files", "Files could not load"].map((note) => (
        <Frame key={note} label="Search files"><PickerNote>{note}</PickerNote></Frame>
      ))}
    </div>
  );
}
