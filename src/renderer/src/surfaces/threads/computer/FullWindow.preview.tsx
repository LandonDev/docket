// A preview page for `bun run ui:preview
// src/renderer/src/surfaces/threads/computer/FullWindow.preview.tsx#FullWindowStates`:
// every fixture of the full window at its window's size, on its own ground.
// Rendered by nothing in the app.
import { FullWindowView } from "./FullWindow";
import fixtures from "./FullWindow.fixtures";

export function FullWindowStates({ only }: { only?: number[] }) {
  const shown = only ? only.map((i) => fixtures[i]).filter(Boolean) : fixtures;
  return (
    <div className="flex flex-col gap-8 p-4">
      {shown.map((fixture) => (
        <figure key={fixture.name} className="m-0 flex flex-col gap-2">
          <figcaption className="text-xs text-muted-foreground">{fixture.name}</figcaption>
          <div className="bg-stage" style={{ width: fixture.props.room.width, height: fixture.props.room.height }}>
            <FullWindowView {...fixture.props} />
          </div>
        </figure>
      ))}
    </div>
  );
}
