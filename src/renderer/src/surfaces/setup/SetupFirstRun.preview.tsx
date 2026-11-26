// bun run ui:preview src/renderer/src/surfaces/setup/SetupFirstRun.preview.tsx#FirstRun --shot --fresh
// Export FirstRun. The real first-use dialog is open over the rail and home draft.
// The static page cannot pair a computer.
import { ProjectRail } from "../../chrome/ProjectRail";
import { Composer } from "../../chrome/Composer";
import { UseSetupLinkDialog } from "./UseSetupLink";

const noop = () => {};
export function FirstRun() {
  return (
    <div data-preview-stage className="relative flex h-[640px] min-w-0 bg-background">
      <div className="w-40 shrink-0 bg-sidebar sm:w-52">
        <ProjectRail cwd="~" recents={[]} onSelectProject={noop} onOpenProject={noop} onOpenChats={noop} onOpenNotes={noop} onOpenAccountsPage={noop} />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center px-4">
        <div className="w-full max-w-xl">
          <Composer focused={false} harness="claude" model="claude-opus-5-5" runtimeMode="supervised" cwd="~" executionCwd="~" sessionId="first-run-draft" recents={[]} onFocus={noop} onCwdChange={noop} onModelChange={noop} onRuntimeModeChange={noop} onSubmit={noop} />
        </div>
      </div>
      <UseSetupLinkDialog first onClose={noop} />
    </div>
  );
}
