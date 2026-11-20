import { useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";

/**
 * A view's own state line, in the shape of the frame's (docs/DESIGN.md "The state line"): one line
 * across the view under its header, 32px, a failed glyph, the word in its tone, a muted detail, one
 * Retry, a hairline under it. It stays at the top while the list scrolls. A view draws it only for a
 * fault the frame's line is not already saying: never a second banner.
 */
export function ViewStateLine({ word, detail, onRetry }: { word: string; detail?: string; onRetry: () => void | Promise<void> }) {
  const [running, setRunning] = useState(false);
  return (
    <div data-view-state="failed" role="status" className="sticky top-0 z-10 flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      <StatusMark state="failed" word={word} detail={detail} className="min-w-0 flex-1" />
      <Button
        variant="ghost"
        size="xs"
        disabled={running}
        onClick={() => {
          setRunning(true);
          void Promise.resolve(onRetry()).finally(() => setRunning(false));
        }}
      >
        <BusyLabel busy={running} label="Retry" />
      </Button>
    </div>
  );
}
