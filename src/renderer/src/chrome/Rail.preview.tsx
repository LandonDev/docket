// bun run ui:preview src/renderer/src/chrome/Rail.preview.tsx#RailShipped
// bun run ui:preview src/renderer/src/chrome/Rail.preview.tsx#RailHostAway
// These pages mount ProjectRail. Resize, drag and popup positioning need interaction.
import { useEffect, useState, type ReactNode } from "react";
import { addPreviewHost, previewCwd, previewNoop, previewNow, previewProject, previewSession, previewWorkspace } from "../lib/previewHost.preview";
import { savePinnedProjects } from "../lib/recents";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { sessionStore } from "../lib/tcserver/store";
import { webApi } from "../lib/nativeWeb";
import { registry, type EnvironmentStatus } from "../lib/connection";
import { CardNowContext } from "./WorkspaceSessions";
import { ProjectRail } from "./ProjectRail";
import { customizeChunk, dialogsChunk, menuChunk, virtualChunk, workspaceThreadsChunk } from "../surfaces/chunks";

await Promise.all([menuChunk.load(), customizeChunk.load(), dialogsChunk.load(), workspaceThreadsChunk.load(), virtualChunk.load()]);

export function sizePreviewSidebar(root: HTMLDivElement | null) {
  const scroller = root?.querySelector<HTMLElement>("aside.sidebar-glass > .overflow-y-auto");
  if (!scroller) return;
  // The virtual list reads a viewport size on mount. jsdom has no layout.
  Object.defineProperties(scroller, {
    offsetWidth: { value: 260 },
    offsetHeight: { value: 360 },
  });
}

export const archiveProject = { ...previewProject, id: "old-import", name: "Old import", archived: true, branch: "old-import" };
const design = { ...previewWorkspace, id: "design", linkId: null, name: "Design Kit", path: "/projects/design-kit" };
const studio = { ...previewWorkspace, id: "studio", linkId: null, name: "Studio Tools", path: "/projects/studio-tools" };
const workshop = { ...previewWorkspace, id: "workshop", linkId: null, name: "Workshop notes", path: "/projects/workshop-notes" };
const threads = [
  previewSession({ id: "preview-cache", title: "Speed up the notes list", status: "running", busySince: previewNow - 120_000 }),
  previewSession({ id: "preview-empty", title: "Pick wording for empty folders", status: "waiting" }),
  previewSession({ id: "preview-chat", title: "Review the release notes", projectId: null, cwd: "~", status: "waiting" }),
  previewSession({ id: "preview-import", title: "Add notes from a CSV file", projectId: archiveProject.id }),
];

export async function seedRailPreview({ away = false, archived = false, home = "populated" }: { away?: boolean; archived?: boolean; home?: "populated" | "empty" } = {}) {
  window.api = { ...webApi, platform: "linux" };
  const shown = threads.filter((session) => (home === "populated" || session.id !== "preview-chat") && (archived || session.projectId !== archiveProject.id));
  const recents = [{ path: previewCwd, openedAt: previewNow }, { path: design.path, openedAt: previewNow - 60_000 }];
  const local = await addPreviewHost({
    id: "local", name: "This computer",
    answers: { "workspace.list": () => [previewWorkspace, design], "project.list": () => archived ? [previewProject, archiveProject] : [previewProject] },
  });
  const other = await addPreviewHost({
    id: "studio", name: "Studio",
    refused: away, answers: { "workspace.list": () => [studio], "project.list": () => [] },
  });
  workspaceStore.attach(local);
  workspaceStore.attach(other);
  await workspaceStore.refresh(local);
  if (away) {
    // The catalog can remember a workspace whose host no longer takes its key.
    workspaceStore.detach("studio");
    let push: Parameters<Parameters<typeof workspaceStore.attach>[0]["onPush"]>[0] | undefined;
    workspaceStore.attach({
      environmentId: "studio", connected: false, profile: "remote",
      request: async () => { throw new Error("Studio is unavailable"); },
      onPush: (listener) => { push = listener; return previewNoop; },
      onOpen: () => previewNoop,
      onClose: () => previewNoop,
    });
    push?.({ push: "workspaces", workspaces: [studio] });
  } else {
    await workspaceStore.refresh(other);
  }
  if (away) {
    const reconnecting = await addPreviewHost({ id: "workshop", name: "Workshop", answers: {
      "workspace.list": () => [workshop], "project.list": () => [],
    } });
    workspaceStore.attach(reconnecting);
    await workspaceStore.refresh(reconnecting);
    // The status snapshot represents a retry in flight, without opening a new socket.
    const status = registry as unknown as { setStatus(id: string, value: EnvironmentStatus): void };
    status.setStatus("workshop", { ...registry.statusOf("workshop"), transport: "reconnecting", nextRetryAt: null });
  }
  shown.forEach((session) => sessionStore.adopt(session, { created: true }));
  savePinnedProjects([previewCwd]);
  return {
    recents: [
      ...recents,
      { path: studio.path, openedAt: previewNow - 120_000 },
      ...(away ? [{ path: workshop.path, openedAt: previewNow - 180_000 }] : []),
    ],
    release: () => {
      workspaceStore.detach("local");
      workspaceStore.detach("studio");
      workspaceStore.detach("workshop");
      registry.remove("local");
      registry.remove("studio");
      registry.remove("workshop");
      sessionStore.reset();
    },
  };
}

export function RailPreviewData({ away, archived, home, children }: {
  away?: boolean;
  archived?: boolean;
  home?: "populated" | "empty";
  children: (fixture: Awaited<ReturnType<typeof seedRailPreview>>) => ReactNode;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof seedRailPreview>>>();
  useEffect(() => {
    let live = true;
    let release: (() => void) | undefined;
    void seedRailPreview({ away, archived, home }).then((seed) => {
      if (!live) return seed.release();
      release = seed.release;
      setData(seed);
    });
    return () => { live = false; release?.(); };
  }, [away, archived, home]);
  return <CardNowContext.Provider value={previewNow}>{data ? children(data) : null}</CardNowContext.Provider>;
}

export function RailShipped({ away = false }: { away?: boolean }) {
  return (
    <RailPreviewData away={away}>
      {({ recents }) => (
        <div className="flex h-[800px]">
          <ProjectRail
            cwd={previewCwd} recents={recents} activeSessionId="preview-cache"
            onSelectProject={previewNoop} onOpenProject={previewNoop} onRemoveProject={previewNoop}
            onSearch={previewNoop} onOpenInbox={previewNoop} onOpenNotes={previewNoop}
            onOpenChats={previewNoop} onOpenAccountsPage={previewNoop} onSelectAgent={previewNoop}
          />
        </div>
      )}
    </RailPreviewData>
  );
}

export function RailHostAway() {
  return <RailShipped away />;
}
