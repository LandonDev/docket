import { ReadFailure } from "./ReadFailure";

/** The words that mark a held set whose refresh failed: its values are the last answer, not the current one. */
export const AS_LAST_READ = "As last read";

/**
 * A failed refresh over a held set (New threads, a place's set, Reviews): the failure (said at the page's or the
 * dialog's head, with Retry), and one muted line over the rows saying they are the last answer. The page holds the set
 * meanwhile: no change until a fresh read answers.
 */
export function LastRead({ environmentId, stale }: { environmentId: string; stale: { error: string; retry: () => void } }) {
  return (
    <>
      <ReadFailure computer={environmentId} error={stale.error} retry={stale.retry} />
      <p data-last-read="" className="pb-1 text-xs text-muted-foreground">
        {AS_LAST_READ}.
      </p>
    </>
  );
}
