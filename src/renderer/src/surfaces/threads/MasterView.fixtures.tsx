// bun run ui:preview src/renderer/src/surfaces/threads/MasterView.tsx#BoardFailed --shot --fresh
// Export BoardFailed. Use master/board.preview.tsx#MasterPreview for the board and chat.
// Static shots hold the fallback and do not run Retry.
import { SurfaceSkeleton } from "../SurfaceSkeleton";

/** BoardFailed: the master's chat (a still transcript skeleton stands in) under the line and Retry. */
export default [
  {
    name: "the board failed",
    props: { renderChat: () => <div className="min-h-0 flex-1"><SurfaceSkeleton kind="transcript" label="Loading thread" /></div>, onRetry: () => {} },
  },
];
