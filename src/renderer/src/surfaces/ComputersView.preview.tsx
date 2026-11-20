// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/ComputersView.preview.tsx#ComputersStates`:
// every fixture of the Computers page's body at its width, on the page's own
// fill. Rendered by nothing in the app.
import { ComputersPage } from "./ComputersView";
import fixtures from "./ComputersView.fixtures";

export function ComputersStates({ only }: { only?: number[] }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="flex min-h-64 flex-col border border-border bg-background" style={{ width: fixture.width }}>
            <ComputersPage {...fixture.props} />
          </div>
        </figure>
      ))}
    </div>
  );
}
