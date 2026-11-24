import { useEffect, useState } from "react";
import type { FilesPlaces } from "@shared/contract-work-files";
import type { FilePlace } from "@shared/work/files";
import { registry } from "../../lib/connection";

/**
 * Whether a workspace's host makes Microsoft forms, and the places it makes them in (docs/agents/work-msforms.md
 * "Making a form"): small and free of the canvas, so a page that only offers a verb (a meeting's follow-up survey,
 * our form's Make this a Microsoft form) loads nothing more.
 */

const offeredBy = new Map<string, Promise<boolean>>();
const offeredOf = (env: string, workspaceId: string): Promise<boolean> => {
  const key = `${env}\n${workspaceId}`;
  let got = offeredBy.get(key);
  if (!got) {
    got = registry
      .linkOf(env)
      .request<{ offered: boolean }>("work.msforms.list", { workspaceId })
      .then(
        (r) => r.offered,
        () => false,
      );
    offeredBy.set(key, got);
  }
  return got;
};

/** Forgets the host's word, for a test that asks again. */
export const forgetOffered = (): void => offeredBy.clear();

/** A Microsoft form takes a carrier pass on the box browser: the press waits this long for it. */
export const MAKE_MS = 240_000;

/** Whether the workspace's host makes Microsoft forms, asked once a window. */
export function useMsformsOffered(env: string, workspaceId: string | null): boolean {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    let on = true;
    void offeredOf(env, workspaceId).then((yes) => on && setOffered(yes));
    return () => {
      on = false;
    };
  }, [env, workspaceId]);
  return offered;
}

/** The Teams and OneDrive places a Microsoft form may be made in, read when `want` turns on; null while they are read. */
export function useLibraryPlaces(env: string, workspaceId: string, want: boolean): FilePlace[] | null {
  const [places, setPlaces] = useState<FilePlace[] | null>(null);
  useEffect(() => {
    if (!want) return;
    let on = true;
    void registry
      .linkOf(env)
      .request<FilesPlaces>("work.files.places", { workspaceId })
      .then(
        (r) => on && setPlaces(r.places.filter((p) => (p.kind === "teams" || p.kind === "onedrive") && p.root.at === "file")),
        () => on && setPlaces([]),
      );
    return () => {
      on = false;
    };
  }, [env, workspaceId, want]);
  return places;
}
