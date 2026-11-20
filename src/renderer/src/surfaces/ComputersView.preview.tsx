// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/ComputersView.preview.tsx#ComputersStates`:
// every fixture of the Computers page's body at its width, on the page's own
// fill. Rendered by nothing in the app.
import { ComputersHeader, ComputersPage } from "./ComputersView";
import fixtures from "./ComputersView.fixtures";

export function ComputersStates({ only }: { only?: number[] }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="flex flex-col border border-border bg-background" style={{ width: fixture.width, height: fixture.height }}>
            <ComputersPage {...fixture.props} size={{ width: fixture.width, height: fixture.height }} />
          </div>
        </figure>
      ))}
    </div>
  );
}

// `#ComputersHeaders`: the page's header with nothing to offer, while the Windows VM sleeps, and while it wakes.
export function ComputersHeaders() {
  const none = async (): Promise<void> => undefined;
  const states = [
    { name: "Nothing asleep", vm: null },
    { name: "The Windows VM sleeps", vm: { host: "box", waking: false } },
    { name: "Waking", vm: { host: "box", waking: true } },
  ];
  return (
    <div className="flex flex-col gap-8 p-4">
      {states.map((state) => (
        <figure key={state.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{state.name}</figcaption>
          <div className="flex flex-col border border-border bg-background" style={{ width: 720 }}>
            <ComputersHeader besideRail onClose={() => undefined} onToggleSidebar={() => undefined} vm={state.vm} onWake={none} />
          </div>
        </figure>
      ))}
    </div>
  );
}
