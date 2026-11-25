import type { Session } from "../session";
import type { WorkspaceCatalog } from "./workspaces";

/**
 * The host a draft's create goes to. A draft in a project or a workspace goes
 * to the host the catalog names for it, never the one it was minted for: a
 * draft made before a host's lists arrived (first paint, a return record, a
 * kept draft) took the window's own host, and its create there answered
 * "unknown workspace". A draft in neither goes where it was minted.
 */

type Draft = Pick<Session, "environmentId" | "projectId" | "workspaceId">;
type Catalog = Pick<WorkspaceCatalog, "workspaces" | "projects">;
type CatalogSource = { getSnapshot(): Catalog; subscribe(listener: () => void): () => void };

/** How long a send waits for the catalog to name its draft's host before it refuses. */
export const DRAFT_HOST_WAIT_MS = 15_000;

export const DRAFT_HOST_UNKNOWN = "This thread's host is not connected yet. Try again in a moment.";

/** The draft's host by the catalog; null while the catalog does not know its project or workspace. */
export function draftHostOf(draft: Draft, catalog: Catalog): string | null {
  if (draft.projectId) return catalog.projects.find((p) => p.id === draft.projectId)?.environmentId ?? null;
  if (draft.workspaceId) return catalog.workspaces.find((w) => w.id === draft.workspaceId)?.environmentId ?? null;
  return draft.environmentId;
}

/** The draft's host, waiting up to `waitMs` for the catalog to name it; past that, a plain refusal. */
export function draftHost(draft: Draft, source: CatalogSource, waitMs = DRAFT_HOST_WAIT_MS): Promise<string> {
  const now = draftHostOf(draft, source.getSnapshot());
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const off = source.subscribe(() => {
      const host = draftHostOf(draft, source.getSnapshot());
      if (!host) return;
      clearTimeout(timer);
      off();
      resolve(host);
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(DRAFT_HOST_UNKNOWN));
    }, waitMs);
  });
}
