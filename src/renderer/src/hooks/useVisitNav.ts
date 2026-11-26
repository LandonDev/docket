import { canTabVisitBack, canTabVisitForward } from "../lib/tabVisitHistory";
import { threadsCovered, useShell } from "../stores/shell";
import { useWorkspaceTabs } from "../stores/workspace";

/** Whether Back and Forward have somewhere to go: Back leaves an overlay (a page or Settings) before it walks tab history. */
export function useVisitNav(): { canGoBack: boolean; canGoForward: boolean } {
  const canVisitBack = useWorkspaceTabs((s) => canTabVisitBack(s.visits));
  const canGoForward = useWorkspaceTabs((s) => canTabVisitForward(s.visits));
  const covered = useShell(threadsCovered);
  return { canGoBack: canVisitBack || covered, canGoForward };
}
