import { useEffect, type ReactNode } from "react";
import { PageRowsSkeleton, PageSection, type SkeletonRow } from "../../../components/page";
import { ReadFailure } from "../parts/ReadFailure";
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

/** A section's body while its read is out (the rows' shape) or once it failed with nothing to show (the red line,
 *  naming the computer, and Retry); its rows once the computer answered. */
export function SectionRead<T>({
  read,
  rows,
  computer,
  children,
}: {
  read: HostRead<T>;
  rows: number | readonly SkeletonRow[];
  /** The environment id of the computer the read went to: the failure names it. */
  computer: string;
  children: (value: T) => ReactNode;
}) {
  if (read.value !== undefined) return <>{children(read.value)}</>;
  if (!read.error) return <PageRowsSkeleton rows={rows} />;
  return <ReadFailure computer={computer} error={read.error} retry={read.retry} />;
}

/**
 * A page about one computer, held by one read of it (round 2, rule 2): while the read is out the sections stand in
 * their own shapes; when it fails the page says once that the computer did not answer, with one Retry, and draws no
 * section under it (no heading, no bones); once it answers the sections read for themselves.
 */
export function ComputerGate({ host, probe = "admission.get", children }: { host: Host; probe?: string; children: ReactNode }) {
  const read = useComputerRead<unknown>(host, probe);
  if (read.value === undefined && read.error)
    return (
      <PageSection data-computer-silent="">
        <ReadFailure computer={host.environmentId} error={read.error} retry={read.retry} />
      </PageSection>
    );
  return <>{children}</>;
}
