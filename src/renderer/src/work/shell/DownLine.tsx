import { useState, type ComponentProps } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { lifeosHostName, reopenLifeos, type LifeosSession } from "./lifeos";
import { downOf, downWords, useDownPress } from "./lifeosDown";
import { useDownAction } from "./DownSignIn";

/**
 * A LifeOS session that is down, said once in a part's place (a held act's details, a chat card): its state in the
 * shared words (`downWords`, the computer named), with the one press `downPress` gives. Retry asks the host for the
 * session again (`reopenLifeos`), never a remount that reads the same dead session; Sign in and Show the code open the
 * sign-in dialog in place where this window may sign that host in; Open Settings (Settings → Work) for Work off where it
 * may turn it on; else who can. A computer kept from LifeOS has none. Draws nothing while the session reads or is on its way. A Retry that is not answered either leaves the line as it is: it says so already.
 */
export function DownLine({
  session,
  className,
  ...props
}: Omit<ComponentProps<"p">, "children"> & { session: Pick<LifeosSession, "environmentId" | "sector" | "client" | "state" | "withheld" | "unanswered"> }) {
  const [busy, setBusy] = useState(false);
  const down = downOf(session);
  const { press, elsewhere } = useDownPress(down, session.environmentId);
  const retry = (): void => {
    setBusy(true);
    void reopenLifeos(session.environmentId, session.sector)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const { action, dialog } = useDownAction(press, session.environmentId, retry);
  if (!down) return null;
  return (
    <>
      <p data-session-down={down} className={cn("flex min-h-7 min-w-0 items-center gap-2 text-[13px] text-muted-foreground", className)} {...props}>
        {/* A long computer name wraps beside the press, never cut. */}
        <span className="min-w-0 text-pretty">
          {downWords(down, lifeosHostName(session.environmentId))}
          {elsewhere ? <span className="block">{elsewhere}</span> : null}
        </span>
        {action ? (
          <Button variant="ghost" size="xs" className="shrink-0" disabled={busy} onClick={action.run}>
            <BusyLabel busy={busy} label={action.label} />
          </Button>
        ) : null}
      </p>
      {dialog}
    </>
  );
}
