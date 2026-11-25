// A preview page for `bun run ui:preview src/renderer/src/work/today/TodayConnecting.preview.tsx#TodayConnectingPreview --shot`:
// Today alone while the box says its LifeOS is connecting: one named wait where the sections that read LifeOS stood, no
// press, the other sections kept (TodayView.preview.tsx's fixtures draw every state in one page). Rendered by nothing in the app.
import { TodayPreview } from "./TodayView.preview";

export function TodayConnectingPreview() {
  return <TodayPreview state="connecting" />;
}
