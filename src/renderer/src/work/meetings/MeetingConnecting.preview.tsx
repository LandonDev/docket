// A preview page of one state alone, for `bun run ui:preview src/renderer/src/work/meetings/MeetingConnecting.preview.tsx#MeetingConnectingPreview`:
// a recording's tasks while the box's LifeOS is still connecting (council round 11). Alone, since it sets the host's
// status, which MeetingCanvas.preview.tsx's other fixtures would hear.
import { MeetingPreview } from "./MeetingCanvas.preview";

export function MeetingConnectingPreview() {
  return <MeetingPreview moment="tasks-connecting" />;
}
