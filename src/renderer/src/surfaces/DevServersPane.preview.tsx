// bun run ui:preview src/renderer/src/surfaces/DevServersPane.preview.tsx#LiveDevServers
// LiveDevServers draws two real server rows and the picked console. Stop and port forwarding need interaction.
import { useLayoutEffect, useRef, useState } from "react";
import type { DevRun, DevTarget } from "@server/shared/contract-devservers";
import { devPane } from "../lib/devPane";
import { applyDevRunPush } from "../lib/devServers";
import { addPreviewHost, previewCwd, previewNoop, previewNow, previewProject, previewSession, previewWorkspace } from "../lib/previewHost.preview";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { project } from "../stores/project";
import { DevServersPane } from "./DevServersPane";

const run = (id: string, port: number, sessionId: string, what: string): DevRun => ({
  id, projectId: previewProject.id, targetId: id, name: "Field Notes", script: "dev", kind: "web", command: "bun run dev", what,
  sessionId, cwd: previewCwd, status: "running", pid: 42, startedAt: previewNow, endedAt: null, exitCode: null,
  ports: [{ port, url: "http://localhost:" + port, forwards: [] }],
});
const runs = [run("notes-ui", 5173, "notes-screen", "Vite dev server"), run("notes-api", 3020, "notes-api", "Notes API")];
const target: DevTarget = {
  id: "notes-ui", name: "Field Notes", script: "dev", kind: "web", framework: "vite",
  dir: ".", command: "bun run dev", macOnly: false, what: "Vite dev server",
};
const lines = ["Starting the notes app", "The dev server is ready", "Ready for local requests"];
const host = await addPreviewHost({ id: "local", name: "This computer", answers: {
  "workspace.list": () => [previewWorkspace],
  "project.list": () => [previewProject],
  "devServer.log": (params) => ({ run: runs.find((entry) => entry.id === (params as { runId: string }).runId), lines, end: lines.length }),
  "devServer.targets": () => ({ targets: [target], runs }),
} });
workspaceStore.attach(host);
await workspaceStore.refresh(host);
const threads = [
  previewSession({ id: "notes-screen", title: "Refresh the notes list" }),
  previewSession({ id: "notes-api", title: "Add the export endpoint" }),
];
for (const thread of threads) sessionStore.adopt(thread, { created: true });
sessionStore.mutate(threads.map((thread) => sessionStore.get(thread.id)!));
project.setProjectCwd(previewCwd);
for (const item of runs) applyDevRunPush("local", { push: "dev-run", projectId: previewProject.id, run: item, lines });
devPane.pick("local/notes-api");

export function LiveDevServers() {
  const frame = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const owner = frame.current;
    const proto = window.HTMLElement.prototype;
    const width = Object.getOwnPropertyDescriptor(proto, "offsetWidth")!;
    const height = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
    const isMeasure = (el: HTMLElement) => owner?.contains(el) && el.classList.contains("xterm-char-measure-element");
    // The real terminal asks for its font metrics before it can lay out log rows.
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) { return isMeasure(this) ? this.textContent!.length * 8 : width.get?.call(this); },
    });
    Object.defineProperty(proto, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) { return isMeasure(this) ? 15 : height.get?.call(this); },
    });
    setReady(true);
    return () => { Object.defineProperties(proto, { offsetWidth: width, offsetHeight: height }); };
  }, []);
  return (
    <div ref={frame} data-dev-server-preview className="flex h-[390px] min-w-0 flex-col justify-end">
      <style>{`
        [data-dev-server-preview] .xterm .xterm-rows { color: var(--foreground); }
        [data-dev-server-preview] .xterm .xterm-rows .xterm-dim { color: var(--muted-foreground); opacity: 1; }
      `}</style>
      {ready ? <DevServersPane onSizePaint={previewNoop} onSizeCommit={previewNoop} onShowTerminal={previewNoop} /> : null}
    </div>
  );
}
