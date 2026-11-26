// bun run ui:preview src/renderer/src/surfaces/RightPanel.preview.tsx#PanelPreview --shot --fresh
// Exports PanelPreview and PanelHeaderPreview. Static shots show the selected pill at rest;
// resize gestures and the panel or tab's motion need a live page.
import { PanelHeader, RightPanelFrame } from "./RightPanel";
import { ChangesView } from "../chrome/rail/ChangesPanel";
import { changesPreviewCases } from "../chrome/rail/ChangesPanel.fixtures";
import { FilesPreview } from "../chrome/FileTree.fixtures";
import { useSashKeys } from "../hooks/useSashKeys";
import type { Section } from "../lib/rightPanel";

const noop = () => {};
const sections: Section[] = ["agents", "activity", "computer", "changes", "notes", "files", "build", "debug"];

export function PanelHeaderPreview({ width, sections, value }: { width: number; sections: Section[]; value: Section }) {
  return (
    <div className="flex flex-col" style={{ width }}>
      <div className="h-10 border-b border-border" />
      <div className="flex h-40 flex-col border-l border-border bg-sidebar">
        <PanelHeader sections={sections} value={value} onChange={noop} onClose={noop} width={width} />
      </div>
    </div>
  );
}

function PanelCase({ width, section, state }: { width: number; section: "changes" | "files"; state: number }) {
  const sashKeys = useSashKeys({ label: "Resize panel", orientation: "vertical", value: width, min: 260, max: 640, getSpan: () => width, direction: -1, onChange: noop, onReset: noop });
  return (
    <div className="flex h-[420px] w-max max-w-full justify-end ps-2">
      <RightPanelFrame width={width} sections={sections} section={section} sashKeys={sashKeys} onChange={noop} onClose={noop}>
        {section === "files" ? <FilesPreview /> : <ChangesView {...changesPreviewCases[state].props} />}
      </RightPanelFrame>
    </div>
  );
}

export function PanelPreview() {
  return (
    <div className="flex flex-col gap-4">
      {changesPreviewCases.map(({ name }, state) => (
        <section key={name}>
          <h2 className="mb-2 text-xs text-muted-foreground">{name}</h2>
          <PanelCase width={[260, 320, 480, 320][state] ?? 320} section="changes" state={state} />
        </section>
      ))}
      <section>
        <h2 className="mb-2 text-xs text-muted-foreground">Files</h2>
        <PanelCase width={320} section="files" state={0} />
      </section>
    </div>
  );
}
