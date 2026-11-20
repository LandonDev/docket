// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/LiveFullView.preview.tsx#FullViewStates`:
// every fixture of the full view on the dialog's scrim, in the room the
// lightbox gives it. Rendered by nothing in the app.
import { FullView } from "./LiveFullView";
import fixtures from "./LiveFullView.fixtures";

export function FullViewStates({ only }: { only?: number[] }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="flex items-center justify-center bg-scrim" style={{ width: fixture.props.room.width, height: fixture.props.room.height }}>
            <FullView {...fixture.props} />
          </div>
        </figure>
      ))}
    </div>
  );
}
