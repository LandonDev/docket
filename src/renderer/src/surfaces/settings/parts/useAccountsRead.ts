import { useMemo } from "react";
import { emptyAccounts, wholeSnapshot, type AccountsSnapshot } from "@server/shared/accounts";
import { registry } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { useAccounts } from "../../../stores/accounts";

/**
 * A computer's AI accounts as a Settings page reads them: undefined while the first answer is out, then the true
 * snapshot, or the read's error with Retry. The accounts store starts from an empty snapshot that only an answer
 * replaces, so a page that took it as is would say "Auto, no other account" before anything was asked; this asks
 * `accounts.list` itself until the store has an answer, and follows the store's pushes once it has.
 */
export function useAccountsRead(environmentId: string): { snapshot: AccountsSnapshot | undefined; error: string | null; retry: () => void } {
  const store = useAccounts(environmentId);
  // One link per computer for the read, asked once: the read follows the link it was given.
  const link = useMemo(() => (environmentId ? registry.linkOf(environmentId) : null), [environmentId]);
  const read = useHostRead(store.loaded ? null : link, () => link!.request<AccountsSnapshot>("accounts.list"), environmentId);
  if (store.loaded) return { snapshot: store.snapshot, error: null, retry: read.retry };
  // An answer with nothing in it is a computer with no accounts: the empty set, said as one.
  if (read.value !== undefined) return { snapshot: read.value ? wholeSnapshot(read.value) : emptyAccounts(), error: null, retry: read.retry };
  return { snapshot: undefined, error: read.error, retry: read.retry };
}
