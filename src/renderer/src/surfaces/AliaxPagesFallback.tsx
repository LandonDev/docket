import { useShell } from "../stores/shell";
import { SurfaceSkeleton } from "./SurfaceSkeleton";

/** The Accounts and Stats pages' one chunk, waited on in the shape of the
 *  page asked for: Accounts' rows, or Stats' 672px column. */
export function AliaxPagesFallback() {
  const page = useShell((state) => state.accountsPage);
  return page === "stats" ? <SurfaceSkeleton kind="column" label="Loading stats" /> : <SurfaceSkeleton kind="accounts" label="Loading accounts" />;
}
