// bun run ui:preview src/renderer/src/surfaces/FilePane.fixtures.tsx#FilePaneStates --shot --fresh
// Export FilePaneStates. The renderer's code skeleton and Retry come from the editor;
// the static preview cannot reopen the file.
import { EditorLoading, EditorOpenError } from "./FileEditor";

export function FilePaneStates() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="h-64 border border-border"><EditorLoading name="routes.ts" /></div>
      <div className="h-64 border border-border"><EditorOpenError name="routes.ts" line="The box did not answer." onRetry={() => {}} /></div>
    </div>
  );
}
