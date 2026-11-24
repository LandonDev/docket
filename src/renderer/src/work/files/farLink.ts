import { FILES_ACROSS } from "@shared/contract-work-files";
import { registry } from "../../lib/connection";
import type { Link, LinkRequestOptions } from "../../lib/connection/link";

/**
 * A desktop the window has no link to (a PC that links only to the box), asked through the workspace's own host
 * (`work.files.across`): that host asks the desktop over its host link. Only the listing crosses; anything else
 * asked of such a desktop is refused here, and a file there opens as a copy on the workspace's host.
 */

type FilesLink = Pick<Link, "request" | "onPush" | "onOpen">;

const through = new Map<string, { via: string; workspaceId: string }>();
const ACROSS: ReadonlySet<string> = new Set(FILES_ACROSS);

/** A far desktop's name as the host in between last said it, so a line about it names it while it is away. */
const names = new Map<string, string>();
export const farName = (link: string): string | undefined => names.get(link);
export const keepFarName = (link: string, name: string | undefined): void => void (name && names.set(link, name));

/** The window reaches `link` only through `via`, the host of the workspace being shown. */
export const reachThrough = (link: string, via: string, workspaceId: string): void => void through.set(link, { via, workspaceId });


/** The link Files asks a host through: the window's own, or the workspace's host for a desktop it cannot reach. */
export function filesLink(link: string): FilesLink {
  const far = registry.has(link) ? undefined : through.get(link);
  if (!far) return registry.linkOf(link);
  const via = registry.linkOf(far.via);
  return {
    request<T>(method: string, params?: unknown, options?: LinkRequestOptions): Promise<T> {
      if (!ACROSS.has(method)) return Promise.reject(new Error("That computer is reached through another host: open the file to see it."));
      const { workspaceId = far.workspaceId, ...rest } = (params ?? {}) as { workspaceId?: string };
      return via.request<T>("work.files.across", { workspaceId, host: link, method, params: rest }, options);
    },
    // The host in between carries no pushes from it: its places are asked again with the workspace's own.
    onPush: () => () => {},
    onOpen: (listener) => via.onOpen(listener),
  };
}
