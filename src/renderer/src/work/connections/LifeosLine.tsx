import { useState, type ReactNode } from "react";
import { PageEmpty, PageError } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry, useEnvironmentStatus } from "../../lib/connection";
import { openConnections } from "../shell/open";
import { reopenLifeos, sessionFailure, useLifeosStatus, type LifeosSession } from "../shell/lifeos";

/**
 * A settings section that needs LifeOS while it has no session (docs/DESIGN.md "One name a thing"): the bones while
 * the host's status or the session's first JWT is on its way, else one line that says the state the host answered,
 * in the view frame's words (`sessionFailure`), with the press that can help at its end. "Not signed in to LifeOS"
 * and Sign in, which opens Settings → Connections, only for a host that says it is signed out or its sign-in was
 * refused; "LifeOS did not answer" in red with Retry; a host never heard from with its name and Retry; a sign-in
 * that waits, a computer the host keeps LifeOS from, and Work off with no press, since none here can help.
 * The line in `PageError`'s shape, so the 28px press overhangs the 16px line evenly.
 */
export function LifeosLine({ session, waiting }: { session: Pick<LifeosSession, "environmentId" | "sector" | "state" | "withheld">; waiting: ReactNode }) {
  const { environmentId, sector } = session;
  const status = useLifeosStatus(environmentId);
  const link = useEnvironmentStatus(environmentId);
  const [busy, setBusy] = useState(false);
  const state = status?.lifeos.state ?? null;
  const away = state === null && link.transport !== "open" && link.transport !== "connecting" && link.transport !== "reconnecting";
  if (away) {
    const host = registry.environment(environmentId)?.name ?? "This host";
    return <Line words={`${host} is not connected`} press={{ label: "Retry", onClick: () => registry.retry(environmentId) }} />;
  }
  if (state === "off") return <Line words={sessionFailure("off")} />;
  if (session.withheld) return <Line words={sessionFailure(session.state, true)} />;
  // The session's own state counts too: its JWT can be refused or go unanswered while the host says connected.
  const signedOut = [state, session.state].find((s) => s === "signed-out" || s === "refused");
  if (signedOut) return <Line words={sessionFailure(signedOut)} press={{ label: "Sign in", onClick: openConnections }} />;
  if (state === "pairing") return <Line words={sessionFailure("pairing")} />;
  if (state === "unreachable" || session.state === "unreachable") {
    const retry = (): void => {
      setBusy(true);
      // A Retry that is not answered either leaves the line as it is: it says so already.
      void reopenLifeos(environmentId, sector)
        .catch(() => {})
        .finally(() => setBusy(false));
    };
    return (
      <PageError
        action={
          <Button variant="ghost" size="sm" disabled={busy} onClick={retry}>
            <BusyLabel busy={busy} label="Retry" />
          </Button>
        }
      >
        {sessionFailure("unreachable")}
      </PageError>
    );
  }
  return waiting;
}

function Line({ words, press }: { words: string; press?: { label: string; onClick: () => void } }) {
  return (
    <div data-slot="lifeos-line" className="flex items-start gap-3 py-3">
      <PageEmpty className="min-w-0 flex-1 py-0">{words}</PageEmpty>
      {press ? (
        <span className="-my-1.5 flex shrink-0">
          <Button variant="ghost" size="sm" onClick={press.onClick}>
            {press.label}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
