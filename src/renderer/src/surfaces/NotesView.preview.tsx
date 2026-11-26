// bun run ui:preview src/renderer/src/surfaces/NotesView.preview.tsx#NotesPreview
// NotesPreview draws the real list and detail. Editing, navigation and resize need interaction.
import { addPreviewHost, previewNoop, previewNow, previewCwd } from "../lib/previewHost.preview";
import type { Note } from "../lib/notes";
import { NotesView } from "./NotesView";

const notes: Note[] = [
  { id: "cache", slug: "cache-refresh", title: "Cache refresh", body: "Keep the last page visible while the next one loads.\n\nCheck the offline case before shipping.", sourceCwd: previewCwd, createdAt: previewNow, updatedAt: previewNow },
  { id: "release", slug: "release-checklist", title: "Release checklist", body: "Open the notes list on both computers.", createdAt: previewNow, updatedAt: previewNow },
];
let shown: "loading" | "populated" | "empty" = "populated";
await addPreviewHost({ id: "local", name: "This computer", answers: {
  "notes.list": () => shown === "loading" ? new Promise(() => {}) : shown === "empty" ? [] : notes,
} });

export function NotesPreview({ state = "populated" }: { state?: typeof shown }) {
  shown = state;
  return <div className="flex h-[480px]"><NotesView cwd={previewCwd} onClose={previewNoop} /></div>;
}
