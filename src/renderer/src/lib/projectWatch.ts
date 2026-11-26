import { registry } from "./connection";
import { dirPrefix, projectForCwd } from "./tcserver/projects";
import { workspaceStore } from "./tcserver/workspaces";

/**
 * The renderer end of the server's tree watcher (`fs.watch`): one
 * reference-counted subscription per project, re-sent when the socket
 * reconnects, fanned out to open models and the Files tree as absolute
 * paths. The last holder's release lingers `LINGER_MS` before the
 * unsubscribe, so a switch A, B, A (the rail's git hold moving with the
 * selected row) keeps A's one subscription. No monaco import, so
 * subscribing never pulls the editor chunk.
 */

export interface FileEvent {
  projectId: string;
  /** absolute path */
  path: string;
  /** project-relative path as the server sent it */
  relative: string;
  kind: "changed" | "created" | "deleted";
}

export const LINGER_MS = 30_000;

const refs = new Map<string, number>();
/** Projects no one holds, still subscribed until their timer ends. */
const lingering = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(e: FileEvent) => void>();

function send(projectId: string, subscribe: boolean): void {
  const environmentId = workspaceStore.project(projectId)?.environmentId;
  const link = environmentId ? registry.link(environmentId) : undefined;
  if (!link?.connected) return;
  void link.request("fs.watch", { projectId, subscribe }).catch(() => undefined);
}

/** Hold the project's watch open; call the result to let go. */
export function watchProject(projectId: string): () => void {
  const n = refs.get(projectId) ?? 0;
  refs.set(projectId, n + 1);
  const linger = lingering.get(projectId);
  if (linger !== undefined) {
    clearTimeout(linger);
    lingering.delete(projectId);
  } else if (n === 0) send(projectId, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = refs.get(projectId) ?? 0;
    if (cur <= 1) {
      refs.delete(projectId);
      lingering.set(
        projectId,
        setTimeout(() => {
          lingering.delete(projectId);
          send(projectId, false);
        }, LINGER_MS),
      );
    } else {
      refs.set(projectId, cur - 1);
    }
  };
}

/** Like watchProject, resolving the project once the workspace list is in. */
export function watchCwd(cwd: string): () => void {
  let release: (() => void) | null = null;
  let done = false;
  const project = projectForCwd(cwd);
  if (project) {
    release = watchProject(project.id);
  } else {
    const unsub = workspaceStore.subscribe(() => {
      const p = projectForCwd(cwd);
      if (!p && !workspaceStore.getSnapshot().loaded) return;
      unsub();
      if (p && !done) release = watchProject(p.id);
    });
    if (done) unsub();
  }
  return () => {
    done = true;
    release?.();
    release = null;
  };
}

export function onFileEvent(listener: (e: FileEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchFileEvent(e: FileEvent): void {
  for (const l of listeners) l(e);
}

/** Test hook. */
export function watchedProjectIds(): string[] {
  return [...refs.keys()];
}

registry.onLink((link, event) => {
  if (event !== "added") return;
  link.onOpen(() => {
    // Subscriptions live on the connection: a fresh socket knows none.
    for (const projectId of new Set([...refs.keys(), ...lingering.keys()])) {
      if (workspaceStore.project(projectId)?.environmentId === link.environmentId) send(projectId, true);
    }
  });
  link.onPush((push) => {
    if (push.push !== "file-event") return;
    const project = workspaceStore.project(push.projectId);
    if (!project || project.environmentId !== link.environmentId) return;
    dispatchFileEvent({
      projectId: push.projectId,
      path: `${dirPrefix(project.cwd)}${push.path}`,
      relative: push.path,
      kind: push.kind,
    });
  });
});
