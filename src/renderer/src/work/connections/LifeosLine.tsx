import { useState, type ReactNode } from "react";
import { PageEmpty, PageError } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry, useEnvironmentStatus } from "../../lib/connection";
import { openConnections, openWorkSettings } from "../shell/open";
import { useDownPress } from "../shell/lifeosDown";
import { lifeosHostName, refreshLifeos, reopenLifeos, sessionFailure, useLifeosStatus, useLifeosUnanswered, type LifeosSession } from "../shell/lifeos";

/**
 * A settings section that needs LifeOS while it has no session (docs/DESIGN.md "One name a thing"): the bones while
 * the host's status or the session's first JWT is on its way, else one line that says the state the host answered,
 * in the view frame's words (`sessionFailure`), with the press that can help at its end. "Not signed in to LifeOS"
 * and Sign in, which opens Settings → Connections, only for a host that says it is signed out or its sign-in was
 * refused; "LifeOS did not answer" in red with Retry; a host never heard from with its name and Retry; a host whose
 * link is open but whose status ask went unanswered, "<host> did not answer" in red with Retry; a sign-in
 * that waits and a computer the host keeps LifeOS from with no press, since none here can help; Work off with Open
 * Settings (Settings → Work, the switch) where this window may turn it on, else who can.
 * The line in `PageError`'s shape, so the 28px press overhangs the 16px line evenly.
 */
export function LifeosLine({ session, waiting }: { session: Pick<LifeosSession, "environmentId" | "sector" | "state" | "withheld">; waiting: ReactNode }) {
  const { environmentId, sector } = session;
  const status = useLifeosStatus(environmentId);
  const link = useEnvironmentStatus(environmentId);
  const unanswered = useLifeosUnanswered(environmentId);
  const [busy, setBusy] = useState(false);
  const state = status?.lifeos.state ?? null;
  const away = state === null && link.transport !== "open" && link.transport !== "connecting" && link.transport !== "reconnecting";
  const name = registry.environment(environmentId)?.name ?? "This host";
  const host = name.charAt(0).toUpperCase() + name.slice(1);
  // The computer named mid-line as the views name it ("Work is off on the box"), "this host" for one the registry does not know.
  const named = lifeosHostName(environmentId);
  // Work off: Open Settings, where the switch is, for a key that may turn it on; else who can (`useDownPress`).
  const off = useDownPress("off", environmentId);
  // A Retry that is not answered either leaves the line as it is: it says so already.
  const retryWith = (ask: () => Promise<void>) => (): void => {
    setBusy(true);
    void ask()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  if (away) return <Line words={`${host} is not connected`} press={{ label: "Retry", onClick: () => registry.retry(environmentId) }} />;
  // The link is open but the status ask went unanswered: nothing asks again until the link reopens, so no bones.
  if (state === null && unanswered) return <Failed words={`${host} did not answer`} busy={busy} onRetry={retryWith(() => refreshLifeos(environmentId))} />;
  if (state === "off") return <Line words={sessionFailure("off", false, named)} note={off.elsewhere} press={off.press ? { label: "Open Settings", onClick: openWorkSettings } : undefined} />;
  if (session.withheld) return <Line words={sessionFailure(session.state, true, named)} />;
  // The session's own state counts too: its JWT can be refused or go unanswered while the host says connected.
  const signedOut = [state, session.state].find((s) => s === "signed-out" || s === "refused");
  if (signedOut) return <Line words={sessionFailure(signedOut, false, named)} press={{ label: "Sign in", onClick: openConnections }} />;
  if (state === "pairing") return <Line words={sessionFailure("pairing")} />;
  if (state === "unreachable" || session.state === "unreachable")
    return <Failed words={sessionFailure("unreachable")} busy={busy} onRetry={retryWith(() => reopenLifeos(environmentId, sector))} />;
  return waiting;
}

function Failed({ words, busy, onRetry }: { words: string; busy: boolean; onRetry: () => void }) {
  return (
    <PageError
      action={
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry}>
          <BusyLabel busy={busy} label="Retry" />
        </Button>
      }
    >
      {words}
    </PageError>
  );
}

function Line({ words, note, press }: { words: string; note?: string | null; press?: { label: string; onClick: () => void } | undefined }) {
  return (
    <div data-slot="lifeos-line" className="flex items-start gap-3 py-3">
      <PageEmpty className="min-w-0 flex-1 py-0">
        {words}
        {note ? <span className="block">{note}</span> : null}
      </PageEmpty>
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
