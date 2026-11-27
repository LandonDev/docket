import { useShell } from "../stores/shell";
import { SurfaceSkeleton } from "./SurfaceSkeleton";

/** The Accounts and Stats pages' one chunk, waited on in the shape of the
 *  page asked for: Accounts' rows, or Stats' sections over their charts' bones. */
export function AliaxPagesFallback() {
  const page = useShell((state) => state.accountsPage);
  return page === "stats" ? <SurfaceSkeleton kind="stats" label="Loading stats" /> : <SurfaceSkeleton kind="accounts" label="Loading accounts" />;
}
