import { useState, type ComponentProps } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { lifeosHostName, reopenLifeos, type LifeosSession } from "./lifeos";
import { downOf, downPress, downWords } from "./lifeosDown";
import { openConnections } from "./open";

/**
 * A LifeOS session that is down, said once in a part's place (a held act's details, a chat card): its state in the
 * shared words (`downWords`, the computer named), with the one press `downPress` gives. Retry asks the host for the
 * session again (`reopenLifeos`), never a remount that reads the same dead session; Sign in opens Settings →
 * Connections; a computer kept from LifeOS, a sign-in that waits and Work off have none. Draws nothing while the
 * session reads or is on its way. A Retry that is not answered either leaves the line as it is: it says so already.
 */
export function DownLine({
  session,
  className,
  ...props
}: Omit<ComponentProps<"p">, "children"> & { session: Pick<LifeosSession, "environmentId" | "sector" | "client" | "state" | "withheld" | "unanswered"> }) {
  const [busy, setBusy] = useState(false);
  const down = downOf(session);
  if (!down) return null;
  const press = downPress(down);
  const retry = (): void => {
    setBusy(true);
    void reopenLifeos(session.environmentId, session.sector)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <p data-session-down={down} className={cn("flex min-h-7 min-w-0 items-center gap-2 text-[13px] text-muted-foreground", className)} {...props}>
      {/* A long computer name wraps beside the press, never cut. */}
      <span className="min-w-0 text-pretty">{downWords(down, lifeosHostName(session.environmentId))}</span>
      {press === "retry" ? (
        <Button variant="ghost" size="xs" className="shrink-0" disabled={busy} onClick={retry}>
          <BusyLabel busy={busy} label="Retry" />
        </Button>
      ) : press === "sign-in" ? (
        <Button variant="ghost" size="xs" className="shrink-0" onClick={openConnections}>
          Sign in
        </Button>
      ) : null}
    </p>
  );
}
