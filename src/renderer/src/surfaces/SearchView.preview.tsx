// bun run ui:preview src/renderer/src/surfaces/SearchView.preview.tsx#SearchPreview
// SearchPreview draws the real grouped hits and host foot. Cancellation and navigation need interaction.
import { addPreviewHost, previewCwd, previewNoop, previewNow, previewProject, previewSession, previewWorkspace } from "../lib/previewHost.preview";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { SearchView } from "./SearchView";

const files = ["cache.ts", "cache.test.ts", "cache-notes.md"].map((name) => ({ name, relative: "src/" + name, path: previewCwd + "/src/" + name }));
const thread = previewSession({ id: "preview-cache-search", title: "Keep the notes cache warm" });
const hits = [12, 32, 58].map((line) => ({
  path: files[0].path, relative: files[0].relative, line, column: 12, preview: "return cache.get(folder);",
}));
const note = { id: "cache-note", title: "Cache refresh notes", snippet: "Keep the current page through a cache refresh.", updatedAt: previewNow, sourceCwd: previewCwd };
let loading = false;
const never = new Promise<never>(() => {});
const box = await addPreviewHost({ id: "local", name: "This computer", answers: {
  "workspace.list": () => [previewWorkspace],
  "project.list": () => [previewProject],
  "fs.projectFiles": () => files,
  "session.search": () => loading ? never : { hits: [], truncated: false },
  "search.project": (params) => loading ? never : {
    matches: (params as { options: { query: string } }).options.query === "cache" ? hits : [], truncated: false,
  },
  "notes.search": (params) => loading ? never : { hits: (params as { query: string }).query === "cache" ? [note] : [] },
} });
await addPreviewHost({ id: "studio", name: "Studio", answers: { "session.search": () => ({ hits: [] }), "notes.search": () => ({ hits: [] }) } });
const unavailable = () => { throw new Error("Could not reach the search index"); };
await addPreviewHost({ id: "workshop", name: "Workshop", answers: { "session.search": unavailable, "notes.search": unavailable } });
workspaceStore.attach(box);
await workspaceStore.refresh(box);
sessionStore.adopt(thread, { created: true });
sessionStore.adopt(previewSession({ id: "preview-other-search", environmentId: "studio", title: "Cache migration notes" }), { created: true });
const session = sessionStore.get(thread.id)!;
sessionStore.mutate((sessions) => [...sessions.filter((entry) => entry.id !== thread.id), {
  ...session, blocks: [
    { id: "search-u", seq: 1, role: "user", text: "Make the cache hold the previous page." },
    { id: "search-a", seq: 2, role: "assistant", text: "The cache now keeps the previous page until the next request returns." },
    { id: "search-a2", seq: 3, role: "assistant", text: "The cache tests cover a slow request and an offline host." },
  ],
}]);

export function SearchPreview({ query, pending = false }: { query?: string; pending?: boolean }) {
  loading = pending;
  return (
    <div className="flex h-[610px]">
      <SearchView
        open cwd={previewCwd} initialQuery={query} recents={[]} onClose={previewNoop}
        onOpenFile={previewNoop} onOpenSession={previewNoop} onOpenProject={previewNoop} onOpenNote={previewNoop}
      />
    </div>
  );
}
