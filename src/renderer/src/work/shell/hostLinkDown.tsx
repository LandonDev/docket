import { useState, useSyncExternalStore } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { linkWords, type Degraded } from "../../lib/connection/degraded";
import { IDLE_STATUS, type EnvironmentStatus } from "../../lib/connection/types";
import { registry } from "../../lib/connection/registry";
import { retryLink } from "./linkRetry";

/** A first connection can still be loading. A lost link holds the host's presses until it opens again. */
export function linkIsDown(status: EnvironmentStatus): boolean {
  return status !== IDLE_STATUS && status.transport !== "open" && (status.transport !== "connecting" || !!status.lastHello || status.attempts > 0);
}

/** A link that is not open (`linkIsDown`, a host that is off) in the link's one wording, `linkWords`: "The box is offline", "Reconnecting to the box…". */
export const linkDownWords = (name: string, status: EnvironmentStatus): string => linkWords(name, { kind: status.transport as Degraded["kind"], status });

const subscribe = (listener: () => void) => registry.subscribe(listener);

export function useHostLinkDown(environmentId?: string | null): string | null {
  return useSyncExternalStore(subscribe, () =>
    environmentId && linkIsDown(registry.statusOf(environmentId))
      ? linkDownWords(registry.environment(environmentId)?.name ?? "This computer", registry.statusOf(environmentId))
      : null,
  );
}

export function HostLinkLine({ word, retryHost }: { word: string; retryHost?: string }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div data-work-link-down role="status" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5 text-muted-foreground">
      <span className="min-w-0 flex-1">{word}</span>
      {retryHost ? (
        <Button variant="ghost" size="xs" disabled={retrying} onClick={() => {
          setRetrying(true);
          void retryLink(retryHost).finally(() => setRetrying(false));
        }}>
          <BusyLabel busy={retrying} label="Retry" />
        </Button>
      ) : null}
    </div>
  );
}
