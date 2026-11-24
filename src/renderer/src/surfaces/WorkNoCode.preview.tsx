// A preview frame for `bun run ui:preview src/renderer/src/surfaces/WorkNoCode.preview.tsx#WorkNoCodePreview`:
// a Work thread and a code thread in the same place (a project with a folder in a git repo, before the first
// message): the composer with its draft row, and the right panel's sections as `sectionsFor` lists them.
import { Composer } from "../chrome/Composer";
import { composerFixtureBase } from "../chrome/Composer.fixtures";
import { sectionsFor } from "../lib/rightPanel";
import { PanelHeaderPreview } from "./RightPanel.preview";

const noop = () => {};

export function WorkNoCodePreview({ work }: { work: boolean }) {
  // Only a Work thread has Results; the rest of the state is the same for both.
  const { sections, defaultSection } = sectionsFor({
    root: true,
    notes: true,
    project: true,
    checkout: true,
    agents: 0,
    activity: 0,
    computer: false,
    computerLive: false,
    results: work ? 2 : 0,
    debug: false,
    work,
  });
  return (
    <div className="flex items-start gap-6" style={{ width: 840 }}>
      <div className="min-w-0 flex-1">
        <Composer {...composerFixtureBase} sessionId={work ? "wnc-work" : "wnc-code"} threadType="chat" onThreadTypeChange={noop} work={work} />
      </div>
      <PanelHeaderPreview width={300} sections={sections} value={defaultSection ?? sections[0]} />
    </div>
  );
}
