import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { ChunkBoundary } from "../../../lib/lazyChunk";
import { tagRendererError } from "../../../lib/rendererErrors";
import { tallyRender } from "../../../lib/devRenders";

/**
 * One board row's error boundary (the ChunkBoundary pattern, lib/lazyChunk.tsx):
 * a row whose record throws while rendering paints as a still 48px row
 * holding the house's one red line, "Couldn't load Inbox swipe" (the
 * thread it was, read only once it failed), with Retry, and the rows
 * beside it, the board, the rail and the master's transcript stay up.
 * Retry mounts the row afresh, so it reads the store again. The error
 * reaches stalls.log's `[renderer] caught <name>: <message>` line tagged
 * with the master thread and the row's session id (lib/rendererErrors.ts).
 */
export function RowBoundary({ threadId, rowId, titleOf, children }: { threadId: string; rowId: string; titleOf?: () => string | null | undefined; children: ReactNode }) {
  tallyRender("rowBoundary");
  return (
    <ChunkBoundary
      name={`board-row.${rowId}`}
      fallback={null}
      onRetry={() => {}}
      onError={(error) => tagRendererError(error, { thread: threadId, row: rowId })}
      failed={(retry) => (
        <div role="alert" data-chunk-failed={`board-row.${rowId}`} className="flex h-12 items-center gap-2 px-2">
          <span className="min-w-0 flex-1 truncate text-xs text-destructive">Couldn't load {titleOf?.()?.trim() || "this thread"}</span>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
    >
      {children}
    </ChunkBoundary>
  );
}
