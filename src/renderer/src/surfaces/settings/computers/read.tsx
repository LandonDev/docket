import { useEffect, useState, type ReactNode } from "react";
import { PageError, PageRowsSkeleton, type SkeletonRow } from "../../../components/page";
import { BusyLabel, Button } from "../../../components/ui/button";
import { useHostRead, type HostRead } from "../../../lib/connection/hostRead";
import type { Host } from "../parts/hostRpc";

/** How often a computer's page asks again while it shows, so a phone signing in or a thread starting shows unasked. */
export const POLL_MS = 5_000;

/**
 * One read of one computer for one section (a section reads on its own, so one read a key may not make never fails
 * the page): asked over that computer's own link, again every `POLL_MS` while `poll` is set.
 */
export function useComputerRead<T>(host: Host, method: string, { params, poll = false, skip = false }: { params?: unknown; poll?: boolean; skip?: boolean } = {}): HostRead<T> {
  const link = skip ? undefined : host.link;
  const read = useHostRead<T>(link, () => host.request<T>(method, params ?? {}), `${host.environmentId}:${method}`);
  const { retry } = read;
  useEffect(() => {
    if (!poll || !link) return;
    const timer = window.setInterval(() => void retry(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, link, retry]);
  return read;
}

/** A section's body while its read is out (the rows' shape) or once it failed with nothing to show (the red line and
 *  Retry, which spins until the answer); its rows once the computer answered. */
export function SectionRead<T>({ read, rows, children }: { read: HostRead<T>; rows: number | readonly SkeletonRow[]; children: (value: T) => ReactNode }) {
  const [retrying, setRetrying] = useState(false);
  if (read.value !== undefined) return <>{children(read.value)}</>;
  if (!read.error) return <PageRowsSkeleton rows={rows} />;
  return (
    <PageError
      action={
        <Button
          variant="ghost"
          size="sm"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void read.retry().finally(() => setRetrying(false));
          }}
        >
          <BusyLabel busy={retrying} label="Retry" />
        </Button>
      }
    >
      {read.error}
    </PageError>
  );
}
