// bun run ui:preview src/renderer/src/chrome/WhatsNewDialog.preview.tsx#BundledNotes --shot --fresh
// Exports BundledNotes, FeedNotes and NoNotes. The harness parses the real markdown on its main thread.
// Static dialogs show the open state without scrolling controls or dismissal.
import { WhatsNewDialog } from "./WhatsNewDialog";
import { presentReleaseNotes } from "../lib/releaseNotesParse";
import { version } from "../../../../package.json";

const noop = () => {};
const feed = "## 9.1.0\n\n### Files\n\nThe file viewer remembers your place when you switch tabs.";

export function BundledNotes() {
  const current = presentReleaseNotes(version) ? version : "1.0.303";
  return <WhatsNewDialog version={current} onClose={noop} />;
}
export function FeedNotes() { return <WhatsNewDialog version="9.1.0" markdown={feed} onClose={noop} />; }
export function NoNotes() { return <WhatsNewDialog version="9.1.1" onClose={noop} />; }
