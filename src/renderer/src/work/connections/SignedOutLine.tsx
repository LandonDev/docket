import { PageEmpty } from "../../components/page";
import { Button } from "../../components/ui/button";
import { openConnections } from "../shell/open";

/**
 * A settings section that needs LifeOS while it is signed out (docs/DESIGN.md "One name a thing"): one muted line,
 * "Not signed in to LifeOS", and Sign in at its end, which opens Settings → Connections, where each host signs in.
 * The line in `PageError`'s shape, so the 28px press overhangs the 16px line evenly.
 */
export function SignedOutLine() {
  return (
    <div data-slot="signed-out-line" className="flex items-start gap-3 py-3">
      <PageEmpty className="min-w-0 flex-1 py-0">Not signed in to LifeOS</PageEmpty>
      <span className="-my-1.5 flex shrink-0">
        <Button variant="ghost" size="sm" onClick={openConnections}>
          Sign in
        </Button>
      </span>
    </div>
  );
}
